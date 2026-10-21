import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { BrowserPages } from '../capture/browser.ts'
import { BrowserSocket, statusMsg } from '../capture/browserSocket.ts'
import { Privacy } from '../capture/normalize.ts'
import { storagePause } from '../capture/pause.ts'
import { ServiceNormalizer } from '../capture/pipeline.ts'
import { DB_FILE, Store } from '../capture/store.ts'
import { Storage } from '../storage/index.ts'
import { app, focus } from './support/lines.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting')
    await sleep(10)
  }
}

const chrome = app('com.google.Chrome', { pid: 500, registered_browser: true, name: 'Google Chrome' })

function tabLine(seq: number, wall: number, obs: Record<string, unknown>): string {
  return JSON.stringify({
    v: 1, run: 'run-host', seq, boot: 'boot-test',
    t: { wall_ms: wall, mono_us: wall * 1000, tz: 'Africa/Kigali', tz_offset_min: 120 },
    platform: 'macos', source: 'browser_ext', kind: 'tab',
    obs: { trigger: 'activated', state: 'page', reason: null, browser: chrome, extension: 'abcdefghijklmnopabcdefghijklmnop', window: '1', tab: '2', url: 'https://example.com/', title: 'Example', ...obs },
  })
}

function client(p: string): Promise<{ sock: net.Socket; got: Record<string, unknown>[] }> {
  return new Promise((resolve, reject) => {
    const got: Record<string, unknown>[] = []
    const sock = net.connect(p)
    let buf = ''
    sock.setEncoding('utf8').on('data', (c: string) => {
      buf += c
      for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
        got.push(JSON.parse(buf.slice(0, nl)))
        buf = buf.slice(nl + 1)
      }
    })
    sock.once('connect', () => resolve({ sock, got }))
    sock.once('error', reject)
  })
}

test('host lines over the socket become page rows; storage pauses reach the host and refuse its lines', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dl-bs-'))
  const store = new Store(path.join(dir, 'data'))
  const storage = new Storage(store, path.join(dir, 'data'))
  const privacy = new Privacy(store.exclusions())
  const pages = new BrowserPages(store, privacy)
  const norm = new ServiceNormalizer(store, privacy, pages)
  storage.attachCapture({ interrupt: () => norm.interrupt({ wall_ms: Date.now(), mono_us: null, boot: null }), setPrivacy: (p) => { norm.setPrivacy(p); pages.setPrivacy(p) } })
  const pause = storagePause(storage)
  let socket: BrowserSocket
  storage.bus.on((c) => { if (c.kind === 'pause') socket.broadcast(statusMsg(pause.state())) })
  const logs: string[] = []
  socket = new BrowserSocket(pages, pause, { path: path.join(dir, 'b', 'browser.sock'), log: (m) => logs.push(m) })
  assert.ok(await socket.start())
  assert.equal(statSync(path.join(dir, 'b')).mode & 0o777, 0o700)
  assert.equal(statSync(socket.path).mode & 0o777, 0o600)

  const second = new BrowserSocket(pages, pause, { path: socket.path, log: (m) => logs.push(m) })
  assert.equal(await second.start(), false, 'a running listener is never stolen')

  const now = Date.now()
  norm.handle(focus(chrome, null, now, 'app_changed'))
  const c = await client(socket.path)
  await waitFor(() => c.got.length >= 1)
  assert.deepEqual(c.got[0], { op: 'status', capture: 'running', until_wall_ms: null })
  c.sock.write(tabLine(0, now + 10, { url: 'https://user:pw@example.com/q?search=plan&token=abc#x', title: 'Plan' }) + '\n')
  c.sock.write('{"v":1,"kind":"focus"}\n')
  c.sock.write('x'.repeat(20_000) + '\n')
  c.sock.write(tabLine(1, now + 20, { url: 'https://example.com/q?search=plan', title: 'Plan' }) + '\n')
  await waitFor(() => store.query(`SELECT 1 FROM observations WHERE kind = 'page'`).length > 0)

  storage.pause('until_resumed')
  await waitFor(() => c.got.some((m) => m.capture === 'paused'))
  c.sock.write(tabLine(2, Date.now() + 5, { url: 'https://example.com/while-paused', title: 'Paused page' }) + '\n')
  c.sock.write('{"op":"pause","for":"until_resumed"}\n')
  await waitFor(() => logs.includes('browser control rejected reason=unknown_op'))
  storage.resume()
  await waitFor(() => c.got.filter((m) => m.capture === 'running').length >= 2)

  c.sock.write(JSON.stringify({ op: 'browser_pause', until_wall_ms: null, browser: chrome }) + '\n')
  await waitFor(() => storage.pausedApps().length === 1)
  assert.equal(storage.paused(), null, 'pausing one browser pauses nothing else')
  norm.handle(focus(chrome, null, Date.now() + 10, 'app_changed'))
  c.sock.write(tabLine(3, Date.now() + 20, { url: 'https://example.com/browser-paused', title: 'Browser paused page' }) + '\n')
  c.sock.write(JSON.stringify({ op: 'browser_resume', browser: chrome }) + '\n')
  await waitFor(() => storage.pausedApps().length === 0)
  c.sock.write(JSON.stringify({ op: 'browser_pause', until_wall_ms: null, browser: { ...chrome, identity_state: 'gone', app_id: null } }) + '\n')
  await waitFor(() => logs.some((l) => l.startsWith('browser control failed op=browser_pause')))
  c.sock.end()
  await waitFor(() => logs.some((l) => l.startsWith('browser disconnected')))
  await socket.stop()
  storage.stop()
  store.close()

  const db = new Database(path.join(dir, 'data', DB_FILE), { readonly: true })
  const rows = db.prepare(`SELECT state, url, title FROM observations WHERE kind = 'page' AND state = 'normal' ORDER BY id`).all()
  const gaps = db.prepare(`SELECT reason FROM capture_gaps WHERE reason = 'paused'`).all()
  db.close()
  assert.deepEqual(rows, [{ state: 'normal', url: 'https://example.com/q?search=plan', title: 'Plan' }])
  assert.equal(gaps.length, 2, 'one gap for the pause of everything, one for the paused browser in front')
  assert.ok(logs.some((l) => l === 'browser line rejected reason=malformed'))
  assert.ok(logs.some((l) => l === 'browser line rejected reason=too_long'))
  const everything = readFileSync(path.join(dir, 'data', DB_FILE)).toString('latin1') + logs.join('\n')
  assert.ok(!everything.includes('while-paused') && !everything.includes('browser-paused') && !everything.includes('pw@') && !everything.includes('token=abc'))
})

