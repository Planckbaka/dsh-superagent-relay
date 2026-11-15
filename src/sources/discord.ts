/** Native Discord Source: policy-gated intake and resumable delivery through the shared Outbox. */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, type OutboundMessage, type Trigger } from '../core/index.ts'
import { family } from '../kv.ts'
import { AllowedSchema } from '../policy.ts'
import { chunks } from '../discord-chat.ts'
import type { SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

const snowflake = z.string().regex(/^\d{16,22}$/)
export const DiscordCredentialsSchema = z.object({ channel: snowflake, owner: snowflake,
  tokenFile: z.string().startsWith('/') }).strict()
/** Load only private configuration metadata; sanitize parser and filesystem errors. */
export function discordCredentials(file: string): z.infer<typeof DiscordCredentialsSchema> {
  try { return DiscordCredentialsSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) }
  catch { throw new Error('Invalid Discord private configuration') }
}
const Config = z.object({ configFile: z.string().refine(value => !value || value.startsWith('/')).default(''),
  pollSeconds: z.number().int().min(1).max(300).default(3) }).strict()
type Config = z.infer<typeof Config>
export const DiscordMessageSchema = z.object({ id: snowflake, channel_id: snowflake, content: z.string(),
  timestamp: z.string().optional(), author: z.object({ id: snowflake, bot: z.boolean().optional() }),
  webhook_id: z.string().optional(), mentions: z.array(z.object({ id: snowflake })).default([]),
  message_reference: z.object({ message_id: snowflake.optional() }).optional() })
export type DiscordMessage = z.infer<typeof DiscordMessageSchema>
interface Cursor { after: string; bot: string; owner: string; guild?: string }
interface ReplyBinding { root: string; ticket?: string; touched?: number }
interface Delivery { next: number; fingerprint: string; receipt?: string; touched?: number }
const cooldownKey = family<number>('discord:cooldown:')
const cursorKey = family<Cursor>('discord:cursor:')
const bindingKey = family<ReplyBinding, [string, string]>('discord:binding:')
const deliveryKey = family<Delivery>('discord:delivery:')

/** Sanitized transport error; response bodies and credentials never enter logs or model context. */
export class DiscordHttpError extends Error {
  constructor(readonly status: number, readonly retryMs = 1000) { super(`Discord HTTP ${status}`) }
}

/** Immutable, source-native event. Each initial request owns a distinct conversation within a channel. */
export function discordTrigger(message: DiscordMessage, bot: string, root = message.id, guild?: string): Trigger {
  const thread = `${message.channel_id}:${root}`
  return { id: `discord:${message.id}`, source: 'discord', threads: [{ source: 'discord', id: thread }],
    actor: { source: 'discord', id: message.author.id }, human: !message.author.bot && !message.webhook_id,
    ...(message.mentions.some(user => user.id === bot) ? { addressed: 'mention' as const } : {}),
    at: message.timestamp ?? new Date(Number((BigInt(message.id) >> 22n) + 1420070400000n)).toISOString(),
    text: message.content.replace(new RegExp(`^<@!?${bot}>\\s*`), '').trim(),
    channel: { source: 'discord', thread, address: { channel: message.channel_id, root, message: message.id, ...(guild ? { guild } : {}) } },
    url: `https://discord.com/channels/${guild ?? '@me'}/${message.channel_id}/${message.id}`,
    meta: { channel: message.channel_id, root, message: message.id,
      ...(message.message_reference?.message_id ? { reply: message.message_reference.message_id } : {}) } }
}

