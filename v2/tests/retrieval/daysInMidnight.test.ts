// A day that starts at 1 AM, because the clocks went forward at midnight, ends where the next day starts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { daysIn } from '../../retrieval/ask.ts'

process.env.TZ = 'America/Santiago'

test('named days stay disjoint across a midnight clock change', () => {
  const [first, second] = daysIn('what did i do on 2023-09-03 and 2023-09-04', new Date(2023, 8, 10, 12).getTime())
  assert.ok(first && second)
  assert.equal(new Date(first[0]).getHours(), 1, 'midnight does not exist on 3 September 2023 in Santiago')
  assert.equal(first[1], second[0])
})
