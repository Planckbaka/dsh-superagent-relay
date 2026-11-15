/** Discord conversation transport. No Discord credentials or raw HTTP failures enter model context. */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { Health } from './sources/host.ts'

const id = z.string().regex(/^\d{16,22}$/)
const configSchema = z.object({ channel: id, owner: id, tokenFile: z.string().startsWith('/') }).strict()
const messageSchema = z.object({ id, channel_id: id, content: z.string(), author: z.object({ id, bot: z.boolean().optional() }),
  webhook_id: z.string().optional(), mentions: z.array(z.object({ id })), mention_roles: z.array(id).default([]),
  message_reference: z.object({ message_id: id.optional() }).optional() })
export type ChatMessage = z.infer<typeof messageSchema>
export interface ChatHost {
  submit(message: string, messageId: string, ticket?: string): string
  status(ticket: string): { state: string; text: string; revision: string } | undefined
  cancel(ticket: string): void
  health(value: Health): void
}
const binding = z.object({ ticket: z.string(), revision: z.string().default('') })
const stateSchema = z.object({ identity: z.string(), cursor: id, bindings: z.record(z.string(), binding),
  replies: z.record(z.string(), z.string()), queue: z.array(z.object({ key: z.string(), reference: id, text: z.string(), ticket: z.string().optional() })) })
type State = z.infer<typeof stateSchema>

