import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chatInput, chunks, watchDiscordChat, type ChatHost, type ChatMessage } from '../src/discord-chat.ts'
const channel = '100000000000000001', owner = '100000000000000002', bot = '100000000000000003'
const event: ChatMessage = { id: '100000000000000005', channel_id: channel, author: { id: owner }, mentions: [{ id: bot }], mention_roles: [], content: `<@${bot}> explain gravity` }
const dirs: string[] = []
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function config() {
 const dir = mkdtempSync(join(tmpdir(), 'discord-chat-')); dirs.push(dir)
 const tokenFile = join(dir, 'token'); writeFileSync(tokenFile, 'test-token')
 const file = join(dir, 'config.json'); writeFileSync(file, JSON.stringify({ channel, owner, tokenFile })); return file
}
it('authorizes owner mentions and mapped replies, rejects bots, roles, unknown replies and other senders', () => {
 expect(chatInput(event, channel, owner, bot, {})).toEqual({ text: 'explain gravity', ticket: undefined })
 expect(chatInput({ ...event, mentions: [], content: 'why?', message_reference: { message_id: bot } }, channel, owner, bot, { [bot]: 'ticket' })?.ticket).toBe('ticket')
 for (const patch of [{ author: { id: bot } }, { author: { id: owner, bot: true } }, { channel_id: owner }, { webhook_id: 'x' }, { mentions: [], mention_roles: [bot] }]) {
  expect(chatInput({ ...event, ...patch }, channel, owner, bot, {})).toBeUndefined()
 }
})
it('splits long unicode answers without losing characters', () => {
 const text = '你好🙂'.repeat(2000); expect(chunks(text).join('')).toBe(text)
 expect(chunks(text).every(part => part.length <= 1800)).toBe(true)
})
it('delivers acknowledgement and completion, persists reply binding, and resumes without reexecuting', async () => {
 const file = config(); let sent = 0; let submitted = false; let stop = new AbortController()
 const host: ChatHost = { submit: vi.fn(() => { submitted = true; return 'ticket' }), status: () => submitted ? { state: 'completed', text: '59', revision: 'done' } : undefined, cancel: vi.fn(), health: vi.fn() }
 vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
  if (url.endsWith('/users/@me')) return Response.json({ id: bot, bot: true })
  if (init.method === 'POST') {
   const body = JSON.parse(init.body as string)
   expect(body.allowed_mentions).toEqual({ parse: [], replied_user: false }); expect(body.enforce_nonce).toBe(true)
   if (++sent === 2) stop.abort()
   return Response.json({ id: String(100000000000000020n + BigInt(sent)) })
  }
  return Response.json(url.endsWith('?limit=1') ? [] : [event])
 }))
 await watchDiscordChat(file, stop.signal, host, { pollMs: 0 })
 expect(host.submit).toHaveBeenCalledTimes(1); expect(sent).toBe(2)
 const saved = JSON.parse(readFileSync(file + '.chat-state.json', 'utf8'))
 expect(saved.queue).toEqual([]); expect(Object.values(saved.replies)).toContain('ticket'); expect(saved.cursor).toBe(event.id)
 stop = new AbortController()
 vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  if (url.endsWith('/users/@me')) return Response.json({ id: bot, bot: true })
  expect(url).toContain('after=' + event.id); stop.abort(); return Response.json([])
 }))
 await watchDiscordChat(file, stop.signal, host)
 expect(host.submit).toHaveBeenCalledTimes(1)
})
it('retains outbound work after a permission failure for restart recovery', async () => {
 const file = config()
 vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
  if (url.endsWith('/users/@me')) return Response.json({ id: bot, bot: true })
  if (init.method === 'POST') return Response.json({}, { status: 403 })
  return Response.json(url.endsWith('?limit=1') ? [] : [event])
 }))
 await expect(watchDiscordChat(file, new AbortController().signal, { submit: () => 'ticket', status: () => undefined, cancel: () => {}, health: () => {} })).rejects.toThrow('403')
 expect(JSON.parse(readFileSync(file + '.chat-state.json', 'utf8')).queue).toHaveLength(1)
})

it('routes mapped follow-ups and owner stop commands without creating another task', async () => {
 const file = config(); const stop = new AbortController(); let round = 0; let sent = 0
 const followup = { ...event, id: '100000000000000006', content: 'why?', mentions: [], message_reference: { message_id: event.id } }
 const cancel = { ...event, id: '100000000000000007', content: `<@${bot}> /stop` }
 const host: ChatHost = { submit: vi.fn(() => 'ticket'), cancel: vi.fn(), status: () => ({ state: 'running', text: 'working', revision: 'v1' }), health: () => {} }
 vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
  if (url.endsWith('/users/@me')) return Response.json({ id: bot, bot: true })
  if (init.method === 'POST') return Response.json({ id: String(100000000000000030n + BigInt(++sent)) })
  if (url.endsWith('?limit=1')) return Response.json([])
  if (++round === 1) return Response.json([event])
  if (round === 2) return Response.json([followup, cancel])
  stop.abort(); return Response.json([])
 }))
 await watchDiscordChat(file, stop.signal, host, { pollMs: 0 })
 expect(host.submit).toHaveBeenCalledTimes(2)
 expect(host.submit).toHaveBeenLastCalledWith('why?', followup.id, 'ticket')
 expect(host.cancel).toHaveBeenCalledWith('ticket')
})
it('retries a rate limited delivery using the same nonce without resubmitting work', async () => {
 const file = config(); const stop = new AbortController(); const nonces: string[] = []
 const host: ChatHost = { submit: vi.fn(() => 'ticket'), cancel: () => {}, status: () => undefined, health: () => {} }
 vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
  if (url.endsWith('/users/@me')) return Response.json({ id: bot, bot: true })
  if (init.method === 'POST') {
   nonces.push(JSON.parse(init.body as string).nonce)
   if (nonces.length === 1) return Response.json({}, { status: 429, headers: { 'retry-after': '0.01' } })
   stop.abort(); return Response.json({ id: '100000000000000099' })
  }
  return Response.json(url.endsWith('?limit=1') || nonces.length ? [] : [event])
 }))
 await watchDiscordChat(file, stop.signal, host, { pollMs: 0 })
 expect(nonces).toHaveLength(2); expect(nonces[0]).toBe(nonces[1]); expect(host.submit).toHaveBeenCalledTimes(1)
})
