/** Real subprocess supervision: authenticated health, crash recovery and intentional shutdown. */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
let child: ChildProcess | undefined
let dir: string | undefined
const exit = (process: ChildProcess) => new Promise<void>(done => { if (process.exitCode !== null) done(); else process.once('exit', () => done()) })
afterEach(async () => {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await exit(child) }
  if (dir) rmSync(dir, { recursive: true, force: true })
  child = undefined; dir = undefined
})
it('recovers a crashed host, uses authenticated health, and does not restart after an intentional stop', async () => {
  dir = mkdtempSync(join(tmpdir(), 'relay-watchdog-'))
  const host = join(dir, 'host.py'), status = join(dir, 'relay-service-status.json')
  writeFileSync(host, `import http.server,json,os,sys,threading,time\nfrom pathlib import Path\nroot=Path(sys.argv[1]); marker=root/'starts'\ncount=int(marker.read_text())+1 if marker.exists() else 1\nmarker.write_text(str(count))\nclass Handler(http.server.BaseHTTPRequestHandler):\n def log_message(self,*args): pass\n def do_GET(self):\n  if self.path.startswith('/?token='):\n   self.send_response(200);self.send_header('Set-Cookie','session=test-session');self.end_headers();return\n  if self.headers.get('Cookie')!='session=test-session' or self.headers.get('x-orchestrator-request')!='1':\n   self.send_response(401);self.end_headers();return\n  (root/'authenticated').write_text('yes')\n  self.send_response(200);self.end_headers();self.wfile.write(json.dumps({'setup':{'accounts':{'agent':'bot'},'problem':None},'health':{'discord':{'state':'ready','detail':'private transcript must not persist'}}}).encode())\nserver=http.server.HTTPServer(('127.0.0.1',0),Handler)\nprint('http://127.0.0.1:'+str(server.server_port)+'/?token=test-auth-private',flush=True)\nif count==1: threading.Timer(1,lambda:os._exit(17)).start()\nserver.serve_forever()\n`)
  const script = `import importlib.util,os,sys\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('watchdog',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nsys.exit(m.supervise([sys.executable,sys.argv[2],sys.argv[3]],dict(os.environ),Path(sys.argv[3])))`
  child = spawn('python3', ['-c', script, resolve('scripts/relay-watchdog.py'), host, dir], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout!.on('data', chunk => { output += chunk.toString() }); child.stderr!.on('data', chunk => { output += chunk.toString() })
  await vi.waitFor(() => {
    expect(existsSync(status)).toBe(true)
    expect(JSON.parse(readFileSync(status, 'utf8'))).toMatchObject({ state: 'running', restart_count: 1, setup_ready: true })
    expect(Number(readFileSync(join(dir!, 'starts'), 'utf8'))).toBe(2)
  }, { timeout: 12000, interval: 100 })
  expect(existsSync(join(dir, 'authenticated'))).toBe(true)
  const snapshot = readFileSync(status, 'utf8')
  expect(snapshot + output).not.toContain('test-auth-private')
  expect(snapshot + output).not.toContain('private transcript')
  child.kill('SIGTERM'); await exit(child)
  expect(JSON.parse(readFileSync(status, 'utf8'))).toMatchObject({ state: 'stopped', intentional: true })
  expect(readFileSync(join(dir, 'starts'), 'utf8')).toBe('2')
}, 15000)