/** Only configured human owner; role mentions are not authorization to execute work. */
export function chatInput(message: ChatMessage, channel: string, owner: string, bot: string, replies: Record<string, string>) {
  if (message.channel_id !== channel || message.author.id !== owner || message.author.bot || message.webhook_id) return
  const ticket = message.message_reference?.message_id ? replies[message.message_reference.message_id] : undefined
  const addressed = message.mentions.some(user => user.id === bot)
  if (!addressed && !ticket) return
  const text = message.content.replace(new RegExp(`^<@!?${bot}>\\s*`), '').trim()
  return { text, ticket }
}
export function chunks(text: string): string[] {
  // Plain text chunks preserve every character; mentions are suppressed separately on the wire.
  const parts: string[] = []
  let part = ''
  for (const character of text) {
    if (part.length + character.length > 1800) { parts.push(part); part = '' }
    part += character
  }
  if (part) parts.push(part)
  return parts.length ? parts : ['（无文本结果）']
}
/** Sanitized status and bounded retry timing for Discord transport failures. */
class HttpError extends Error {
  constructor(readonly status: number, readonly retry: number = 1000) { super(`Discord HTTP ${status}`) }
}
export async function watchDiscordChat(file: string, signal: AbortSignal, host: ChatHost,
  options: { pollMs?: number } = {}) {
  const config = configSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  const token = readFileSync(config.tokenFile, 'utf8').trim()
  if (!/^[A-Za-z0-9_.-]+$/.test(token)) throw new Error('Invalid Discord token file')
  const stateFile = file + '.chat-state.json'
  let state: State | undefined
  const save = () => {
    writeFileSync(stateFile + '.tmp', JSON.stringify(state), { mode: 0o600 })
    renameSync(stateFile + '.tmp', stateFile)
  }
  async function request(path: string, body?: unknown) {
    const response = await fetch('https://discord.com/api/v10' + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    })
    if (!response.ok) {
      const retry = Number(response.headers.get('retry-after')) * 1000
      throw new HttpError(response.status, Math.max(1000, Math.min(300000, retry || 1000)))
    }
    return response.json()
  }
  const path = `/channels/${config.channel}/messages`
  let bot = ''; let failures = 0
  function enqueue(key: string, reference: string, text: string, ticket?: string) {
    if (!state!.queue.some(item => item.key === key)) state!.queue.push({ key, reference, text, ticket })
  }
  host.health({ state: 'starting', detail: 'Discord chat connecting' })
  while (!signal.aborted) {
    try {
      if (!bot) bot = z.object({ id, bot: z.literal(true) }).parse(await request('/users/@me')).id
      if (!state) {
        const identity = `${config.channel}:${config.owner}:${bot}`
        if (existsSync(stateFile)) {
          const saved = stateSchema.parse(JSON.parse(readFileSync(stateFile, 'utf8')))
          if (saved.identity !== identity) throw new Error('Discord state identity mismatch')
          state = saved
        } else {
          const latest = z.array(messageSchema).parse(await request(path + '?limit=1'))[0]
          state = { identity, cursor: latest?.id ?? (BigInt(Date.now() - 1420070400000) << 22n).toString(), bindings: {}, replies: {}, queue: [] }
          save()
        }
      }
      const batch = z.array(messageSchema).parse(await request(path + '?limit=100&after=' + state.cursor))
      batch.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1)
      for (const message of batch) {
        const input = chatInput(message, config.channel, config.owner, bot, state.replies)
        if (input) {
          const { text, ticket } = input
          if (!text || text === '/help') {
            enqueue(message.id, message.id, '发起任务：@机器人 自然语言任务。回复机器人消息可继续追问。控制：@机器人 /status 或 /stop（回复某任务可指定任务）。任务以只读权限执行。')
          } else if (text === '/status' || text === '/stop') {
            const target = ticket ?? Object.values(state.bindings).at(-1)?.ticket
            if (target && text === '/stop') {
              try { host.cancel(target) } catch { enqueue(message.id, message.id, '该任务无法停止，请查询 /status。'); state.cursor = message.id; save(); continue }
            }
            const status = target && host.status(target)
            enqueue(message.id, message.id, status ? `任务 ${target}：${status.state}\n${status.text}` : '暂无关联任务。', target)
          } else if (text.length > 8000 || text.startsWith('/')) {
            enqueue(message.id, message.id, '请求未执行：请使用 /help 查看指令，任务文本上限 8000 字符。')
          } else {
            let target: string
            try { target = host.submit(text, message.id, ticket) } catch {
              enqueue(message.id, message.id, '请求未被接收：任务不可用，请重新 @机器人 发起新任务。')
              state.cursor = message.id; save(); continue
            }
            state.bindings[message.id] = { ticket: target, revision: ticket ? host.status(target)?.revision ?? '' : '' }
            state.replies[message.id] = target
            enqueue(message.id + ':ack', message.id, `已接收，正在处理。任务：${target}`, target)
          }
        } else if (message.author.id === config.owner && !message.author.bot && !message.webhook_id && message.mention_roles.length) {
          enqueue(message.id + ':help', message.id, '你提及了角色，请选择带 APP 标识的机器人账号，或回复机器人的任务消息。')
        }
        state.cursor = message.id
        save()
      }
      // Track each ticket once even after multiple follow-up requests.
      const seen = new Set<string>()
      for (const [reference, link] of Object.entries(state.bindings).reverse()) {
        if (seen.has(link.ticket)) continue
        seen.add(link.ticket)
        const status = host.status(link.ticket)
        if (status && status.revision !== link.revision) {
          enqueue(`${link.ticket}:${status.revision}`, reference, `任务 ${link.ticket}：${status.state}\n${status.text}`, link.ticket)
          link.revision = status.revision
          save()
        }
      }
      while (state.queue.length && !signal.aborted) {
        const item = state.queue[0]!
        for (const [index, content] of chunks(item.text).entries()) {
          // Discord enforces nonce deduplication for recent retries; this is not an unlimited exactly-once guarantee.
          const nonce = createHash('sha256').update(`${item.key}:${index}`).digest('hex').slice(0, 24)
          const sent = z.object({ id }).parse(await request(path, { content, nonce, enforce_nonce: true,
            allowed_mentions: { parse: [], replied_user: false },
            message_reference: { message_id: item.reference, fail_if_not_exists: false } }))
          if (item.ticket) state.replies[sent.id] = item.ticket
          save()
        }
        state.queue.shift(); save()
      }
      failures = 0
      host.health({ state: 'ready', detail: `Discord chat active; pending replies: ${state.queue.length}`, at: new Date().toISOString() })
      if (batch.length < 100) await delay(options.pollMs ?? 3000, undefined, { signal })
    } catch (error) {
      if (signal.aborted) return
      host.health({ state: 'error', detail: error instanceof HttpError ? error.message : 'Discord chat intake or delivery failed', at: new Date().toISOString() })
      if (error instanceof HttpError && [401, 403, 404].includes(error.status)) throw error
      await delay(Math.max(error instanceof HttpError ? error.retry : 0, Math.min(30000, 1000 * 2 ** Math.min(failures++, 5))), undefined, { signal }).catch(() => {})
    }
  }
}
