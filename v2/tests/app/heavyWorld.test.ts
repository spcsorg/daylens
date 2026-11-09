// The heavy-user world the speed budgets are measured on, at a reduced number of days: its shape, and that it seeds the
// same database every time.
process.env.TZ = 'America/Phoenix'

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { DB_FILE } from '../../capture/store.ts'
import { tempDir } from '../support/tmp.ts'

const HOUR = 3_600_000
const DAYS = 3
// 2:30 PM in Phoenix: two whole days, and today up to the middle of its seventh hour.
const NOW = new Date(2030, 2, 14, 14, 30)
const dayStart = (i: number) => new Date(2030, 2, 14 - (DAYS - 1) + i).getTime()

function seed(): string {
  const dir = path.join(tempDir('daylens-heavy-'), 'data')
  // A different host timezone: the world pins its own.
  execFileSync(process.execPath, [path.join(import.meta.dirname, '../../app/tools/seed.ts'), '--data-dir', dir, '--world', 'heavy', '--days', String(DAYS), '--now', NOW.toISOString()], { env: { ...process.env, TZ: 'Asia/Kolkata' }, stdio: 'ignore' })
  return path.join(dir, DB_FILE)
}

// Every ordinary table's rows, sorted, hashed; virtual tables are covered by their shadow tables.
function contents(file: string): Record<string, string> {
  const db = new Database(file, { readonly: true })
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name`).all() as { name: string }[]
  const out = Object.fromEntries(
    tables.map(({ name }) => {
      const rows = (db.prepare(`SELECT * FROM "${name}"`).raw().all() as unknown[][]).map((r) => JSON.stringify(r, (_, v) => (Buffer.isBuffer(v) ? v.toString('hex') : v))).sort()
      return [name, `${rows.length} ${createHash('sha256').update(rows.join('\n')).digest('hex')}`]
    }),
  )
  db.close()
  return out
}

test('the heavy world: 12 recorded hours a day, 40 apps, 3,000 page visits a day, agent sessions, past hours written', () => {
  const db = new Database(seed(), { readonly: true })
  const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n

  for (let i = 0; i < DAYS; i++) {
    const from = dayStart(i)
    const until = i === DAYS - 1 ? NOW.getTime() : from + 24 * HOUR
    const { first, last, ms } = db.prepare('SELECT min(start_wall_ms) AS first, max(end_wall_ms) AS last, sum(end_wall_ms - start_wall_ms) AS ms FROM intervals WHERE start_wall_ms >= ? AND start_wall_ms < ?').get(from, from + 24 * HOUR) as { first: number; last: number; ms: number }
    assert.equal(first, from + 8 * HOUR, `day ${i} starts at 8`)
    if (i < DAYS - 1) {
      assert.equal(last, from + 20 * HOUR, `day ${i} ends at 8 PM`)
      assert.equal(ms, 12 * HOUR, `day ${i} is 12 recorded hours`)
      assert.equal(count(`SELECT count(*) AS n FROM observations WHERE kind = 'page' AND source = 'browser_ext' AND event_wall_ms >= ? AND event_wall_ms < ?`, from, until), 3000, `day ${i} visits`)
    } else {
      // Today's window still in front ends at its last report, up to a minute before now.
      assert.ok(ms <= until - first && until - first - ms <= 60_000, `today: ${ms}`)
      assert.ok(count(`SELECT count(*) AS n FROM observations WHERE kind = 'page' AND event_wall_ms >= ?`, from) > 1000)
      assert.equal(count('SELECT count(*) AS n FROM observations WHERE event_wall_ms > ?', until), 0, 'nothing after now')
    }
    const written = db.prepare(`SELECT start_wall_ms AS s FROM hours WHERE status = 'written' AND start_wall_ms >= ? AND start_wall_ms < ? ORDER BY s`).all(from, from + 24 * HOUR) as { s: number }[]
    const due = Array.from({ length: 12 }, (_, h) => from + (8 + h) * HOUR).filter((s) => s + HOUR <= until)
    assert.deepEqual(written.map((r) => r.s), due, `day ${i}: every finished hour is written`)
    assert.ok(count('SELECT count(*) AS n FROM agent_turns WHERE start_wall_ms >= ? AND start_wall_ms < ?', from, until) > 0, `day ${i} has agent turns`)
  }

  assert.equal(count(`SELECT count(DISTINCT app_id) AS n FROM observations`), 40)
  assert.ok(count('SELECT count(DISTINCT session_id) AS n FROM agent_sessions') >= DAYS)
  assert.equal(count(`SELECT count(DISTINCT agent) AS n FROM agent_sessions`), 2, 'Claude Code and Codex')
  // Invented pages only: every address is on a reserved example domain.
  const urls = (db.prepare(`SELECT DISTINCT url FROM observations WHERE url IS NOT NULL`).all() as { url: string }[]).map((r) => new URL(r.url).hostname)
  assert.ok(urls.length > 50)
  assert.deepEqual(urls.filter((h) => !h.endsWith('.example')), [])
  db.close()
})

test('the heavy world seeds the same database twice', () => {
  const [a, b] = [contents(seed()), contents(seed())]
  assert.ok(Number(a.observations!.split(' ')[0]) > 6000)
  assert.deepEqual(a, b)
})
