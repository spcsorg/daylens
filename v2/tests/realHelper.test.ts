// Kill, hang and contract tests against the real macOS helper. Skipped when it is not built.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { parseLine } from '../capture/protocol.ts'
import { DB_FILE } from '../capture/store.ts'
import { tempDir } from './support/tmp.ts'

const HELPER = fileURLToPath(new URL('../native/macos/.build/release/daylens-capture-macos', import.meta.url))
const SERVICE = fileURLToPath(new URL('../capture/service.ts', import.meta.url))
const skip = process.platform !== 'darwin' || !existsSync(HELPER) ? 'real macOS helper not built' : false
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting')
    await sleep(50)
  }
}

function helperPid(servicePid: number): number | null {
  try {
    return Number(execFileSync('pgrep', ['-P', String(servicePid), '-f', 'daylens-capture-macos']).toString().trim().split('\n')[0]) || null
  } catch {
    return null
  }
}

function startService(dataDir: string, env: Record<string, string> = {}, args: string[] = []): { proc: ChildProcess; log: () => string } {
  let log = ''
  const proc = spawn(process.execPath, [SERVICE, '--helper', HELPER, '--data-dir', dataDir, '--deletion-stall-ms', 'Infinity', '--heartbeat-s', '1', '--hang-after-s', '3', '--tick-ms', '200', ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ...env },
  })
  proc.stderr!.setEncoding('utf8').on('data', (c: string) => (log += c))
  return { proc, log: () => log }
}

async function stop(proc: ChildProcess): Promise<void> {
  const exited = new Promise((r) => proc.once('exit', r))
  proc.kill('SIGTERM')
  await exited
}

function gaps(dir: string): { reason: string; start_wall_ms: number; end_wall_ms: number | null; detail: string | null }[] {
  const db = new Database(path.join(dir, DB_FILE), { readonly: true })
  try {
    return db.prepare('SELECT reason, start_wall_ms, end_wall_ms, detail FROM capture_gaps ORDER BY id').all() as never
  } finally {
    db.close()
  }
}

test('every line the real helper writes passes the protocol validator', { skip }, async () => {
  const proc = spawn(HELPER, ['--heartbeat-s', '1'], { stdio: ['pipe', 'pipe', 'ignore'] })
  let out = ''
  proc.stdout!.setEncoding('utf8').on('data', (c: string) => (out += c))
  await sleep(2500)
  proc.stdin!.write('{"op":"snapshot"}\n')
  await sleep(500)
  proc.stdin!.write('{"op":"shutdown"}\n')
  await new Promise((r) => proc.once('exit', r))
  const lines = out.split('\n').filter(Boolean)
  const kinds = new Set<string>()
  lines.forEach((l, i) => {
    const r = parseLine(l)
    assert.ok(r.ok, `line ${i}: ${r.ok ? '' : r.reason + ' ' + r.detail}`)
    if (r.ok) {
      assert.equal(r.line.seq, i, 'seq is contiguous')
      kinds.add(r.line.kind)
    }
  })
  for (const k of ['hello', 'heartbeat', 'focus', 'input', 'session', 'bye']) assert.ok(kinds.has(k), `missing ${k}`)
})

test('closing stdin makes the real helper exit at once', { skip }, async () => {
  const proc = spawn(HELPER, [], { stdio: ['pipe', 'ignore', 'ignore'] })
  await sleep(500)
  const t = Date.now()
  proc.stdin!.end()
  await new Promise((r) => proc.once('exit', r))
  assert.ok(Date.now() - t < 1000)
})

test('kill -9 of the real helper: crash gap, restart, recovery', { skip }, async () => {
  const dir = tempDir('daylens-v2-real-')
  const svc = startService(dir)
  await waitFor(() => svc.log().includes('helper hello'))
  await sleep(1500)
  const pid = helperPid(svc.proc.pid!)!
  process.kill(pid, 'SIGKILL')
  await waitFor(() => (svc.log().match(/helper hello/g) ?? []).length >= 2)
  await sleep(1500)
  const next = helperPid(svc.proc.pid!)
  assert.ok(next !== null && next !== pid)
  await stop(svc.proc)
  const crash = gaps(dir).find((g) => g.reason === 'helper_crashed')!
  assert.ok(crash && crash.end_wall_ms !== null)
  assert.equal(JSON.parse(crash.detail!).signal, 'SIGKILL')
  assert.ok(crash.end_wall_ms - crash.start_wall_ms < 5000, `recovered in ${crash.end_wall_ms - crash.start_wall_ms} ms`)
})

test('a frozen real helper (SIGSTOP) is detected as hung, replaced, and the gap explained', { skip }, async () => {
  const dir = tempDir('daylens-v2-real-')
  const svc = startService(dir)
  await waitFor(() => svc.log().includes('helper hello'))
  await sleep(1500)
  const pid = helperPid(svc.proc.pid!)!
  process.kill(pid, 'SIGSTOP')
  await waitFor(() => svc.log().includes('helper hung') && (svc.log().match(/helper hello/g) ?? []).length >= 2)
  await sleep(1500)
  await stop(svc.proc)
  const hung = gaps(dir).find((g) => g.reason === 'helper_hung')!
  assert.ok(hung && hung.end_wall_ms !== null)
  const span = hung.end_wall_ms - hung.start_wall_ms
  assert.ok(span >= 3000 && span < 10_000, `gap ${span} ms`)
  assert.ok(gaps(dir).every((g) => g.reason !== 'helper_crashed'), 'a hang kill is not also counted as a crash')
})

