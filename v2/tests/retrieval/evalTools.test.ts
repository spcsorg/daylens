import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { DB_FILE } from '../../capture/store.ts'
import { Reader } from '../../retrieval/reader.ts'
import { search } from '../../retrieval/search.ts'
import { MIN, T0, tmpDir } from '../storage/support.ts'

const V2 = path.resolve(import.meta.dirname, '../..')

// A V1 database with the tables the import reads: Notes for 5 min, then Dia on one page for 4 min, then the screen locks.
function v1Fixture(): string {
  const file = path.join(tmpDir(), 'daylens.sqlite')
  const db = new Database(file)
  db.exec(`
    CREATE TABLE app_sessions (id INTEGER PRIMARY KEY, bundle_id TEXT NOT NULL, app_name TEXT NOT NULL, start_time INTEGER NOT NULL, end_time INTEGER,
      duration_sec INTEGER NOT NULL DEFAULT 0, window_title TEXT, canonical_app_id TEXT);
    CREATE TABLE website_visits (id INTEGER PRIMARY KEY, domain TEXT NOT NULL, page_title TEXT, url TEXT, visit_time INTEGER NOT NULL, duration_sec INTEGER NOT NULL DEFAULT 0,
      browser_bundle_id TEXT, source TEXT NOT NULL DEFAULT 'history');
    CREATE TABLE activity_state_events (id INTEGER PRIMARY KEY, event_ts INTEGER NOT NULL, event_type TEXT NOT NULL);
  `)
  const s = db.prepare('INSERT INTO app_sessions (bundle_id, app_name, start_time, end_time, duration_sec, window_title, canonical_app_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
  s.run('com.apple.Notes', 'Notes', T0, T0 + 5 * MIN, 300, 'Quarterly budget notes', 'notes')
  s.run('/Applications/Dia.app/Contents/MacOS/Dia', 'Dia', T0 + 5 * MIN, T0 + 9 * MIN, 240, 'Secret tab title', 'dia')
  s.run('company.thebrowser.dia', 'Dia', T0 - 60 * MIN, T0 - 59 * MIN, 60, null, 'dia')
  db.prepare('INSERT INTO website_visits (domain, page_title, url, visit_time, duration_sec, browser_bundle_id, source) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'docs.example.com', 'Q4 forecast', 'https://docs.example.com/d/forecast?utm_source=x', T0 + 5 * MIN + 1000, 200, 'company.thebrowser.dia:Profile 2', 'chrome_history',
  )
  db.prepare('INSERT INTO activity_state_events (event_ts, event_type) VALUES (?, ?)').run(T0 + 9 * MIN, 'lock_screen')
  db.pragma('journal_mode = WAL')
  db.close()
  return file
}

const digest = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex')

test('the V1 import reads a copy, never changes V1, and builds V2 rows through import with time, pages and V2’s title rules', () => {
  const v1 = v1Fixture()
  const before = { hash: digest(v1), mtime: statSync(v1).mtimeMs }
  const out = tmpDir()
  const summary = JSON.parse(execFileSync(process.execPath, ['tools/importV1.ts', '--v1', v1, '--out', out], { cwd: V2, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as { imported: number }
  assert.ok(summary.imported > 0)
  assert.deepEqual({ hash: digest(v1), mtime: statSync(v1).mtimeMs }, before, 'V1 is unchanged')
  assert.deepEqual(readdirSync(out).filter((f) => f.startsWith('.v1-copy')), [], 'the copy is removed')

  const reader = Reader.open(path.join(out, DB_FILE))
  const [h] = reader.hours(T0, T0 + 60 * MIN)
  assert.deepEqual(h!.apps.map((a) => [a.app_id, a.ms]), [['com.apple.Notes', 5 * MIN], ['company.thebrowser.dia', 4 * MIN]])
  const page = h!.sources.find((s) => s.kind === 'page')!
  assert.deepEqual([page.url, page.title, page.ms], ['https://docs.example.com/d/forecast', 'Q4 forecast', 4 * MIN - 1000], 'addresses are cleaned as V2 cleans them')
  assert.ok(!JSON.stringify(h).includes('Secret tab title'), 'a browser window title is not kept')
  assert.equal(search(reader, 'budget', { perGroup: 3 }).windows[0]?.title, 'Quarterly budget notes')
  reader.close()

  const refused = spawnSync(process.execPath, ['tools/importV1.ts', '--v1', v1, '--out', path.join(os.homedir(), 'Projects', 'daylens-import-refusal-check')], { cwd: V2, encoding: 'utf8' })
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /syncs to a cloud drive/)
  assert.equal(existsSync(path.join(os.homedir(), 'Projects', 'daylens-import-refusal-check')), false)
})

test('the V1 import refuses an output folder that holds the V1 database, and replaces only its own database there', () => {
  const v1 = v1Fixture()
  const before = digest(v1)
  for (const name of [DB_FILE, 'daylens.sqlite']) {
    const dir = tmpDir()
    const inside = path.join(dir, name)
    copyFileSync(v1, inside)
    const refused = spawnSync(process.execPath, ['tools/importV1.ts', '--v1', inside, '--out', dir], { cwd: V2, encoding: 'utf8' })
    assert.notEqual(refused.status, 0, name)
    assert.match(refused.stderr, /holds the V1 database/)
    assert.equal(digest(inside), before, `${name}: V1 is still there, unchanged`)
  }
  const out = tmpDir()
  writeFileSync(path.join(out, `${DB_FILE}.backup`), 'mine')
  execFileSync(process.execPath, ['tools/importV1.ts', '--v1', v1, '--out', out], { cwd: V2, stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(readFileSync(path.join(out, `${DB_FILE}.backup`), 'utf8'), 'mine', 'a file that only starts with the name is not removed')
})

test('the search evaluation has no default queries folder: it must be named', () => {
  // A home with nothing in it, so nothing private can be read or written whatever the tool would default to.
  const home = tmpDir()
  const run = spawnSync(process.execPath, ['tools/evalSearch.ts'], { cwd: V2, encoding: 'utf8', env: { ...process.env, HOME: home } })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /--queries <folder> is required/)
  assert.deepEqual(readdirSync(home), [])
})

test('the search evaluation fails loudly when its private queries or database are missing', () => {
  const noQueries = spawnSync(process.execPath, ['tools/evalSearch.ts', '--queries', path.join(tmpDir(), 'missing')], { cwd: V2, encoding: 'utf8' })
  assert.equal(noQueries.status, 1)
  assert.match(noQueries.stderr, /no gold queries .* nothing was measured/)
  const dir = tmpDir()
  execFileSync('sh', ['-c', `printf '{"queries":[{"id":"q","style":"exact","query":"x","expect":[]}]}' > "${dir}/queries.json"`])
  const noDb = spawnSync(process.execPath, ['tools/evalSearch.ts', '--queries', dir, '--db', path.join(dir, 'none.sqlite')], { cwd: V2, encoding: 'utf8' })
  assert.equal(noDb.status, 1)
  assert.match(noDb.stderr, /no evaluation database .* nothing was measured/)
})
