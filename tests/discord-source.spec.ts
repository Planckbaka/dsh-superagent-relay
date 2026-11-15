/** Native Discord policy, crash checkpoints and structured report acceptance. */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DiscordSource, discordTrigger, type DiscordMessage } from '../src/sources/discord.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { OutboundMessage } from '../src/core/index.ts'
import { family } from '../src/kv.ts'
import { Store } from '../src/app/store.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const channel = '100000000000000001', owner = '100000000000000002', bot = '100000000000000003'
const event: DiscordMessage = { id: '100000000000000004', channel_id: channel, content: `<@${bot}> calculate`,
  author: { id: owner }, mentions: [{ id: bot }] }
const binding = family<{ root: string; ticket?: string }, [string, string]>('discord:binding:')
const cursor = family<{ after: string; owner: string; bot: string }>('discord:cursor:')
let dir: string
let h: Host | undefined
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'relay-discord-source-')) })
afterEach(async () => { if (h) await h.stop(); h = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) })
function credentials() {
  const file = join(dir, 'discord.json'), tokenFile = join(dir, 'token')
  writeFileSync(tokenFile, 'test-secret', { mode: 0o600 })
  writeFileSync(file, JSON.stringify({ channel, owner, tokenFile }))
  return file
}
const authenticatedFetch: typeof fetch = async (url, init) => String(url).endsWith('/users/@me') ? Response.json({ id: bot, bot: true }) : fetch(url, init)
function harness() {
  const configFile = credentials(), state = new Map<string, unknown>(), stop = new AbortController()
  state.set(cursor(channel), { after: '100000000000000000', owner, bot })
  const receive = vi.fn(() => 'stored'), notify = vi.fn(), report = vi.fn()
  const ctx = { config: () => ({ configFile, pollSeconds: 1 }),
    state: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => value === undefined ? state.delete(key) : state.set(key, value), keys: (prefix: { prefix: string }) => [...state.keys()].filter(key => key.startsWith(prefix.prefix)) },
    receive, notify, report, atomic: <T>(work: () => T) => work(),
    threads: { get: () => undefined }, tickets: { get: () => undefined },
  } as unknown as SourceContext
  const source = new DiscordSource(() => ctx, stop.signal, { fetch: authenticatedFetch })
  return { source, ctx, state, stop, receive, notify }
}
const outbound = (text = 'result'): OutboundMessage => ({ id: 'reply-1', ticketId: 'ticket-1', kind: 'reply', text,
  channel: { source: 'discord', thread: `${channel}:${event.id}`, address: { channel, root: event.id, message: event.id } } })