test('a real helper whose title worker is stuck while its main loop lives is restarted, with a bounded titles gap', { skip }, async () => {
  const dir = tempDir('daylens-v2-real-')
  const svc = startService(dir, { DAYLENS_CAPTURE_FAULT: 'block_titles' })
  await waitFor(() => svc.log().includes('title worker stuck') && (svc.log().match(/helper hello/g) ?? []).length >= 2)
  await sleep(500)
  await stop(svc.proc)
  const all = gaps(dir)
  const hung = all.find((g) => g.reason === 'helper_hung')!
  assert.equal(JSON.parse(hung.detail!).channel, 'titles')
  const titles = all.find((g) => g.reason === 'titles_unavailable')!
  assert.ok(titles && titles.end_wall_ms !== null, 'titles gap is closed when the new helper says hello')
  assert.ok(titles.end_wall_ms - titles.start_wall_ms < 8000, `titles gap ${titles.end_wall_ms - titles.start_wall_ms} ms`)
})

test('the real helper tells installed browsers from Electron and CEF apps by their own files', { skip }, () => {
  const expected: Record<string, string> = {
    '/Users/tonny/Applications/Daylens Test Browsers/Google Chrome for Testing.app': 'browser',
    '/Users/tonny/Applications/Daylens Test Browsers/Firefox.app': 'browser',
    '/Applications/Dia.app': 'browser',
    '/Applications/Claude.app': 'app_runtime',
    '/Applications/Daylens.app': 'app_runtime',
    '/Applications/Spotify.app': 'app_runtime',
    '/System/Applications/TextEdit.app': 'none',
    '/Applications/Does Not Exist.app': 'unknown',
  }
  const present = Object.keys(expected).filter((p) => existsSync(p) || p.includes('Does Not Exist'))
  const out = execFileSync(HELPER, ['--classify', ...present]).toString().trim().split('\n')
  const got = Object.fromEntries(out.map((l) => l.split('\t').reverse()))
  for (const p of present) assert.equal(got[p], expected[p], p)
  assert.ok(present.length >= 4, 'enough real bundles to mean something')
})

test('the real helper reports the OS-verified Team ID of a running signed app, and none for platform code', { skip }, async () => {
  const out = (pid: number | string) => execFileSync(HELPER, ['--signer', String(pid)]).toString().trim().split('\t')[0]
  const codesignTeam = /TeamIdentifier=(\S+)/.exec(spawnSync('codesign', ['-dv', process.execPath]).stderr.toString())?.[1]
  const expected = codesignTeam && codesignTeam !== 'not' ? codesignTeam : '-'
  assert.equal(out(process.pid), expected, 'the same Team ID codesign reports for this node binary')
  const sleeper = spawn('/bin/sleep', ['5'])
  await sleep(100)
  try {
    assert.equal(out(sleeper.pid!), '-', 'Apple platform binaries carry no Team ID')
  } finally {
    sleeper.kill()
  }
  let claude: string | undefined
  try {
    claude = execFileSync('pgrep', ['-x', 'Claude']).toString().trim().split('\n')[0]
  } catch {}
  if (claude) assert.equal(out(claude), 'Q6L2SF6YDW', 'Claude, signed by Anthropic')
})

test('with the real helper, a window kept in front stays recorded past its focus line, heartbeat by heartbeat', { skip }, async (t) => {
  const dir = tempDir('daylens-v2-steady-')
  // Idle never starts in this run, whoever is at this Mac.
  const { proc } = startService(dir, {}, ['--idle-threshold-s', '86400'])
  const started = Date.now()
  try {
    await sleep(6000)
  } finally {
    await stop(proc)
  }
  const db = new Database(path.join(dir, DB_FILE), { readonly: true })
  const rows = db.prepare(`SELECT event_wall_ms, last_seen_wall_ms FROM observations WHERE kind = 'focus' AND event_wall_ms >= ?`).all(started) as { event_wall_ms: number; last_seen_wall_ms: number }[]
  const stopped = db.prepare(`SELECT 1 FROM observations WHERE (kind = 'session' AND state IN ('locked', 'console_disconnect', 'remote_disconnect', 'logoff')) OR (kind = 'power' AND state IN ('sleep', 'display_off'))`).get()
  db.close()
  rmSync(dir, { recursive: true, force: true })
  if (stopped) return t.skip('the screen was locked, dark or asleep during the run')
  const covered = rows.reduce((n, r) => n + (r.last_seen_wall_ms - r.event_wall_ms), 0)
  assert.ok(rows.length > 0)
  assert.ok(covered >= 3000, `focus rows cover ${covered} ms of a 6 s run (${rows.length} rows)`)
})

test('the real helper is responsible for itself, so window-title access is granted to it and not to node', { skip }, async () => {
  const proc = spawn(HELPER, ['--heartbeat-s', '1'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  proc.stdout!.setEncoding('utf8').on('data', (c: string) => (out += c))
  proc.stderr!.setEncoding('utf8').on('data', (c: string) => (err += c))
  try {
    await waitFor(() => out.includes('"kind":"hello"'))
    const hello = parseLine(out.split('\n')[0]!)
    assert.ok(hello.ok && hello.line.kind === 'hello')
    assert.equal(hello.line.obs.pid, proc.pid, 'the helper re-executes in place: node still holds its pid and pipes')
    const responsible = Object.fromEntries(
      execFileSync(HELPER, ['--responsible-pid', String(proc.pid), String(process.pid)], { timeout: 10_000 }).toString().trim().split('\n').map((l) => l.split('\t').reverse()),
    )
    assert.equal(responsible[String(proc.pid)], String(proc.pid))
    assert.notEqual(responsible[String(process.pid)], String(proc.pid))
    assert.doesNotMatch(err, /responsibility=/)
  } finally {
    proc.stdin!.write('{"op":"shutdown"}\n')
    await new Promise((r) => proc.once('exit', r))
  }
})
