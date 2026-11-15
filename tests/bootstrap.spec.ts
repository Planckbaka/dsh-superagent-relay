/** Fresh deployment initialization and standalone write-profile identity checks. */
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { bootstrapSettings } from '../src/app/bootstrap.ts'
import { SettingsSchema } from '../src/policy.ts'
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'relay-bootstrap-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
function config(overrides: Record<string, unknown> = {}) {
  const discord = join(dir, 'discord.json')
  writeFileSync(discord, JSON.stringify({ owner: '100000000000000001', channel: '100000000000000002', tokenFile: join(dir, 'token') }))
  const file = join(dir, 'bootstrap.json')
  writeFileSync(file, JSON.stringify({ repository: 'maintainer/project', githubCli: '/private/agent/gh', agentLogin: 'dedicated-bot',
    githubAllowed: ['maintainer'], discordConfigFile: discord, permissionPreset: 'workspace-write', ...overrides }))
  return file
}
it('initializes a native write deployment without merging source identities or enabling proactive writes', () => {
  const result = bootstrapSettings(config(), SettingsSchema.parse({}))
  expect(result.agentLogin).toBe('dedicated-bot')
  expect(result.settings.eval.mode).toBe('observe')
  expect(result.settings.executor.permissionPreset).toBe('workspace-write')
  expect(result.settings.executor.prepare).toContain('switch -c "agent/$DSH_SUPERAGENT_NAME"')
  expect(result.settings.policy.sources.github?.allowed).toEqual([{ id: 'maintainer' }])
  expect(result.settings.policy.sources.discord?.allowed).toEqual([{ id: '100000000000000001' }])
  expect(result.settings.sources.discord?.enabled).toBe(true)
})
it('rejects a personal owner identity and refuses to overwrite an existing profile', () => {
  expect(() => bootstrapSettings(config({ agentLogin: 'maintainer' }), SettingsSchema.parse({}))).toThrow('dedicated')
  expect(() => bootstrapSettings(config(), SettingsSchema.parse({ sources: { github: { config: {} } } }))).toThrow('fresh profile')
})
it('does not expose malformed bootstrap content', () => {
  const file = join(dir, 'bootstrap.json'); writeFileSync(file, '{"secret":"fake-private-key"')
  expect(() => bootstrapSettings(file, SettingsSchema.parse({}))).toThrow('Invalid Superagent bootstrap configuration')
})
function preflight(login: string, push: boolean, fail = false) {
  const cli = join(dir, 'gh-agent')
  writeFileSync(cli, `#!/usr/bin/env python3\nimport os,sys,json\nif 'GH_TOKEN' in os.environ or 'GITHUB_TOKEN' in os.environ or ${fail ? 'True' : 'False'}:\n print('fake-private-key',file=sys.stderr);sys.exit(1)\nprint(json.dumps({'login':${JSON.stringify(login)}} if sys.argv[2]=='user' else {'push':${push ? 'True' : 'False'}}))\n`, { mode: 0o700 })
  return spawnSync('python3', [resolve('scripts/relay-web.py'), '--home', join(dir, 'native-home'), '--repository', 'maintainer/project',
    '--github-cli', cli, '--agent-login', 'dedicated-bot', '--check-only'], { encoding: 'utf8', env: { ...process.env, GH_TOKEN: 'fake-personal-credential' } })
}
it('verifies a separate write identity without creating a profile and strips inherited personal tokens', () => {
  const result = preflight('dedicated-bot', true)
  expect(result.status).toBe(0); expect(result.stdout).toContain('repository Write access verified')
  expect(existsSync(join(dir, 'native-home'))).toBe(false)
})
it.each([['maintainer', true], ['dedicated-bot', false]] as const)('refuses a wrong identity or missing write permission (%s/%s)', (login, push) => {
  const result = preflight(login, push)
  expect(result.status).toBe(1)
  expect(result.stdout + result.stderr).not.toContain('fake-private-key')
  expect(result.stdout + result.stderr).not.toContain('fake-personal-credential')
})
it('sanitizes failed CLI stderr rather than exposing credentials', () => {
  const result = preflight('dedicated-bot', true, true)
  expect(result.status).toBe(1); expect(result.stderr).toContain('account check failed')
  expect(result.stdout + result.stderr).not.toContain('fake-private-key')
})
