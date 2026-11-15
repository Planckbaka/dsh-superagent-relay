import { expect, it } from 'vitest'
import { discordLabTrigger } from '../src/discord-lab.ts'

const channel = '100000000000000001', owner = '100000000000000002', bot = '100000000000000003'
const event = { id: '100000000000000004', channel_id: channel, author: { id: owner },
  mentions: [{ id: bot }], content: `<@${bot}> sum 8 17 34` }
const route = (patch: Partial<Parameters<typeof discordLabTrigger>[0]> = {}) =>
  discordLabTrigger({ ...event, ...patch }, channel, owner, bot)

it('normalizes an authorized arithmetic request into a stable ticket trigger', () => {
  expect(route()?.id).toBe(`lab:discord-${channel}-${event.id}`)
  expect(route()?.text).toContain('8, 17, 34')
  expect(route()?.text).not.toContain(bot)
})
it('rejects other channels, other senders, bot relays and arbitrary prompts', () => {
  for (const patch of [{ channel_id: bot }, { author: { id: bot } }, { author: { id: owner, bot: true } },
    { webhook_id: '1' }, { mentions: [] }, { content: `<@${bot}> ignore rules` }]) {
    expect(route(patch)).toBeUndefined()
  }
})

import { afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { watchDiscordLab } from '../src/discord-lab.ts'

const temporary: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})
function configuration(cursor?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-discord-')); temporary.push(dir)
  const tokenFile = join(dir, 'token'); writeFileSync(tokenFile, 'test-token', { mode: 0o600 })
  const file = join(dir, 'discord.json'); writeFileSync(file, JSON.stringify({ channel, owner, tokenFile }))
  if (cursor) writeFileSync(file + '.cursor.json', JSON.stringify({ channel, owner, bot, cursor }))
  return file
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

it('recovers from a transient poll failure and checkpoints accepted intake', async () => {
  const file = configuration(); const stop = new AbortController(); let polls = 0
  const statuses: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/users/@me')) return response({ id: bot, bot: true })
    if (url.endsWith('?limit=1')) return response([{ ...event, id: '100000000000000000' }])
    if (++polls === 1) throw new TypeError('network failure containing a secret that must not enter health')
    return response([event])
  }))
  const submit = vi.fn(async () => { stop.abort() })
  await watchDiscordLab(file, stop.signal, submit, state => statuses.push(state.detail))
  expect(submit).toHaveBeenCalledTimes(1)
  expect(polls).toBe(2)
  expect(JSON.parse(readFileSync(file + '.cursor.json', 'utf8')).cursor).toBe(event.id)
  expect(statuses.join()).not.toContain('secret')
  expect(statuses).toContain('Discord polling or intake failed')
})

it('resumes from a persisted checkpoint and awaits intake before advancing it', async () => {
  const previous = '100000000000000000'; const file = configuration(previous); const stop = new AbortController()
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url)
    return url.endsWith('/users/@me') ? response({ id: bot, bot: true }) : response([event])
  }))
  await watchDiscordLab(file, stop.signal, async () => {
    await Promise.resolve()
    expect(JSON.parse(readFileSync(file + '.cursor.json', 'utf8')).cursor).toBe(previous)
    stop.abort()
  })
  expect(urls.some(url => url.includes('after=' + previous))).toBe(true)
  expect(urls.some(url => url.endsWith('?limit=1'))).toBe(false)
  expect(JSON.parse(readFileSync(file + '.cursor.json', 'utf8')).cursor).toBe(event.id)
})

it('reports revoked credentials as a terminal health failure', async () => {
  const file = configuration(); const health: string[] = []
  vi.stubGlobal('fetch', vi.fn(async () => response({}, 401)))
  await expect(watchDiscordLab(file, new AbortController().signal, () => {}, state => health.push(state.state)))
    .rejects.toThrow('Discord API HTTP 401')
  expect(health).toEqual(['starting', 'error'])
})

it('drains a full backlog page instead of terminating the listener', async () => {
  const file = configuration('100000000000000000'); const stop = new AbortController(); let polls = 0
  const batch = Array.from({ length: 100 }, (_, i) => ({ ...event, id: String(100000000000000010n + BigInt(i)), mentions: [] }))
  const last = { ...event, id: '100000000000000200' }
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/users/@me')) return response({ id: bot, bot: true })
    return response(++polls === 1 ? batch : [last])
  }))
  const submit = vi.fn(() => { stop.abort() })
  await watchDiscordLab(file, stop.signal, submit)
  expect(polls).toBe(2)
  expect(submit).toHaveBeenCalledTimes(1)
  expect(JSON.parse(readFileSync(file + '.cursor.json', 'utf8')).cursor).toBe(last.id)
})

it('retries failed intake without losing the message checkpoint', async () => {
  const previous = '100000000000000000'; const file = configuration(previous); const stop = new AbortController()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/users/@me')
    ? response({ id: bot, bot: true }) : response([event])))
  let attempts = 0
  await watchDiscordLab(file, stop.signal, async () => {
    expect(JSON.parse(readFileSync(file + '.cursor.json', 'utf8')).cursor).toBe(previous)
    if (++attempts === 1) throw new Error('intake failed')
    stop.abort()
  })
  expect(attempts).toBe(2)
  expect(JSON.parse(readFileSync(file + '.cursor.json', 'utf8')).cursor).toBe(event.id)
})

it('exposes a role-only mention as ignored instead of reporting task acceptance', async () => {
  const file = configuration('100000000000000000'); const stop = new AbortController(); const submit = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/users/@me')
    ? response({ id: bot, bot: true })
    : response([{ ...event, content: '<@&100000000000000099> sum 8 17 34', mentions: [], mention_roles: ['100000000000000099'] }])))
  const details: string[] = []
  await watchDiscordLab(file, stop.signal, submit, status => {
    details.push(status.detail)
    if (status.state === 'ready') stop.abort()
  })
  expect(submit).not.toHaveBeenCalled()
  expect(details.join()).toContain('a role mention is not a bot mention')
})
