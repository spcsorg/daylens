import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { DB_FILE } from '../capture/store.ts'

const SERVICE = fileURLToPath(new URL('../capture/service.ts', import.meta.url))
const FAKE = fileURLToPath(new URL('./support/fakeHelper.ts', import.meta.url))

interface Gap {
  reason: string
  start_wall_ms: number
  end_wall_ms: number | null
  detail: string | null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting')
    await sleep(25)
  }
}

function startService(dataDir: string, work: string, env: Record<string, string> = {}): { proc: ChildProcess; log: () => string } {
  let log = ''
  const proc = spawn(process.execPath, [SERVICE, '--helper', process.execPath, '--helper-arg', FAKE, '--data-dir', dataDir, '--heartbeat-s', '1', '--hang-after-s', '1.5', '--tick-ms', '100'], {
    env: { ...process.env, FAKE_HB_MS: '100', FAKE_PIDFILE: path.join(work, 'pids'), FAKE_EOF_FILE: path.join(work, 'eof'), ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  proc.stderr!.setEncoding('utf8').on('data', (c: string) => (log += c))
  return { proc, log: () => log }
}

function helperPids(work: string): number[] {
  const f = path.join(work, 'pids')
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map(Number) : []
}

function gaps(dataDir: string): Gap[] {
  const db = new Database(path.join(dataDir, DB_FILE), { readonly: true })
  try {
    return db.prepare('SELECT reason, start_wall_ms, end_wall_ms, detail FROM capture_gaps ORDER BY id').all() as Gap[]
  } finally {
    db.close()
  }
}

async function stopService(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return
  const exited = new Promise((r) => proc.once('exit', r))
  proc.kill('SIGTERM')
  await exited
}

function setup() {
  const work = mkdtempSync(path.join(os.tmpdir(), 'daylens-v2-svc-'))
  return { work, dataDir: path.join(work, 'data') }
}

test('a whole-machine pause (service and helper suspended together) is not a hang', async () => {
  const { work, dataDir } = setup()
  const svc = startService(dataDir, work)
  await waitFor(() => svc.log().includes('helper hello'))
  await sleep(300)
  const [helper] = helperPids(work)
  process.kill(helper!, 'SIGUSR1')
  await sleep(100)
  process.kill(svc.proc.pid!, 'SIGSTOP')
  process.kill(helper!, 'SIGSTOP')
  await sleep(3500)
  process.kill(helper!, 'SIGUSR2')
  process.kill(helper!, 'SIGCONT')
  process.kill(svc.proc.pid!, 'SIGCONT')
  await sleep(2500)
  assert.deepEqual(helperPids(work), [helper], 'helper was not restarted')
  assert.ok(!svc.log().includes('helper hung'))
  await stopService(svc.proc)
  assert.deepEqual(gaps(dataDir).map((g) => g.reason), ['service_starting'], 'sleep reported by the helper leaves no capture gap')
})

test('the same pause with no sleep reported is recorded as an unexplained helper stall', async () => {
  const { work, dataDir } = setup()
  const svc = startService(dataDir, work)
  await waitFor(() => svc.log().includes('helper hello'))
  await sleep(300)
  const [helper] = helperPids(work)
  process.kill(svc.proc.pid!, 'SIGSTOP')
  process.kill(helper!, 'SIGSTOP')
  await sleep(3500)
  process.kill(helper!, 'SIGCONT')
  process.kill(svc.proc.pid!, 'SIGCONT')
  await sleep(1500)
  assert.deepEqual(helperPids(work), [helper], 'no false hang')
  await stopService(svc.proc)
  const stalled = gaps(dataDir).filter((g) => g.reason === 'helper_stalled')
  assert.equal(stalled.length, 1)
  assert.ok(stalled[0]!.end_wall_ms! - stalled[0]!.start_wall_ms >= 3000)
})

test('killing the service stops the helper and the next start records an unclean service_down gap', async () => {
  const { work, dataDir } = setup()
  const svc = startService(dataDir, work)
  await waitFor(() => svc.log().includes('helper hello'))
  await sleep(1500)
  const killedAt = Date.now()
  svc.proc.kill('SIGKILL')
  await waitFor(() => existsSync(path.join(work, 'eof')), 3000)
  const eofAt = Number(readFileSync(path.join(work, 'eof'), 'utf8'))
  assert.ok(eofAt - killedAt < 1000, `helper exited ${eofAt - killedAt} ms after the service died`)
  await sleep(1000)
  const svc2 = startService(dataDir, work)
  await waitFor(() => svc2.log().includes('helper hello'))
  await stopService(svc2.proc)
  const down = gaps(dataDir).find((g) => g.reason === 'service_down')!
  assert.equal(JSON.parse(down.detail!).clean_stop, false)
  assert.ok(down.start_wall_ms <= killedAt && killedAt - down.start_wall_ms < 2000, 'starts at the last committed heartbeat')
  assert.ok(down.end_wall_ms! > killedAt + 900)
})

test('a clean stop and restart records a clean service_down gap with no overlap', async () => {
  const { work, dataDir } = setup()
  const svc = startService(dataDir, work)
  await waitFor(() => svc.log().includes('helper hello'))
  await sleep(500)
  await stopService(svc.proc)
  assert.ok(svc.log().includes('helper bye reason=shutdown'))
  const svc2 = startService(dataDir, work)
  await waitFor(() => svc2.log().includes('helper hello'))
  await stopService(svc2.proc)
  const g = gaps(dataDir)
  assert.deepEqual(g.map((x) => x.reason), ['service_starting', 'service_down'])
  assert.equal(JSON.parse(g[1]!.detail!).clean_stop, true)
  assert.ok(g[1]!.start_wall_ms >= g[0]!.end_wall_ms!, 'gaps do not overlap')
  assert.ok(g.every((x) => x.end_wall_ms !== null))
})

test('downtime after a crash is measured even when the clock was set back an hour meanwhile', async () => {
  const { work, dataDir } = setup()
  const svc = startService(dataDir, work)
  await waitFor(() => svc.log().includes('helper hello'))
  await sleep(1600)
  svc.proc.kill('SIGKILL')
  await sleep(2000)
  const svc2 = startService(dataDir, work, { FAKE_WALL_OFFSET_MS: String(-3_600_000) })
  await waitFor(() => svc2.log().includes('helper hello'))
  await sleep(300)
  await stopService(svc2.proc)
  const down = gaps(dataDir).find((g) => g.reason === 'service_down')!
  const span = down.end_wall_ms! - down.start_wall_ms
  assert.ok(span >= 1900 && span < 6000, `the ~2 s outage is recorded, not collapsed by the rollback (${span} ms)`)
  assert.equal(JSON.parse(down.detail!).measured, 'monotonic')
})
