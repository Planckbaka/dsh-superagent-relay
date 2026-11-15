/** Read-only Discord lab transport. Only typed arithmetic requests reach Workers. */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { Health } from './sources/host.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { localTrigger } from './local-loop.ts'
import type { Trigger } from './core/model.ts'

const snowflake = z.string().regex(/^\d{16,22}$/)
const configSchema = z.object({ channel: snowflake, owner: snowflake, tokenFile: z.string().startsWith('/') }).strict()
const botSchema = z.object({ id: snowflake, bot: z.literal(true) })
const messages = z.array(z.object({
  id: snowflake, channel_id: snowflake, content: z.string(), webhook_id: z.string().optional(),
  author: z.object({ id: snowflake, bot: z.boolean().optional() }),
  mentions: z.array(z.object({ id: snowflake })),
  mention_roles: z.array(snowflake).optional(),
}))
type Message = z.infer<typeof messages>[number]

export function discordLabTrigger(message: Message, channel: string, owner: string, bot: string): Trigger | undefined {
  if (message.channel_id !== channel || message.author.id !== owner || message.author.bot ||
      message.webhook_id || !message.mentions.some(user => user.id === bot)) return
  const match = new RegExp(`^<@!?${bot}>\\s+sum\\s+([0-9]{1,3})\\s+([0-9]{1,3})\\s+([0-9]{1,3})$`, 'i').exec(message.content.trim())
  if (!match) return
  return localTrigger({ id: `discord-${channel}-${message.id}`, numbers: match.slice(1).map(Number) })
}

/** Sanitized Discord API failure used by the legacy arithmetic fixture. */
class DiscordHttpError extends Error {
  constructor(readonly status: number) { super(`Discord API HTTP ${status}`) }
}

export async function watchDiscordLab(file: string, signal: AbortSignal, submit: (trigger: Trigger) => void | Promise<void>,
  report: (health: Health) => void = () => {}) {
  const config = configSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  const token = readFileSync(config.tokenFile, 'utf8').trim()
  if (!/^[A-Za-z0-9_.-]+$/.test(token)) throw new Error('Invalid Discord bot token file')
  report({ state: 'starting', detail: 'Checking Discord channel access' })
  async function get(path: string) {
    const response = await fetch('https://discord.com/api/v10' + path, {
      headers: { Authorization: 'Bot ' + token }, redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    })
    if (!response.ok) throw new DiscordHttpError(response.status)
    return response.json()
  }
  // Cursor identity includes the owner and bot: changing either must not reuse another consumer's checkpoint.
  const checkpoint = file + '.cursor.json'
  let bot: z.infer<typeof botSchema> | undefined
  let cursor: string | undefined
  let failures = 0
  let lastMessage = ''
  const persist = (next: string) => {
    const temporary = checkpoint + '.tmp'
    writeFileSync(temporary, JSON.stringify({ channel: config.channel, owner: config.owner, bot: bot!.id, cursor: next }), { mode: 0o600 })
    renameSync(temporary, checkpoint)
    cursor = next
  }
  while (!signal.aborted) {
    try {
      bot ??= botSchema.parse(await get('/users/@me'))
      const path = `/channels/${config.channel}/messages`
      if (!cursor) {
        if (existsSync(checkpoint)) {
          const saved = z.object({ channel: snowflake, owner: snowflake, bot: snowflake, cursor: snowflake })
            .parse(JSON.parse(readFileSync(checkpoint, 'utf8')))
          if (saved.channel === config.channel && saved.owner === config.owner && saved.bot === bot.id) cursor = saved.cursor
        }
        if (!cursor) {
          const newest = messages.parse(await get(path + '?limit=1'))[0]?.id
          persist(newest ?? (BigInt(Date.now() - 1420070400000) << 22n).toString())
        }
      }
      const batch = messages.parse(await get(path + '?limit=100&after=' + cursor))
      batch.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1)
      for (const message of batch) {
        const trigger = discordLabTrigger(message, config.channel, config.owner, bot.id)
        // Await durable intake before advancing. Engine trigger IDs deduplicate a replay after a crash.
        if (trigger) await submit(trigger)
        if (message.author.id === config.owner && !message.author.bot && !message.webhook_id) {
          lastMessage = trigger ? 'Last owner message accepted.'
            : message.mention_roles?.length ? 'Last owner message ignored: a role mention is not a bot mention.'
            : !message.mentions.some(user => user.id === bot!.id) ? 'Last owner message ignored: mention the bot account.'
            : 'Last owner message ignored: expected @bot sum followed by three integers (0-999).'
        }
        persist(message.id)
      }
      failures = 0
      report({ state: 'ready', detail: `Discord read-only polling active; results are saved locally. ${lastMessage}`.trim(), at: new Date().toISOString() })
      // Drain a full page before waiting rather than terminating and silently losing the backlog.
      if (batch.length < 100) await delay(5000, undefined, { signal })
    } catch (error) {
      if (signal.aborted) return
      const detail = error instanceof DiscordHttpError ? error.message : 'Discord polling or intake failed'
      report({ state: 'error', detail, at: new Date().toISOString() })
      if (error instanceof DiscordHttpError && [401, 403, 404].includes(error.status)) throw error
      // Network failures and rate limits must not permanently terminate the listener.
      await delay(Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)), undefined, { signal })
    }
  }
}
