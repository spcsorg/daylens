// Ask with no AI, on the demo's pricing world: each of Ask's example questions shows the hours of the time it names.
process.env.TZ = 'Etc/GMT+5'

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { test } from 'node:test'
import { DB_FILE } from '../../capture/store.ts'
import { ask, type AskLog } from '../../retrieval/ask.ts'
import { Reader } from '../../retrieval/reader.ts'
import { Reader as Today, dateOf } from '../../app/reader/queries.ts'
import { historyLines, kindOf } from '../../app/renderer/src/screens/today/rows.ts'
import { factsTitle } from '../../app/renderer/src/lib/format.ts'
import { tempDir } from '../support/tmp.ts'

// A Wednesday at 4:30 PM: today has its morning, and yesterday a whole working day.
const NOW = new Date(2026, 6, 15, 16, 30)
const LIMITS = { maxHours: 12, maxSources: 40, perGroup: 8 }
const at = (dayOffset: number, hour: number) => new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + dayOffset, hour).getTime()

test('with no AI, each of Ask’s example questions shows the hours of the time it names, with their titles', async () => {
  const dir = path.join(tempDir('daylens-asknokey-'), 'data')
  execFileSync(process.execPath, [path.join(import.meta.dirname, '../../app/tools/seed.ts'), '--data-dir', dir, '--now', NOW.toISOString()], { env: process.env, stdio: 'ignore' })
  const reader = Reader.open(path.join(dir, DB_FILE))
  const log: AskLog = {
    recordRead: () => assert.fail('nothing is sent with no AI'),
    recordUsage: () => assert.fail('nothing is charged with no AI'),
  }
  const examples: [string, number, number][] = [
    ['What did I do this morning?', at(0, 0), at(0, 12)],
    ['What did I work on yesterday afternoon?', at(-1, 12), at(-1, 18)],
    ['What took most of my time yesterday?', at(-1, 0), at(0, 0)],
  ]
  for (const [question, from, to] of examples) {
    const res = await ask(question, { reader, model: null, log, now: () => NOW.getTime() }, LIMITS)
    assert.equal(res.kind, 'search_only', question)
    const hours = res.results.hours
    assert.ok(hours.length > 0, `${question}: no hours shown`)
    for (const h of hours) {
      assert.ok(h.start_wall_ms >= from && h.start_wall_ms < to, `${question}: ${new Date(h.start_wall_ms).toString()} is outside the time asked`)
      assert.ok(h.title, `${question}: an hour has no title`)
      assert.deepEqual(h.open, { kind: 'hour', hour_start_wall_ms: h.start_wall_ms, hour_id: h.hour_id })
    }
    // Today's rows for that time, titled as Today draws them.
    const today = new Today(reader.db, () => NOW.getTime()).day(dateOf(from)).hours.filter((h) => h.start_ms >= from && h.start_ms < to && !h.gap && (h.title !== null || h.facts.apps.length > 0))
    const shown = today.map((h) => [h.start_ms, h.title ?? (kindOf(h) === 'filled' ? historyLines(h).title : factsTitle(h))])
    assert.deepEqual(hours.map((h) => [h.start_wall_ms, h.title]), shown, `${question}: every hour of the time asked, in order, as Today shows it`)
  }
  reader.close()
})
