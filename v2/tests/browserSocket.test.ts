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
import { Pause } from '../capture/pause.ts'
import { ServiceNormalizer } from '../capture/pipeline.ts'
import { DB_FILE, Store } from '../capture/store.ts'
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

test('host lines over the socket become page rows; control ops pause and report status', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dl-bs-'))
  const store = new Store(path.join(dir, 'data'))
  const privacy = new Privacy(store.exclusions())
  const pages = new BrowserPages(store, privacy)
  let socket: BrowserSocket
  let norm: ServiceNormalizer
  const pause = new Pause(store, {
    onChange: (s, at) => {
      norm.interrupt(at)
      socket.broadcast(statusMsg(s))
    },
  })
  norm = new ServiceNormalizer(store, privacy, pause, pages)
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
  c.sock.write('{"op":"pause","for":"until_resumed"}\n')
  await waitFor(() => c.got.some((m) => m.capture === 'paused'))
  c.sock.write(tabLine(2, Date.now() + 5, { url: 'https://example.com/while-paused', title: 'Paused page' }) + '\n')
  c.sock.write('{"op":"resume"}\n')
  await waitFor(() => c.got.filter((m) => m.capture === 'running').length >= 2)
  c.sock.end()
  await waitFor(() => logs.some((l) => l.startsWith('browser disconnected')))
  await socket.stop()
  store.close()

  const db = new Database(path.join(dir, 'data', DB_FILE), { readonly: true })
  const rows = db.prepare(`SELECT state, url, title FROM observations WHERE kind = 'page' ORDER BY id`).all()
  const gaps = db.prepare(`SELECT reason FROM capture_gaps WHERE reason = 'paused'`).all()
  db.close()
  assert.deepEqual(rows, [{ state: 'normal', url: 'https://example.com/q?search=plan', title: 'Plan' }])
  assert.equal(gaps.length, 1)
  assert.ok(logs.some((l) => l === 'browser line rejected reason=malformed'))
  assert.ok(logs.some((l) => l === 'browser line rejected reason=too_long'))
  const everything = readFileSync(path.join(dir, 'data', DB_FILE)).toString('latin1') + logs.join('\n')
  assert.ok(!everything.includes('while-paused') && !everything.includes('pw@') && !everything.includes('token=abc'))
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