/** Owns Discord API access; Engine intake, policy decisions and receipts remain in the native domain. */
export class DiscordSource {
  readonly kind: SourceKind<Config>
  private authenticated?: { fingerprint: string; bot: string }
  private get ctx(): SourceContext { return this.context() }
  constructor(private readonly context: () => SourceContext, private readonly signal: AbortSignal,
    private readonly options: { fetch?: typeof fetch; paused?: () => boolean } = {}) {
    this.kind = {
      kind: 'discord', title: { zh: 'Discord', en: 'Discord' },
      description: { zh: '独立身份、策略评估和可靠回复的 Discord 对话来源。', en: 'Discord conversations with native policy and persistent delivery.' },
      schema: Config, fields: [
        { key: 'configFile', type: 'text', label: { zh: '私有配置文件', en: 'Private configuration file' } },
        { key: 'pollSeconds', type: 'number', min: 1, max: 300, advanced: true, label: { zh: '轮询间隔 / 秒', en: 'Poll seconds' } },
      ], health: ['discord'],
      policy: { schema: z.object({ allowed: z.array(AllowedSchema).default([]) }).strict(),
        fields: [{ key: 'allowed', type: 'rows', label: { zh: '可发起任务的用户', en: 'Allowed users' },
          columns: [{ key: 'id', type: 'text', pattern: '\\d{16,22}', label: { zh: '用户 ID', en: 'User ID' } },
            { key: 'name', type: 'text', optional: true, label: { zh: '名称', en: 'Name' } }] }],
        explicit: { zh: '提及机器人，或回复本工单消息。', en: 'Mention the bot or reply within the ticket conversation.' } },
      scope: ({ meta }, config) => config.configFile && meta.channel === this.credentials(config).channel
        ? { listened: true, observed: false } : { listened: false, reason: 'discord_channel_not_allowed' },
      threadContext: {
        messageId: trigger => String(trigger.meta.message),
        read: async (_commands, trigger, part, cursor) => {
          const credentials = this.credentials()
          if (trigger.meta.channel !== credentials.channel) throw new Error('Discord context outside configured channel')
          const root = snowflake.parse(trigger.meta.root)
          const raw = part === 'root' || part === 'parent'
            ? [DiscordMessageSchema.parse(await this.request(`/channels/${credentials.channel}/messages/${root}`))]
            : z.array(DiscordMessageSchema).parse(await this.request(`/channels/${credentials.channel}/messages?limit=100${cursor ? `&before=${snowflake.parse(cursor)}` : ''}`))
          const messages = raw.filter(message => message.id === root ||
            this.ctx.state.get(bindingKey(credentials.channel, message.id))?.root === root ||
            (message.message_reference?.message_id && this.ctx.state.get(bindingKey(credentials.channel, message.message_reference.message_id))?.root === root))
            .map(message => ({ id: message.id, from: message.author.id,
              at: message.timestamp ?? discordTrigger(message, '').at, text: message.content,
              ...(message.author.bot || message.webhook_id ? { bot: true as const } : {}),
              ...(message.message_reference?.message_id ? { reply_to: message.message_reference.message_id } : {}) }))
          const oldest = raw.reduce<string | undefined>((value, message) => !value || BigInt(message.id) < BigInt(value) ? message.id : value, undefined)
          return { messages, ...(part === 'thread' && raw.length === 100 && oldest ? { next: oldest } : {}), body: { channel: credentials.channel, root } }
        },
      },
      repliesTo: trigger => typeof trigger.meta.reply === 'string' ? `discord:${trigger.meta.reply}` : undefined,
      channel: {
        allowed: (address, config) => !!config.configFile && address.channel === this.credentials(config).channel,
        send: async (_host, message) => this.send(message),
        link: address => ({ url: `https://discord.com/channels/${address.guild ?? '@me'}/${address.channel}/${address.message ?? address.root}`,
          label: { zh: 'Discord 对话', en: 'Discord conversation' } }),
      },
    }
  }
  private credentials(config = this.ctx.config<Config>('discord')) {
    if (!config?.configFile) throw new Error('Discord source is not configured')
    return discordCredentials(config.configFile)
  }
  private async request(path: string, body?: unknown): Promise<unknown> {
    const channel = this.credentials().channel
    const until = this.ctx.state.get(cooldownKey(channel)) ?? 0
    if (until > Date.now()) throw new DiscordHttpError(429, until - Date.now())
    let token: string
    try { token = readFileSync(this.credentials().tokenFile, 'utf8').trim() }
    catch { throw new Error('Cannot read Discord credential') }
    if (!/^[A-Za-z0-9_.-]+$/.test(token)) throw new Error('Invalid Discord credential')
    const response = await (this.options.fetch ?? fetch)(`https://discord.com/api/v10${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(15000)]),
    })
    if (!response.ok) {
      let retryMs = Math.min(300_000, Math.max(1000, (Number(response.headers.get('retry-after')) || 1) * 1000))
      if (response.status === 429) {
        const body = await response.json().catch(() => ({})) as { retry_after?: unknown }
        if (typeof body.retry_after === 'number' && Number.isFinite(body.retry_after)) retryMs = Math.min(300_000, Math.max(retryMs, body.retry_after * 1000))
        this.ctx.state.set(cooldownKey(channel), Date.now() + retryMs)
      }
      throw new DiscordHttpError(response.status, retryMs)
    }
    return response.json()
  }
  /** Verify credential rotations against the persisted bot identity before intake or sending. */
  private async authenticate(): Promise<string> {
    const credentials = this.credentials()
    let fingerprint: string
    try { fingerprint = createHash('sha256').update(readFileSync(credentials.tokenFile)).digest('hex') }
    catch { throw new Error('Cannot read Discord credential') }
    if (this.authenticated?.fingerprint !== fingerprint) {
      const bot = z.object({ id: snowflake, bot: z.literal(true) }).parse(await this.request('/users/@me')).id
      this.authenticated = { fingerprint, bot }
    }
    const saved = this.ctx.state.get(cursorKey(credentials.channel))
    if (saved && (saved.bot !== this.authenticated.bot || saved.owner !== credentials.owner)) {
      throw new Error('Discord identity changed; use a separate source state')
    }
    return this.authenticated.bot
  }
  /** One intake batch; the cursor advances only after durable intake or an explicit ignored event. */
  async poll(): Promise<number> {
    if (!this.ctx.config<Config>('discord')?.configFile) return 0
    const credentials = this.credentials()
    const bot = await this.authenticate()
    let cursor = this.ctx.state.get(cursorKey(credentials.channel))
    if (!cursor) {
      const destination = z.object({ guild_id: snowflake.optional() }).parse(await this.request(`/channels/${credentials.channel}`))
      const latest = z.array(DiscordMessageSchema).parse(await this.request(`/channels/${credentials.channel}/messages?limit=1`))[0]
      cursor = { bot, owner: credentials.owner, ...(destination.guild_id ? { guild: destination.guild_id } : {}),
        after: latest?.id ?? (BigInt(Date.now() - 1420070400000) << 22n).toString() }
      this.ctx.state.set(cursorKey(credentials.channel), cursor)
    }
    if (cursor.owner !== credentials.owner) throw new Error('Discord owner changed; use a separate source state')
    const messages = z.array(DiscordMessageSchema).parse(await this.request(`/channels/${credentials.channel}/messages?limit=100&after=${cursor.after}`))
    messages.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1)
    for (const message of messages) {
      if (this.signal.aborted) break
      if (BigInt(message.id) <= BigInt(cursor.after)) continue
      const reference = message.message_reference?.message_id
      const binding = reference ? this.ctx.state.get(bindingKey(credentials.channel, reference)) : undefined
      const addressed = message.mentions.some(user => user.id === cursor!.bot)
      if (message.channel_id === credentials.channel && message.author.id !== cursor.bot && !message.webhook_id && (addressed || binding)) {
        const trigger = discordTrigger(message, cursor.bot, binding?.root, cursor.guild)
        const control = /^\/(help|status|stop)$/.exec(trigger.text)?.[1]
        // Control operations have their own strict human owner boundary, independent of discussion membership.
        if (control === 'stop' && !binding && message.author.id === credentials.owner && trigger.human) {
          this.ctx.notify({ id: key('discord-stop-target', trigger.id), channel: trigger.channel!, kind: 'notice',
            text: '请回复要停止的任务消息，再发送 /stop。' })
        } else if (control && control !== 'stop' && message.author.id === credentials.owner && trigger.human) {
          this.control(control, trigger, binding)
        } else if (trigger.text && trigger.text.length <= 8000) {
          if (control === 'stop') trigger.text = '停止这个任务。Stop this ticket.'
          await this.ctx.receive(trigger)
          this.ctx.state.set(bindingKey(credentials.channel, message.id), { root: binding?.root ?? message.id, touched: Date.now() })
        } else if (trigger.human && message.author.id === credentials.owner) {
          this.ctx.notify({ id: key('discord-invalid-input', trigger.id), channel: trigger.channel!, kind: 'notice',
            text: trigger.text.length > 8000 ? '任务文本上限为 8000 字符，请缩短后重试。'
              : '无法读取消息正文。请检查 Discord 应用的 Message Content 设置后重新发送。' })
        }
      }
      // A receive exception leaves this event and subsequent events available for the next poll.
      cursor = { ...cursor, after: message.id }
      this.ctx.state.set(cursorKey(credentials.channel), cursor)
    }
    if (!this.signal.aborted) this.compact()
    return messages.length
  }
  /** Reclaim transport indexes only after settled delivery or ended conversations have aged out (30 days). */
  compact(): void {
    const cutoff = Date.now() - 30 * 24 * 3600_000
    for (const name of this.ctx.state.keys(deliveryKey)) {
      const progress = this.ctx.state.get(name)
      if (progress?.touched && progress.touched < cutoff && progress.receipt &&
          ['sent', 'dropped'].includes(this.ctx.replyStatus?.(progress.receipt) ?? '')) this.ctx.state.set(name, undefined)
    }
    const channel = this.credentials().channel
    for (const name of this.ctx.state.keys(bindingKey)) {
      if (!name.startsWith(`discord:binding:${channel}:`)) continue
      const link = this.ctx.state.get(name)
      if (!link?.touched || link.touched >= cutoff) continue
      const thread = this.ctx.threads.get(`discord:${channel}:${link.root}`)
      if (thread?.pending.length || thread?.evaluating) continue
      const tickets = link.ticket ? [link.ticket] : thread?.subscriptions ?? []
      if (tickets.every(id => !!this.ctx.tickets.get(id)?.ended)) this.ctx.state.set(name, undefined)
    }
  }
  private control(command: string, trigger: Trigger, binding?: ReplyBinding): void {
    const thread = trigger.threads[0]!
    const tickets = this.ctx.threads.get(`discord:${thread.id}`)?.subscriptions ?? []
    const ticket = binding?.ticket ? this.ctx.tickets.get(binding.ticket) : tickets.map(id => this.ctx.tickets.get(id)).find(Boolean)
    const text = command === 'help'
      ? '提及机器人发起任务，回复任务消息继续对话。/status 查询所回复的任务。停止任务请回复“停止这个任务”。权限以当前部署和工单授权为准。'
      : ticket ? `任务 ${ticket.id}：${ticket.ended?.outcome ?? ticket.assignments.at(-1)?.report?.state ?? 'running'}\n${ticket.attention?.question ?? ticket.assignments.at(-1)?.report?.summary ?? '正在处理。'}` : '请回复某个任务的消息以查询状态。'
    this.ctx.notify({ id: key('discord-control', trigger.id), channel: trigger.channel!, text, kind: 'notice', ...(ticket ? { ticketId: ticket.id } : {}) })
  }
  /** Shared Outbox invokes this; chunk checkpoints and reply bindings commit together after each successful send. */
  async send(message: OutboundMessage): Promise<'sent' | 'gone'> {
    if (this.options.paused?.()) throw new Error('Discord delivery paused')
    const config = this.credentials()
    if (message.channel.address.channel !== config.channel) return 'gone'
    const identity = `${config.channel}:${message.id}`
    const fingerprint = createHash('sha256').update(message.text).digest('hex')
    const progress = this.ctx.state.get(deliveryKey(identity)) ?? { next: 0, fingerprint }
    if (progress.fingerprint !== fingerprint) throw new Error('Discord delivery content changed')
    const parts = chunks(message.text)
    for (let index = progress.next; index < parts.length; index++) {
      this.signal.throwIfAborted()
      if (this.options.paused?.()) throw new Error('Discord delivery paused')
      await this.authenticate()
      const nonce = createHash('sha256').update(`${identity}:${index}`).digest('hex').slice(0, 24)
      // Missing access may also appear as 404; every HTTP failure keeps the receipt available for repair.
      const result = z.object({ id: snowflake }).parse(await this.request(`/channels/${config.channel}/messages`, {
        content: parts[index], nonce, enforce_nonce: true, allowed_mentions: { parse: [], replied_user: false },
        message_reference: { message_id: message.channel.address.message ?? message.channel.address.root, fail_if_not_exists: false },
      }))
      this.ctx.atomic(() => {
        this.ctx.state.set(bindingKey(config.channel, result.id), {
          root: message.channel.address.root!, touched: Date.now(), ...(message.ticketId ? { ticket: message.ticketId } : {}),
        })
        this.ctx.state.set(deliveryKey(identity), { fingerprint, next: index + 1, receipt: message.id, touched: Date.now() })
      })
    }
    return 'sent'
  }
  /** Polling restarts after recoverable HTTP/intake errors; delivery retries are owned exclusively by Effects. */
  async watch(): Promise<void> {
    let failures = 0
    while (!this.signal.aborted) {
      const config = this.ctx.config<Config>('discord')
      let wait = (config?.pollSeconds ?? 3) * 1000
      try {
        if (config?.configFile) {
          const count = await this.poll()
          failures = 0
          this.ctx.report('discord', { state: 'ready', detail: 'Discord native source active', at: new Date().toISOString() })
          if (count === 100) wait = 0
        } else this.ctx.report('discord', { state: 'paused', detail: 'Discord source is disabled or unconfigured' })
      } catch (error) {
        this.ctx.report('discord', { state: 'error', detail: error instanceof DiscordHttpError ? error.message : 'Discord intake failed; event retained for retry', at: new Date().toISOString() })
        wait = Math.max(error instanceof DiscordHttpError ? error.retryMs : 0, Math.min(60_000, 1000 * 2 ** Math.min(failures++, 6)))
      }
      await delay(wait, undefined, { signal: this.signal }).catch(() => {})
    }
  }
}
