import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { APP_CAPTURE_FLAGS } from '../capture/appFlags.ts'
import { DB_FILE } from '../capture/store.ts'
import { appsByName, readV1Privacy } from '../capture/v1Privacy.ts'
import { claude, claudeCtx } from './agents/fixtures.ts'
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

function startService(dataDir: string, work: string, env: Record<string, string> = {}, args: string[] = []): { proc: ChildProcess; log: () => string } {
  let log = ''
  const proc = spawn(process.execPath, [SERVICE, '--helper', process.execPath, '--helper-arg', FAKE, '--data-dir', dataDir, '--deletion-stall-ms', 'Infinity', '--heartbeat-s', '1', '--hang-after-s', '1.5', '--tick-ms', '100', ...args], {
    env: { ...process.env, FAKE_HB_MS: '100', FAKE_PIDFILE: path.join(work, 'pids'), FAKE_EOF_FILE: path.join(work, 'eof'), ...env },
    stdio: [WIN ? 'pipe' : 'ignore', 'ignore', 'pipe'],
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

const WIN = process.platform === 'win32'

async function stopService(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return
  const exited = new Promise((r) => proc.once('exit', r))
  // Windows has no SIGTERM (kill ends the process at once); the service stops cleanly when its stdin closes.
  if (WIN && proc.stdin) proc.stdin.end()
  else proc.kill('SIGTERM')
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
    stdio: [WIN ? 'pipe' : 'ignore', 'pipe', 'ignore'],
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
    stdio: [WIN ? 'pipe' : 'ignore', 'pipe', 'ignore'],
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

// Sleep is simulated by suspending processes with SIGSTOP, which Windows does not have.
const noStop = process.platform === 'win32' ? 'no SIGSTOP on Windows' : false

test('a whole-machine pause (service and helper suspended together) is not a hang', { skip: noStop }, async () => {
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

test('the same pause with no sleep reported is recorded as an unexplained helper stall', { skip: noStop }, async () => {
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
  const [helper] = helperPids(work)
  const alive = () => {
    try {
      process.kill(helper!, 0)
      return true
    } catch {
      return false
    }
  }
  // On Windows the helper can die writing to the broken pipe before it reads the end of its input.
  await waitFor(() => existsSync(path.join(work, 'eof')) || !alive(), 3000)
  const stoppedAt = existsSync(path.join(work, 'eof')) ? Number(readFileSync(path.join(work, 'eof'), 'utf8')) : Date.now()
  assert.ok(stoppedAt - killedAt < 1000, `helper exited ${stoppedAt - killedAt} ms after the service died`)
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

test('the stop op stops the service as cleanly as a signal: how the app stops capture in its utility process', async () => {
  const { work, dataDir } = setup()
  let log = ''
  const proc = spawn(process.execPath, [SERVICE, '--helper', process.execPath, '--helper-arg', FAKE, '--data-dir', dataDir, '--deletion-stall-ms', 'Infinity', '--heartbeat-s', '1', '--tick-ms', '100'], {
    env: { ...process.env, FAKE_HB_MS: '100', FAKE_PIDFILE: path.join(work, 'pids'), FAKE_EOF_FILE: path.join(work, 'eof') },
    stdio: ['pipe', 'ignore', 'pipe'],
  })
  proc.stderr!.setEncoding('utf8').on('data', (c: string) => (log += c))
  try {
    await waitFor(() => log.includes('helper hello'))
    const exited = new Promise<number | null>((r) => proc.once('exit', r))
    proc.stdin!.write(JSON.stringify({ op: 'stop' }) + '\n')
    assert.equal(await Promise.race([exited, sleep(5000).then(() => 'still running')]), 0)
  } finally {
    await stopService(proc)
  }
  assert.ok(log.includes('helper bye reason=shutdown'))
  const svc2 = startService(dataDir, work)
  await waitFor(() => svc2.log().includes('helper hello'))
  await stopService(svc2.proc)
  assert.equal(JSON.parse(gaps(dataDir).find((g) => g.reason === 'service_down')!.detail!).clean_stop, true)
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

function v1Config(appData: string, folder: string, config: Record<string, unknown>): void {
  mkdirSync(path.join(appData, folder), { recursive: true })
  writeFileSync(path.join(appData, folder, 'config.json'), JSON.stringify(config))
}

// V1's data folders: the Mac app's, then its older name; on Windows and Linux, the app's and the Windows build's.
const [V1_FOLDER, V1_OTHER_FOLDER] = process.platform === 'darwin' ? ['Daylens Desktop', 'Daylens'] : ['Daylens', 'DaylensWindows']

test('installed over V1, a new store starts paused with the exclusions V1 kept, and only a new store reads them', async () => {
  const { work, dataDir } = setup()
  const appData = path.join(work, 'appData')
  v1Config(appData, V1_FOLDER, {
    trackingPaused: true,
    trackingControlsEnabled: true,
    trackingExcludedApps: ['com.example.Notes'],
    trackingExcludedSites: ['https://www.example.org/inbox'],
  })
  // A folder whose tracking controls were off: V1 recorded its listed apps, so they don't carry.
  v1Config(appData, V1_OTHER_FOLDER, { trackingControlsEnabled: false, trackingExcludedApps: ['com.example.recorded'] })
  const rows = () => {
    const db = new Database(path.join(dataDir, DB_FILE), { readonly: true })
    try {
      return {
        carried: db.prepare('SELECT match, value FROM exclusions WHERE is_default = 0 ORDER BY match, value').all(),
        pauses: db.prepare('SELECT until_wall_ms, app_id FROM pauses WHERE ended_wall_ms IS NULL').all(),
        owed: db.prepare(`SELECT value FROM meta WHERE key = 'pause_owed'`).get(),
      }
    } finally {
      db.close()
    }
  }
  const svc = startService(dataDir, work, {}, ['--v1-app-data', appData])
  await waitFor(() => svc.log().includes('helper hello'))
  await stopService(svc.proc)
  assert.deepEqual(rows(), {
    carried: [{ match: 'app_id', value: 'com.example.Notes' }, { match: 'site', value: 'example.org' }],
    pauses: [{ until_wall_ms: null, app_id: null }],
    owed: undefined,
  })
  assert.ok(gaps(dataDir).some((g) => g.reason === 'paused' && g.end_wall_ms === null))

  v1Config(appData, V1_FOLDER, { trackingPaused: true, trackingControlsEnabled: true, trackingExcludedApps: ['com.example.later'] })
  const svc2 = startService(dataDir, work, {}, ['--v1-app-data', appData])
  await waitFor(() => svc2.log().includes('helper hello'))
  await stopService(svc2.proc)
  assert.deepEqual(rows().carried, [{ match: 'app_id', value: 'com.example.Notes' }, { match: 'site', value: 'example.org' }])
})

test('an app V1 excluded by name carries as the bundle id of the installed app with that name', { skip: process.platform !== 'darwin' }, () => {
  const work = tempDir('daylens-v2-v1apps-')
  const apps = path.join(work, 'Applications')
  mkdirSync(path.join(apps, 'Example Notes.app', 'Contents'), { recursive: true })
  writeFileSync(
    path.join(apps, 'Example Notes.app', 'Contents', 'Info.plist'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.notes</string></dict></plist>\n',
  )
  v1Config(path.join(work, 'appData'), 'Daylens Desktop', { trackingControlsEnabled: true, trackingExcludedApps: ['example notes', 'Not Installed'] })
  assert.deepEqual(readV1Privacy(path.join(work, 'appData'), 'darwin', appsByName([apps])), {
    paused: false,
    rules: [{ match: 'app_id', value: 'com.example.notes', label: 'example notes' }],
    unresolved: 1,
  })
})

// The name V1 saw is the one the app shows, which can differ from its file; Voice Memos is VoiceMemos.app.
test('an app V1 excluded by the name it shows carries even when its file is named differently', { skip: process.platform !== 'darwin' || !existsSync('/System/Applications/VoiceMemos.app') }, () => {
  assert.deepEqual(appsByName(['/System/Applications'])('Voice Memos'), ['com.apple.VoiceMemos'])
})

test('installed over a paused V1, browser history earlier that day is not read in: V1 recorded nothing then either', { skip: process.platform !== 'darwin' }, async () => {
  const { work, dataDir } = setup()
  const appData = path.join(work, 'appData')
  v1Config(appData, 'Daylens Desktop', { trackingPaused: true })
  const home = path.join(work, 'home')
  const chrome = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome')
  mkdirSync(path.join(chrome, 'Default'), { recursive: true })
  writeFileSync(path.join(chrome, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Invented' } } } }))
  const start = Date.now()
  const d = new Date(start)
  const visitAt = Math.max(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), start - 60_000)
  const hist = new Database(path.join(chrome, 'Default', 'History'))
  hist.exec(`
    CREATE TABLE urls (id INTEGER PRIMARY KEY AUTOINCREMENT, url LONGVARCHAR, title LONGVARCHAR, hidden INTEGER DEFAULT 0 NOT NULL);
    CREATE TABLE visits (id INTEGER PRIMARY KEY AUTOINCREMENT, url INTEGER NOT NULL, visit_time INTEGER NOT NULL, transition INTEGER DEFAULT 0 NOT NULL,
      originator_cache_guid TEXT DEFAULT '');
    CREATE TABLE visit_source (id INTEGER PRIMARY KEY, source INTEGER NOT NULL);
    INSERT INTO urls (url, title) VALUES ('https://garden.example/plan', 'Garden plan');
  `)
  hist.prepare('INSERT INTO visits (url, visit_time, transition) VALUES (1, ?, ?)').run(BigInt(visitAt) * 1000n + 11_644_473_600_000_000n, 0x30000000)
  hist.close()
  const read = () => {
    if (!existsSync(path.join(dataDir, DB_FILE))) return null
    const db = new Database(path.join(dataDir, DB_FILE), { readonly: true })
    try {
      // The file exists a moment before its tables do.
      if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'meta'`).get()) return null
      return {
        status: db.prepare(`SELECT value FROM meta WHERE key = 'history_browsers'`).get() as { value: string } | undefined,
        from: Number((db.prepare(`SELECT value FROM meta WHERE key = 'history_from_wall_ms'`).get() as { value: string } | undefined)?.value),
        visits: (db.prepare(`SELECT count(*) AS n FROM observations WHERE kind = 'visit'`).get() as { n: number }).n,
      }
    } finally {
      db.close()
    }
  }
  const svc = startService(dataDir, work, { DAYLENS_V2_HISTORY_HOME: home }, ['--v1-app-data', appData, '--browser-history'])
  try {
    await waitFor(() => read()?.status !== undefined)
  } finally {
    await stopService(svc.proc)
  }
  const r = read()!
  assert.ok(r.from >= start, 'history is read from the carried pause, not the start of the day')
  assert.equal(r.visits, 0)
})

test('started the way the app starts it, the service records agent sessions from the home folder', async () => {
  const { work, dataDir } = setup()
  const home = path.join(work, 'home')
  const c = claudeCtx()
  const project = path.join(home, '.claude', 'projects', '-w')
  mkdirSync(project, { recursive: true })
  const at = Date.now() - 60_000
  writeFileSync(path.join(project, `${c.session}.jsonl`), [claude.prompt(c, at, 'hi'), claude.assistant(c, at + 1000, 'end_turn')].map((l) => l + '\n').join(''))
  const env = { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') }
  const svc = startService(dataDir, work, env, [...APP_CAPTURE_FLAGS])
  const turns = () => {
    const db = new Database(path.join(dataDir, DB_FILE), { readonly: true })
    try {
      return (db.prepare('SELECT count(*) AS n FROM agent_turns WHERE session_id = ?').get(c.session) as { n: number }).n
    } catch {
      return 0
    } finally {
      db.close()
    }
  }
  try {
    await waitFor(() => existsSync(path.join(dataDir, DB_FILE)) && turns() > 0, 30_000)
    assert.equal(turns(), 1)
  } finally {
    await stopService(svc.proc)
  }
})

