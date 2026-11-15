/** Exercise the actual package inspector against benign and hostile tar members. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it } from 'vitest'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'relay-release-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function inspect(extra: { name: string; text?: string; type?: string }[] = [], removed = '', manifest?: object, secret?: string) {
  const archive = join(dir, 'candidate.tgz')
  const fixture = `import io,json,sys,tarfile
v=json.load(sys.stdin)
required=['package.json','README.md','LICENSE','CHANGELOG.md','cordis.patch.yml','lib/index.js','lib/index.d.ts','scripts/relay-web.py','scripts/relay-watchdog.py','scripts/verify-release.py','docs/011-native-implementation.md']
with tarfile.open(sys.argv[1],'w:gz') as bundle:
 for name in required:
  if name==v['removed']:continue
  content=json.dumps(v['manifest']).encode() if name=='package.json' else b'public runtime content'
  item=tarfile.TarInfo('package/'+name);item.size=len(content);bundle.addfile(item,io.BytesIO(content))
 for value in v['extra']:
  item=tarfile.TarInfo(value['name'])
  if value.get('type')=='symlink':item.type=tarfile.SYMTYPE;item.linkname='/private/credential';bundle.addfile(item)
  elif value.get('type')=='oversized':item.size=33*1024*1024;bundle.addfile(item,io.BytesIO(b' ' * item.size))
  else:
   content=value.get('text','').encode();item.size=len(content);bundle.addfile(item,io.BytesIO(content))
`
  const created = spawnSync('python3', ['-c', fixture, archive], { encoding: 'utf8', input: JSON.stringify({ extra, removed,
    manifest: manifest ?? { name: 'dsh-superagent-relay', version: '0.1.0' } }) })
  expect(created.status).toBe(0)
  const args = [resolve('scripts/verify-release.py'), archive, '--version', '0.1.0']
  if (secret) { const path = join(dir, 'private-credential'); writeFileSync(path, secret); args.push('--secret-file', path) }
  const result = spawnSync('python3', args, { encoding: 'utf8' })
  return { ...result, report: JSON.parse(result.stdout) as { passed: boolean; issues: string[]; version?: string; sha256?: string } }
}

it('accepts a complete package, verifies its version and returns its digest', () => {
  const result = inspect()
  expect(result.status).toBe(0)
  expect(result.report).toMatchObject({ passed: true, version: '0.1.0', issues: [] })
  expect(result.report.sha256).toMatch(/^[a-f0-9]{64}$/)
})
it.each(['package/../secret', '/private/secret', 'other/package.json', 'package/..\\secret'])('rejects unsafe member paths (%s)', name => {
  const result = inspect([{ name }])
  expect(result.status).toBe(1); expect(result.report.issues).toContain('unsafe_member_path')
})
it('rejects links and duplicate members before any extraction', () => {
  expect(inspect([{ name: 'package/link', type: 'symlink' }]).report.issues).toContain('unsafe_member_type')
  expect(inspect([{ name: 'package/README.md' }]).report.issues).toContain('duplicate_member')
})
it.each(['.env', '.env.production', 'hosts.yml', 'discord.json', 'web-cookies', 'node_modules/private.js'])('rejects private/generated archive contents (%s)', path => {
  expect(inspect([{ name: 'package/' + path }]).report.issues).toContain('private_or_generated_file')
})
it('rejects a missing launcher and wrong package/version', () => {
  expect(inspect([], 'scripts/relay-web.py').report.issues).toContain('missing_runtime_assets')
  expect(inspect([], '', { name: 'wrong-package', version: '0.2.0' }).report.issues).toEqual(expect.arrayContaining(['unexpected_package_name', 'version_mismatch']))
})
it('reports credential and home-path categories without exposing matched values or member names', () => {
  const secret = 'private-test-credential-that-must-never-print'
  const name = 'package/private-credential-location'
  const result = inspect([{ name, text: secret + '\n/home/private-operator/credential' }], '', undefined, secret)
  expect(result.report.issues).toEqual(expect.arrayContaining(['credential_match', 'developer_home_path']))
  expect(result.stdout + result.stderr).not.toContain(secret)
  expect(result.stdout + result.stderr).not.toContain(name)
  expect(result.stdout + result.stderr).not.toContain('private-operator')
})
it('rejects excessive unpacked sizes', () => {
  expect(inspect([{ name: 'package/bomb', type: 'oversized' }]).report.issues).toContain('unpacked_size_limit')
})
it('sanitizes missing-input failures', () => {
  const result = spawnSync('python3', [resolve('scripts/verify-release.py'), join(dir, 'private-missing-archive')], { encoding: 'utf8' })
  expect(result.status).toBe(1)
  expect(JSON.parse(result.stdout)).toEqual({ passed: false, issues: ['unreadable_or_invalid_input'] })
  expect(result.stdout + result.stderr).not.toContain(dir)
})
it('refuses to replace an input archive or credential with its output report', () => {
  inspect()
  const archive = join(dir, 'candidate.tgz'), original = readFileSync(archive)
  const credential = join(dir, 'credential'); writeFileSync(credential, 'private-input')
  for (const output of [archive, credential]) {
    const result = spawnSync('python3', [resolve('scripts/verify-release.py'), archive,
      '--secret-file', credential, '--output', output], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout).issues).toEqual(['output_overwrites_input'])
  }
  expect(readFileSync(archive)).toEqual(original)
  expect(readFileSync(credential, 'utf8')).toBe('private-input')
})