test('a v2 database gains page addresses and site exclusions', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dl-mig-'))
  const db = new Database(path.join(dir, DB_FILE))
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version', '2'), ('exclusions_seeded', '1');
    CREATE TABLE capture_runs (run TEXT PRIMARY KEY);
    CREATE TABLE observations (id INTEGER PRIMARY KEY, run TEXT NOT NULL, seq INTEGER NOT NULL, boot TEXT NOT NULL, platform TEXT NOT NULL,
      source TEXT NOT NULL, kind TEXT NOT NULL, event_wall_ms INTEGER NOT NULL, event_mono_us INTEGER NOT NULL, tz TEXT NOT NULL,
      tz_offset_min INTEGER NOT NULL, recorded_wall_ms INTEGER NOT NULL, last_seen_wall_ms INTEGER NOT NULL, repeat_count INTEGER NOT NULL DEFAULT 0,
      app_id TEXT, app_name TEXT, app_path TEXT, pid INTEGER, window TEXT, title TEXT, title_raw TEXT, title_state TEXT, state TEXT, detail TEXT,
      possibly_stale_since_wall_ms INTEGER);
    INSERT INTO observations (run, seq, boot, platform, source, kind, event_wall_ms, event_mono_us, tz, tz_offset_min, recorded_wall_ms, last_seen_wall_ms)
      VALUES ('r', 0, 'b', 'macos', 's', 'focus', 1, 1, 'UTC', 0, 1, 1);
    CREATE TABLE exclusions (id INTEGER PRIMARY KEY, match TEXT NOT NULL CHECK (match IN ('app_id', 'exe')), value TEXT NOT NULL, label TEXT NOT NULL,
      is_default INTEGER NOT NULL, UNIQUE (match, value));
    INSERT INTO exclusions (match, value, label, is_default) VALUES ('app_id', 'com.1password.1password', '1Password', 1), ('exe', 'mine.exe', 'Mine', 0);
  `)
  db.close()
  const store = new Store(dir)
  const rules = store.exclusions()
  assert.ok(rules.some((r) => r.match === 'exe' && r.value === 'mine.exe'), 'user rules survive')
  assert.ok(rules.some((r) => r.match === 'site' && r.value === '1password.com'))
  assert.equal(store.meta('schema_version'), '4')
  assert.deepEqual(store.query(`SELECT url FROM observations`), [{ url: null }])
  store.close()
})

test('a database from the extension builds at version 3 opens, gains the run boot identity, and the pause that build kept ends', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dl-mig-ext-'))
  const T = 1_792_130_400_000
  new Store(dir, { now: () => T }).close()
  const db = new Database(path.join(dir, DB_FILE))
  db.exec(`
    ALTER TABLE capture_runs DROP COLUMN boot_identity;
    UPDATE meta SET value = '3' WHERE key = 'schema_version';
    INSERT INTO meta (key, value) VALUES ('pause', '{"since_wall_ms":${T},"until_wall_ms":null,"done":[]}');
    INSERT INTO capture_gaps (id, reason, scope, start_wall_ms) VALUES (1, 'paused', 'all', ${T}), (2, 'paused', 'all', ${T + 60_000});
  `)
  db.close()
  const store = new Store(dir, { now: () => T + 3_600_000 })
  assert.equal(store.meta('schema_version'), '4')
  assert.equal(store.meta('pause'), null, "the extension build's pause marker is gone")
  assert.deepEqual(store.query(`SELECT id, end_wall_ms FROM capture_gaps ORDER BY id`), [{ id: 1, end_wall_ms: T + 3_600_000 }, { id: 2, end_wall_ms: T + 3_600_000 }])
  assert.equal(store.query<{ n: number }>(`SELECT count(*) AS n FROM pragma_table_info('capture_runs') WHERE name = 'boot_identity'`)[0]!.n, 1)
  const storage = new Storage(store, dir, { now: () => T + 3_600_000 })
  assert.equal(storage.paused(), null, 'nothing is paused')
  storage.stop()
  store.close()
})
