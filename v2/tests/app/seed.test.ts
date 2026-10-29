// The demo world `npm run demo` starts on: whole days recorded, every past hour already written, so nothing calls an AI.
process.env.TZ = 'Etc/GMT+5'

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { pricing } from '../../app/tools/worlds.ts'
import { DB_FILE } from '../../capture/store.ts'

const HOUR = 3_600_000
// A Wednesday at 4:30 PM: today has its morning, lunch and part of the afternoon.
const NOW = new Date(2026, 6, 15, 16, 30)

test('the pricing world seeds whole written days, history-only hours included', () => {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'daylens-seed-')), 'data')
  execFileSync(process.execPath, [path.join(import.meta.dirname, '../../app/tools/seed.ts'), '--data-dir', dir, '--now', NOW.toISOString()], { env: process.env, stdio: 'ignore' })
  const db = new Database(path.join(dir, DB_FILE), { readonly: true })
  const starts = Array.from({ length: 24 }, (_, i) => new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 23 + i))
  const world = pricing(starts.map((d) => d.getDay()))

  const due = world.flatMap((day, i) => day.flatMap((h) => ('away' in h || starts[i]!.getTime() + (h.hour + 1) * HOUR > NOW.getTime() ? [] : [starts[i]!.getTime() + h.hour * HOUR])))
  const written = db.prepare(`SELECT start_wall_ms AS s FROM hours WHERE status = 'written' ORDER BY s`).all() as { s: number }[]
  assert.deepEqual(written.map((r) => r.s), due)

  // Each day's recorded time is its working hours to the minute: nothing runs past the last hour or is lost to the night.
  for (const [i, day] of world.entries()) {
    const from = starts[i]!.getTime()
    const worked = day.filter((h) => !('away' in h) && !h.history).reduce((n, h) => n + Math.max(0, Math.min(HOUR, NOW.getTime() - (from + h.hour * HOUR))), 0)
    const { ms } = db.prepare('SELECT coalesce(sum(end_wall_ms - start_wall_ms), 0) AS ms FROM intervals WHERE start_wall_ms >= ? AND start_wall_ms < ?').get(from, from + 24 * HOUR) as { ms: number }
    // Today's window still in front ends at its last report, up to a minute before now.
    assert.ok(ms <= worked && worked - ms <= (i === world.length - 1 ? 60_000 : 0), `day ${i}: ${ms} of ${worked}`)
  }

  const visits = db.prepare(`SELECT count(*) AS n FROM observations WHERE source = 'browser_history'`).get() as { n: number }
  assert.ok(visits.n >= 7, 'today and one evening come from browser history')
})

test('seeded before the day starts, today has no run yet, only what the browser history holds', () => {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'daylens-seed-')), 'data')
  const now = new Date(2026, 6, 15, 8, 40)
  execFileSync(process.execPath, [path.join(import.meta.dirname, '../../app/tools/seed.ts'), '--data-dir', dir, '--now', now.toISOString()], { env: process.env, stdio: 'ignore' })
  const db = new Database(path.join(dir, DB_FILE), { readonly: true })
  const late = db.prepare('SELECT count(*) AS n FROM capture_runs WHERE started_wall_ms > ?').get(now.getTime()) as { n: number }
  assert.equal(late.n, 0)
  const today = db.prepare(`SELECT count(*) AS n FROM observations WHERE source = 'browser_history' AND event_wall_ms >= ?`).get(new Date(2026, 6, 15).getTime()) as { n: number }
  assert.equal(today.n, 4)
})