it('keeps source-native actors and separates independent requests in the same Discord channel', () => {
  const first = discordTrigger(event, bot), second = discordTrigger({ ...event, id: '100000000000000005' }, bot)
  expect(first.actor).toEqual({ source: 'discord', id: owner })
  expect(first.addressed).toBe('mention'); expect(first.human).toBe(true)
  expect(first.threads).not.toEqual(second.threads)
  expect(discordTrigger({ ...event, author: { id: owner, bot: true } }, bot).human).toBe(false)
  expect(discordTrigger({ ...event, webhook_id: 'hook' }, bot).human).toBe(false)
})
it('retains a transient intake failure and retries the same event without advancing the cursor', async () => {
  const x = harness(); x.receive.mockImplementationOnce(() => { throw new Error('storage offline') })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([event])))
  await expect(x.source.poll()).rejects.toThrow('storage offline')
  expect(x.state.get(cursor(channel))).toMatchObject({ after: '100000000000000000' })
  await x.source.poll()
  expect(x.receive).toHaveBeenCalledTimes(2)
  expect(x.state.get(cursor(channel))).toMatchObject({ after: event.id })
})
it('maps followups through durable reply bindings to the same root and preserves author identity', async () => {
  const x = harness()
  x.state.set(binding(channel, '100000000000000090'), { root: event.id, ticket: 'one' })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ ...event, id: '100000000000000006', mentions: [],
    content: 'clarification', message_reference: { message_id: '100000000000000090' } }])))
  await x.source.poll()
  expect(x.receive).toHaveBeenCalledWith(expect.objectContaining({ actor: { source: 'discord', id: owner },
    threads: [{ source: 'discord', id: `${channel}:${event.id}` }], text: 'clarification' }))
})
it('restarts long deliveries at the first unsent chunk and retains stable retry nonces', async () => {
  const x = harness(), bodies: { content: string; nonce: string }[] = []
  let attempts = 0
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body); bodies.push(body)
    if (++attempts === 2) throw new Error('network failure')
    expect(body.allowed_mentions).toEqual({ parse: [], replied_user: false })
    return Response.json({ id: String(100000000000000090n + BigInt(attempts)) })
  }))
  const message = outbound('A'.repeat(1800) + 'B'.repeat(1800) + 'C')
  await expect(x.source.send(message)).rejects.toThrow('network failure')
  const restarted = new DiscordSource(() => x.ctx, x.stop.signal, { fetch: authenticatedFetch })
  await expect(restarted.send(message)).resolves.toBe('sent')
  expect(bodies.map(body => body.content[0])).toEqual(['A', 'B', 'B', 'C'])
  expect(bodies[1]!.nonce).toBe(bodies[2]!.nonce)
  expect(x.state.get(binding(channel, '100000000000000093'))).toMatchObject({ root: event.id, ticket: 'ticket-1' })
  await restarted.send(message)
  expect(bodies).toHaveLength(4)
})
it('reopens SQLite after a server-accepted POST loses its response and recovers its reply binding', async () => {
  const { ctx, stop } = harness()
  const path = join(dir, 'delivery.sqlite')
  const accepted = new Map<string, string>()
  const attempts: string[] = []
  const transport: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/users/@me')) return Response.json({ id: bot, bot: true })
    const { nonce, enforce_nonce } = JSON.parse(String(init?.body))
    expect(enforce_nonce).toBe(true)
    attempts.push(nonce)
    const previous = accepted.get(nonce)
    if (previous) return Response.json({ id: previous })
    const id = String(100000000000000090n + BigInt(accepted.size))
    accepted.set(nonce, id)
    if (accepted.size === 2) throw new Error('response lost after acceptance')
    return Response.json({ id })
  }
  const open = (store: Store) => new DiscordSource(() => ({ ...ctx, atomic: work => store.atomic(work),
    state: { ...ctx.state, get: key => store.get(key), set: (key, value) => store.set(key, value) } }), stop.signal, { fetch: transport })
  const message = outbound('A'.repeat(1800) + 'B')
  const first = new Store(path)
  try {
    await expect(open(first).send(message)).rejects.toThrow('response lost')
    expect(first.get(binding(channel, '100000000000000090'))).toBeDefined()
    expect(first.get(binding(channel, '100000000000000091'))).toBeUndefined()
  } finally { first.close() }
  const restarted = new Store(path)
  try {
    await expect(open(restarted).send(message)).resolves.toBe('sent')
    expect(attempts).toEqual([attempts[0], attempts[1], attempts[1]])
    expect(accepted.size).toBe(2)
    expect(restarted.get(binding(channel, '100000000000000091'))).toMatchObject({ root: event.id, ticket: 'ticket-1' })
  } finally { restarted.close() }
})
it.each([401, 403, 404, 429, 500])('retains delivery after HTTP %s rather than killing the source or losing the receipt', async status => {
  const x = harness()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status })))
  await expect(x.source.send(outbound())).rejects.toThrow(`Discord HTTP ${status}`)
  if (status === 429) { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 1001) }
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: '100000000000000090' })))
  await expect(x.source.send(outbound())).resolves.toBe('sent')
})
it('refuses delivery while paused, including a pause between chunks', async () => {
  const x = harness(); let paused = true
  const source = new DiscordSource(() => x.ctx, x.stop.signal, { paused: () => paused, fetch: authenticatedFetch })
  const request = vi.fn(async () => { paused = true; return Response.json({ id: '100000000000000090' }) })
  vi.stubGlobal('fetch', request)
  await expect(source.send(outbound('x'.repeat(2000)))).rejects.toThrow('paused'); expect(request).not.toHaveBeenCalled()
  paused = false
  await expect(source.send(outbound('x'.repeat(2000)))).rejects.toThrow('paused'); expect(request).toHaveBeenCalledTimes(1)
})

