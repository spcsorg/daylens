import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { DB_FILE } from '../capture/store.ts'
import { tempDir } from './support/tmp.ts'

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
  const proc = spawn(process.execPath, [SERVICE, '--helper', process.execPath, '--helper-arg', FAKE, '--data-dir', dataDir, '--deletion-stall-ms', 'Infinity', '--heartbeat-s', '1', '--hang-after-s', '1.5', '--tick-ms', '100'], {
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
  const work = tempDir('daylens-v2-svc-')
  return { work, dataDir: path.join(work, 'data') }
}

test('the service tells the app its capture health on stdout', async () => {
  const { work, dataDir } = setup()
  const proc = spawn(process.execPath, [SERVICE, '--helper', process.execPath, '--helper-arg', FAKE, '--data-dir', dataDir, '--deletion-stall-ms', 'Infinity', '--heartbeat-s', '1', '--tick-ms', '100'], {
    env: { ...process.env, FAKE_HB_MS: '100', FAKE_PIDFILE: path.join(work, 'pids'), FAKE_EOF_FILE: path.join(work, 'eof') },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  let out = ''
  proc.stdout!.setEncoding('utf8').on('data', (c: string) => (out += c))
  try {
    await waitFor(() => out.includes('"op":"capture_health"'))
    const line = JSON.parse(out.split('\n').find((l) => l.includes('capture_health'))!) as { store: Record<string, unknown> }
    assert.deepEqual(Object.keys(line.store).sort(), ['committedWallMs', 'contendedSinceWallMs', 'droppedOps', 'failingSinceWallMs', 'pendingOps', 'scrubPending'])
    assert.equal(line.store.droppedOps, 0)
    assert.equal(line.store.failingSinceWallMs, null)
  } finally {
    await stopService(proc)
  }
})

test('the service runs without being given a deletion stall time', async () => {
  const { work, dataDir } = setup()
  const proc = spawn(process.execPath, [SERVICE, '--helper', process.execPath, '--helper-arg', FAKE, '--data-dir', dataDir, '--heartbeat-s', '1', '--tick-ms', '100'], {
    env: { ...process.env, FAKE_HB_MS: '100', FAKE_PIDFILE: path.join(work, 'pids'), FAKE_EOF_FILE: path.join(work, 'eof') },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  let out = ''
  proc.stdout!.setEncoding('utf8').on('data', (c: string) => (out += c))
  try {
    await waitFor(() => out.includes('"op":"capture_health"') || proc.exitCode !== null)
    assert.equal(proc.exitCode, null)
  } finally {
    await stopService(proc)
  }
})

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

test('a staging copy left by a first read cut short is removed at startup, with agent access off', async () => {
  const { work, dataDir } = setup()
  mkdirSync(dataDir, { recursive: true })
  const leftovers = ['agent-backfill.sqlite', 'agent-backfill.sqlite-wal', 'agent-backfill.sqlite-shm'].map((f) => path.join(dataDir, f))
  for (const f of leftovers) writeFileSync(f, 'synthetic staging')
  const svc = startService(dataDir, work)
  await waitFor(() => svc.log().includes('helper hello'))
  await stopService(svc.proc)
  assert.deepEqual(leftovers.filter((f) => existsSync(f)), [])
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

async function rollbackOutage(boot: 'counter' | 'clock' | 'clockfixed', extra: Record<string, string> = {}): Promise<{ down: Gap; runs: { boot_identity: string }[] }> {
  const { work, dataDir } = setup()
  const svc = startService(dataDir, work, { FAKE_BOOT: boot })
  await waitFor(() => svc.log().includes('helper hello'))
  await sleep(1600)
  svc.proc.kill('SIGKILL')
  await sleep(2000)
  const svc2 = startService(dataDir, work, { FAKE_BOOT: boot, FAKE_WALL_OFFSET_MS: String(-3_600_000), ...extra })
  await waitFor(() => svc2.log().includes('helper hello'))
  await sleep(300)
  await stopService(svc2.proc)
  const db = new Database(path.join(dataDir, DB_FILE), { readonly: true })
  const runs = db.prepare('SELECT boot_identity FROM capture_runs ORDER BY id').all() as { boot_identity: string }[]
  db.close()
  return { down: gaps(dataDir).find((g) => g.reason === 'service_down')!, runs }
}

test('Windows boot identity: with the kernel boot counter, a clock set back an hour still shows the outage', async () => {
  const { down, runs } = await rollbackOutage('counter')
  const span = down.end_wall_ms! - down.start_wall_ms
  assert.ok(span >= 1900 && span < 6000, `outage ${span} ms`)
  assert.equal(JSON.parse(down.detail!).measured, 'monotonic')
  assert.ok(runs.every((r) => r.boot_identity === 'kernel'))
})

test('Windows boot identity fallback: health says degraded and the outage is recorded as uncertain, never zero', async () => {
  const { down, runs } = await rollbackOutage('clock')
  assert.ok(down.end_wall_ms! - down.start_wall_ms >= 1)
  const d = JSON.parse(down.detail!)
  assert.equal(d.measured, 'uncertain_boot')
  assert.equal(d.uncertain, true)
  assert.ok(runs.every((r) => r.boot_identity === 'clock'), 'each run records that its boot identity was degraded')
})

test('a reboot during an outage with the clock set back records at least the new boot uptime, never zero', async () => {
  const { down } = await rollbackOutage('counter', { FAKE_NEW_BOOT_UPTIME_MS: '90000' })
  const span = down.end_wall_ms! - down.start_wall_ms
  assert.ok(span >= 89_000 && span < 100_000, `outage ${span} ms`)
  const d = JSON.parse(down.detail!)
  assert.equal(d.measured, 'lower_bound_new_boot')
  assert.equal(d.wall_clock_moved_back, true)
})

test('matching clock-derived boot names through the supervisor: the SQLite row is uncertain and never zero-length', async () => {
  const { work, dataDir } = setup()
  const svc = startService(dataDir, work, { FAKE_BOOT: 'clockfixed' })
  await waitFor(() => svc.log().includes('helper hello'))
  await sleep(1600)
  svc.proc.kill('SIGKILL')
  await sleep(500)
  // Same clock-derived name and a larger uptime: from the helper's side this cannot be told from a reboot.
  const svc2 = startService(dataDir, work, { FAKE_BOOT: 'clockfixed' })
  await waitFor(() => svc2.log().includes('helper hello'))
  await sleep(300)
  await stopService(svc2.proc)
  const down = gaps(dataDir).find((g) => g.reason === 'service_down')!
  assert.ok(down.end_wall_ms! - down.start_wall_ms >= 1, 'never a zero-length row')
  const d = JSON.parse(down.detail!)
  assert.equal(d.uncertain, true)
  assert.notEqual(d.measured, 'monotonic')
})
