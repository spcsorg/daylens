// Ask tells the model which dates and weekdays today and tomorrow are, by the calendar, where the clocks change at
// midnight (Santiago) and across a year end.
import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { DB_FILE } from '../../capture/store.ts'
import { ask, type AskRequest } from '../../retrieval/ask.ts'
import { AssistantStore } from '../../retrieval/assistantStore.ts'
import { Reader } from '../../retrieval/reader.ts'
import { rig } from '../storage/support.ts'
import { day } from './support.ts'

process.env.TZ = 'America/Santiago'

async function sentDays(now: number): Promise<{ today: string; tomorrow: string }> {
  const r = rig()
  day(r)
  const reader = Reader.open(path.join(r.dir, DB_FILE))
  const store = AssistantStore.open(path.join(r.dir, DB_FILE), () => r.clock.t)
  const seen: AskRequest[] = []
  const model = { name: 'Fake', provider: 'fake', run: async (req: AskRequest) => (seen.push(req), { output: { answerable: false, statements: [] }, model: 'fake-1', input_tokens: 1, output_tokens: 1, cost_micro_usd: 0 }) }
  const log = { recordRead: (x: Parameters<AssistantStore['recordRead']>[0], mark: number) => store.recordRead(x, mark), recordUsage: (u: Parameters<typeof r.storage.recordUsage>[0]) => r.storage.recordUsage(u) }
  try {
    await ask('budget', { reader, model, log, now: () => now }, { maxHours: 5, maxSources: 10, perGroup: 5 })
    const { today, tomorrow } = JSON.parse(seen[0]!.prompt) as { today: string; tomorrow: string }
    return { today, tomorrow }
  } finally {
    reader.close()
    store.close()
    r.close()
  }
}

test('tomorrow is the next calendar day, on a 23-hour day that starts at 1 AM', async () => {
  const now = new Date(2027, 8, 4, 23, 30).getTime()
  assert.equal(new Date(2027, 8, 5).getHours(), 1, 'midnight does not exist on 5 September 2027 in Santiago')
  assert.deepEqual(await sentDays(now), { today: 'Saturday 2027-09-04', tomorrow: 'Sunday 2027-09-05' })
})

test('tomorrow is the next calendar day, early on a 25-hour day', async () => {
  const now = new Date(2027, 3, 3, 0, 30).getTime()
  assert.deepEqual(await sentDays(now), { today: 'Saturday 2027-04-03', tomorrow: 'Sunday 2027-04-04' })
})

test('tomorrow is in the next month and year on New Year’s Eve', async () => {
  const now = new Date(2027, 11, 31, 23, 30).getTime()
  assert.deepEqual(await sentDays(now), { today: 'Friday 2027-12-31', tomorrow: 'Saturday 2028-01-01' })
})