async function nativeRuntime() {
  h = await startRuntime()
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings,
    sources: { ...settings.sources, discord: { enabled: true, config: { configFile: credentials(), pollSeconds: 3 } } },
    policy: { ...settings.policy, sources: { ...settings.policy.sources, discord: { allowed: [{ id: owner }], admission: {} } } } })
  const sent: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (String(_url).endsWith('/users/@me')) return Response.json({ id: bot, bot: true })
    if (init.method === 'POST') { sent.push(JSON.parse(init.body).content); return Response.json({ id: String(100000000000000100n + BigInt(sent.length)) }) }
    return Response.json([])
  }))
  return { host: h, sent }
}
it('uses native Eval and sender policy; an unlisted Discord user never directly creates work', async () => {
  const { host } = await nativeRuntime()
  const stranger = discordTrigger({ ...event, author: { id: '100000000000000099' } }, bot)
  host.runtime.receive(stranger); await host.runtime.idle()
  expect(host.runtime.store.tickets.list()).toHaveLength(0)
  expect(host.candidates()).toEqual([])
  const allowed = discordTrigger({ ...event, id: '100000000000000005' }, bot)
  host.runtime.receive(allowed); await host.runtime.idle()
  expect(host.candidates()).toContain(allowed.id)
  expect(host.runtime.store.tickets.list()).toHaveLength(0)
})
it('delivers the structured human question, stays quiet on ordinary progress and resumes the same ticket on reply', async () => {
  const { host, sent } = await nativeRuntime()
  const { ticket, sessionId } = await host.acceptedTicket(discordTrigger(event, bot))
  const acknowledgements = sent.length
  await host.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'working internally' })
  await host.runtime.sendReplies(); expect(sent).toHaveLength(acknowledgements)
  await host.runTool(sessionId, 'orchestrator_report', { state: 'blocked', summary: 'need input', human_action: 'Which branch should I use?' })
  await host.runtime.sendReplies(); expect(sent.at(-1)).toBe('Which branch should I use?')
  const followup = discordTrigger({ ...event, id: '100000000000000008', content: 'use feature-x', mentions: [] }, bot, event.id)
  host.runtime.receive(followup); await host.runtime.idle()
  expect(host.runtime.store.tickets.list()).toHaveLength(1)
  expect(host.runtime.store.tickets.get(ticket.id)!.inputs.some(input => input.kind === 'trigger' && input.triggerId === followup.id)).toBe(true)
  await host.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done with feature-x', human_action: null })
  await host.runtime.sendReplies(); expect(sent.at(-1)).not.toBe('Done with feature-x')
  await host.runTool(host.runtime.masterId, 'orchestrator_reply', { purpose: 'result', ticket_id: ticket.id, text: 'Done with feature-x' })
  expect(sent.at(-1)).toBe('Done with feature-x')
  expect(host.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
})
it('holds native questions and results in the Outbox while paused and delivers on resume', async () => {
  const { host, sent } = await nativeRuntime()
  const { sessionId } = await host.acceptedTicket(discordTrigger(event, bot))
  await host.runtime.settings.pause(true, 'panel')
  const before = sent.length
  await host.runTool(sessionId, 'orchestrator_report', { state: 'blocked', summary: 'blocked', human_action: 'Approve the target branch?' })
  await host.runtime.sendReplies(); expect(sent).toHaveLength(before)
  await host.runtime.settings.pause(false, 'panel'); await host.runtime.pump(); await host.runtime.sendReplies()
  expect(sent.at(-1)).toBe('Approve the target branch?')
})
it('lets another ticket receive results even when one reply fails permanently until repaired', async () => {
  const { host, sent } = await nativeRuntime()
  const first = await host.acceptedTicket(discordTrigger(event, bot))
  const second = await host.acceptedTicket(discordTrigger({ ...event, id: '100000000000000005' }, bot))
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.content === 'first result') return Response.json({}, { status: 403 })
    sent.push(body.content); return Response.json({ id: '100000000000000199' })
  }))
  await host.runTool(first.sessionId, 'orchestrator_report', { state: 'ready', summary: 'first result' })
  await host.runTool(second.sessionId, 'orchestrator_report', { state: 'ready', summary: 'second result' })
  await host.runTool(host.runtime.masterId, 'orchestrator_reply', { purpose: 'result', ticket_id: first.ticket.id, text: 'first result' })
  await host.runTool(host.runtime.masterId, 'orchestrator_reply', { purpose: 'result', ticket_id: second.ticket.id, text: 'second result' })
  await host.runtime.sendReplies()
  expect(sent).toContain('second result'); expect(sent).not.toContain('first result')
})
it('allows workspace writes but refuses a model-originated permission escalation', async () => {
  const { host } = await nativeRuntime()
  const executor = host.runtime.store.settings().executor
  expect(executor.permissionPreset).toBe('workspace-write')
  await expect(host.runtime.settings.save('executor', { ...executor, permissionPreset: 'danger-full-access' },
    host.runtime.store.blockRevision('executor'), 'tool')).rejects.toThrow()
  expect(host.runtime.store.settings().executor.permissionPreset).toBe('workspace-write')
})
it('records intake during a global pause and evaluates it only after resume', async () => {
  const { host } = await nativeRuntime()
  host.runtime.store.set(cursor(channel), { after: '100000000000000000', owner, bot })
  await host.runtime.settings.pause(true, 'panel')
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([event])))
  const source = new DiscordSource(() => host.runtime.context({ kind: 'discord', health: ['discord'] }), new AbortController().signal, { fetch: authenticatedFetch })
  await source.poll(); await host.runtime.idle()
  expect(host.runtime.store.triggers.get(`discord:${event.id}`)).toBeDefined()
  expect(host.candidates()).toEqual([])
  await host.runtime.settings.pause(false, 'panel'); await host.runtime.pump(); await host.runtime.idle()
  expect(host.candidates()).toContain(`discord:${event.id}`)
})
it('keeps two native tickets isolated and refuses a late report after a human stop', async () => {
  const { host } = await nativeRuntime()
  const first = await host.acceptedTicket(discordTrigger(event, bot))
  const second = await host.acceptedTicket(discordTrigger({ ...event, id: '100000000000000005' }, bot))
  const followup = discordTrigger({ ...event, id: '100000000000000006', mentions: [], content: 'only task one' }, bot, event.id)
  host.runtime.receive(followup); await host.runtime.idle()
  const inputs = (id: string) => host.runtime.store.tickets.get(id)!.inputs.filter(input => input.kind === 'trigger').map(input => input.triggerId)
  expect(inputs(first.ticket.id)).toContain(followup.id)
  expect(inputs(second.ticket.id)).not.toContain(followup.id)
  host.runtime.engine.stopTicket(first.ticket.id, 'Owner stopped the task')
  await expect(host.runTool(first.sessionId, 'orchestrator_report', { state: 'ready', summary: 'late result' })).rejects.toThrow()
  expect(host.runtime.store.tickets.get(first.ticket.id)?.ended?.by).toBe('human')
  expect(host.runtime.store.tickets.get(second.ticket.id)?.ended).toBeUndefined()
})
it('revalidates rotated credentials and refuses a different bot before sending', async () => {
  const x = harness(); let apiBot = bot; let posts = 0
  const source = new DiscordSource(() => x.ctx, x.stop.signal, { fetch: async url => {
    if (String(url).endsWith('/users/@me')) return Response.json({ id: apiBot, bot: true })
    posts++; return Response.json({ id: '100000000000000090' })
  } })
  await source.send(outbound())
  writeFileSync(join(dir, 'token'), 'rotated-private-test-token')
  apiBot = '100000000000000099'
  await expect(source.send({ ...outbound(), id: 'new-reply' })).rejects.toThrow('identity changed')
  expect(posts).toBe(1)
})
it('persists a Discord rate-limit cooldown across transport restarts without retrying the HTTP request early', async () => {
  const x = harness(); let requests = 0
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (++requests === 1) return Response.json({ retry_after: 5 }, { status: 429 })
    return Response.json({ id: '100000000000000090' })
  }))
  await expect(x.source.send(outbound())).rejects.toThrow('429')
  const restarted = new DiscordSource(() => x.ctx, x.stop.signal, { fetch: authenticatedFetch })
  await expect(restarted.send(outbound())).rejects.toThrow('429')
  expect(requests).toBe(1)
  vi.setSystemTime(Date.now() + 5001)
  await expect(restarted.send(outbound())).resolves.toBe('sent')
  expect(requests).toBe(2)
})
it('compacts only old settled checkpoints and inactive bindings, keeping pending delivery and live ticket bindings', () => {
  const x = harness(), touched = Date.now() - 31 * 24 * 3600_000
  x.ctx.replyStatus = id => id === 'settled' ? 'sent' : 'pending'
  x.state.set('discord:delivery:settled', { next: 1, fingerprint: 'f', receipt: 'settled', touched })
  x.state.set('discord:delivery:pending', { next: 1, fingerprint: 'f', receipt: 'pending', touched })
  x.state.set(binding(channel, '100000000000000090'), { root: event.id, touched })
  x.state.set(binding(channel, '100000000000000091'), { root: event.id, ticket: 'live', touched })
  x.source.compact()
  expect(x.state.has('discord:delivery:settled')).toBe(false)
  expect(x.state.has('discord:delivery:pending')).toBe(true)
  expect(x.state.has(binding(channel, '100000000000000090'))).toBe(false)
  expect(x.state.has(binding(channel, '100000000000000091'))).toBe(true)
})
it('filters unrelated tasks out of bounded Discord context reads', async () => {
  const x = harness()
  const reply = { ...event, id: '100000000000000090', content: 'only this ticket' }
  x.state.set(binding(channel, reply.id), { root: event.id })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([event, { ...event, id: '100000000000000005', content: 'another private task' }, reply])))
  const value = x.source.kind.schema.parse({ configFile: join(dir, 'discord.json') })
  const result = await x.source.kind.threadContext!.read({} as never, discordTrigger(event, bot), 'thread', undefined, value)
  expect(result.messages.map(message => message.id)).toEqual([event.id, reply.id])
  expect(JSON.stringify(result)).not.toContain('another private task')
})
