// A frozen ambiguous-link regression: the same neighboring spreadsheet, unnamed or explicitly linked to the campaign.
// Run deliberately with DAYLENS_TEST_ANTHROPIC_API_KEY; normal tests never call a paid provider.
import assert from 'node:assert/strict'
import path from 'node:path'
import { DB_FILE } from '../../capture/store.ts'
import { anthropicApi, ASK_EFFORT, ASK_MODEL } from '../../retrieval/anthropicApi.ts'
import { ask, type AskModel } from '../../retrieval/ask.ts'
import { Reader } from '../../retrieval/reader.ts'
import { HOUR, MIN, rig, T0 } from '../../tests/storage/support.ts'
import { app, focus, line, resetSeq } from '../../tests/support/lines.ts'

const key = process.env.DAYLENS_TEST_ANTHROPIC_API_KEY
if (!key) throw new Error('set DAYLENS_TEST_ANTHROPIC_API_KEY')
process.env.TZ = 'Etc/GMT+5'
const base = anthropicApi(ASK_MODEL, { apiKey: key, timeoutMs: 60_000, effort: ASK_EFFORT })
const cases = [
  { title: 'Planning.xlsx - Editor', largest: 40 },
  { title: 'Juniper campaign plan.xlsx - Editor', largest: 50 },
]
const outputs = []
for (const c of cases) {
  const r = rig()
  let reader: Reader | undefined
  try {
    resetSeq()
    r.feed(line('session', { state: 'unlocked', snapshot: false }, T0))
    const titles = [
      { title: 'Juniper campaign dashboard', minutes: 20 },
      { title: c.title, minutes: 30 },
      { title: 'Delivery routes', minutes: 40 },
    ]
    let minute = 0
    for (const t of titles) for (let i = 0; i < t.minutes; i++, minute++) r.feed(focus(app('com.example.editor', { name: 'Editor' }), t.title, T0 + minute * MIN, 'app_changed'))
    r.feed(line('session', { state: 'locked', snapshot: false }, T0 + minute * MIN))
    r.store.flush()
    reader = Reader.open(path.join(r.dir, DB_FILE))
    const replies: unknown[] = []
    const model: AskModel = { ...base, run: async (request, onText) => { const reply = await base.run(request, onText); replies.push(reply); return reply } }
    const result = await ask('What took most of my time today?', { reader, model, log: { recordRead: () => 1, recordUsage: () => 1 }, now: () => T0 + 3 * HOUR }, { maxHours: 12, maxSources: 40, perGroup: 8 })
    const largest = result.kind === 'answer' && result.visual?.kind === 'work' ? result.visual.pieces[0]?.minutes : null
    outputs.push({ title: c.title, expected_largest_minutes: c.largest, largest, pass: largest === c.largest, result, replies })
  } finally {
    reader?.close()
    r.close()
  }
}
process.stdout.write(JSON.stringify(outputs, null, 2) + '\n')
assert.ok(outputs.every((o) => o.pass), 'ambiguous neighbors stay separate; an explicitly shared campaign joins them')
