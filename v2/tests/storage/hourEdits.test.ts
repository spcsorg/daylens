import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleControl, type ControlReply } from '../../capture/control.ts'
import { Reader } from '../../app/reader/queries.ts'
import { hour } from '../../app/reader/today.ts'
import { app, focus, resetSeq } from '../support/lines.ts'
import { page } from '../retrieval/support.ts'
import { HOUR, MIN, T0, rig } from './support.ts'

async function recorded() {
  resetSeq()
  const r = rig()
  const notes = app('com.example.notes', { name: 'Notes' })
  r.feed(focus(notes, 'Delivery plan', T0))
  r.feed(focus(notes, 'Delivery plan', T0 + 40 * MIN, 'reconcile'))
  r.clock.t = T0 + 2 * HOUR
  r.storage.start()
  await r.storage.derivationSettled()
  return r
}

function control(r: Awaited<ReturnType<typeof recorded>>, msg: Record<string, unknown>): Extract<ControlReply, { op: 'reply' }>[] {
  const replies: ControlReply[] = []
  assert.equal(handleControl(r.storage, { id: 'edit', ...msg }, (reply) => replies.push(reply), () => r.clock.t), true)
  return replies.filter((reply) => reply.op === 'reply')
}

test('editing a facts hour creates one atomic edit, survives rewriting, and Undo restores both fields', async () => {
  const r = await recorded()
  try {
    assert.equal(r.storage.hourAt(T0), null)
    const replies = control(r, { op: 'edit_hour', start_ms: T0, title: 'Planned the bakery deliveries', summary: 'Agreed the route.' })
    assert.equal(replies[0]?.ok, true)
    const edit = (replies[0] as { result: { edit_id: number } }).result.edit_id
    const h = r.storage.hourAt(T0)!
    assert.deepEqual([h.title, h.summary], ['Planned the bakery deliveries', 'Agreed the route.'])
    assert.ok(r.storage.search('bakery').length)
    const seen = hour(new Reader(r.store.database, () => r.clock.t), T0)
    assert.equal(seen.edit_id, edit)
    r.storage.writeHour({ start_wall_ms: T0, tz: 'Example/Town', status: 'written', title: 'A rewritten title', summary: 'A rewritten summary', detail: 'Old detail' }, r.storage.hourBasis(T0))
    assert.equal(r.storage.hourAt(T0)!.title, 'Planned the bakery deliveries')
    assert.equal(hour(new Reader(r.store.database, () => r.clock.t), T0).detail, null)
    assert.equal(control(r, { op: 'undo_hour_edit', start_ms: T0, edit_id: edit })[0]?.ok, true)
    assert.deepEqual([r.storage.hourAt(T0)!.title, r.storage.hourAt(T0)!.summary], ['A rewritten title', 'A rewritten summary'])
    assert.equal(hour(new Reader(r.store.database, () => r.clock.t), T0).edit_id, null)
  } finally {
    r.close()
  }
})

test('two edits undo one at a time, without undoing an assistant title correction', async () => {
  const r = await recorded()
  try {
    const first = r.storage.editHour(T0, 'Planned deliveries', 'First note')
    const id = r.storage.hourAt(T0)!.id
    r.storage.correct(id, 'title', 'Supplier call')
    const second = r.storage.editHour(T0, 'Costed deliveries', '')
    r.storage.undoHourEdit(T0, second)
    assert.deepEqual([r.storage.hourAt(T0)!.title, r.storage.hourAt(T0)!.summary], ['Supplier call', 'First note'])
    r.storage.undoHourEdit(T0, first)
    assert.deepEqual([r.storage.hourAt(T0)!.title, r.storage.hourAt(T0)!.summary], ['Supplier call', null])
    assert.throws(() => r.storage.undoHourEdit(T0, first))
  } finally {
    r.close()
  }
})

test('a facts edit keeps its source dependencies, so deleting the app clears its words', async () => {
  const r = await recorded()
  try {
    r.storage.editHour(T0, 'Planned bakery deliveries', 'A route for the morning')
    assert.ok(r.storage.hourAt(T0)!.sources.some((s) => s.app_id === 'com.example.notes'))
    r.storage.writeHour({ start_wall_ms: T0, tz: 'Example/Town', status: 'written', title: 'A rewritten hour' }, r.storage.hourBasis(T0))
    await r.storage.deleteSource('com.example.notes').done
    assert.equal(r.storage.hourAt(T0)?.title ?? null, null)
    assert.equal(r.storage.search('bakery').length, 0)
  } finally {
    r.close()
  }
})

test('an edit cannot recreate an hour deleted or hidden by retention while its editor was open', async () => {
  const r = await recorded()
  try {
    const edit = r.storage.editHour(T0, 'Delivery route', '')
    assert.throws(() => r.storage.undoHourEdit(T0 + HOUR, edit))
    await r.storage.deleteRange(T0, T0 + HOUR).done
    assert.equal(control(r, { op: 'edit_hour', start_ms: T0, title: 'Deleted route', summary: '' })[0]?.ok, false)
    assert.equal(r.storage.hourAt(T0), null)
    r.clock.t += 3 * 24 * HOUR
    r.storage.setRetentionDays(1)
    assert.equal(control(r, { op: 'edit_hour', start_ms: T0, title: 'Expired route', summary: '' })[0]?.ok, false)
  } finally {
    r.close()
  }
})

test('an edit to an hour known only from browser history is cleared when its site is deleted', async () => {
  const r = rig()
  try {
    r.store.insertObservation({ ...page(T0 + MIN, 'https://bakery.example/route', 'Delivery route'), kind: 'visit', source: 'history_chrome' })
    r.store.flush()
    r.clock.t = T0 + 2 * HOUR
    r.storage.start()
    await r.storage.derivationSettled()
    r.storage.editHour(T0, 'Planned bakery deliveries', '')
    assert.ok(r.storage.hourAt(T0)!.sources.some((s) => s.site === 'bakery.example'))
    await r.storage.deleteSite('bakery.example').done
    assert.equal(r.storage.hourAt(T0)?.title ?? null, null)
    assert.equal(r.storage.search('bakery').length, 0)
  } finally {
    r.close()
  }
})

test('a failed second field rolls the whole edit back and announces nothing', async () => {
  const r = await recorded()
  try {
    r.store.database.exec("CREATE TRIGGER refuse_summary BEFORE INSERT ON corrections WHEN NEW.field = 'summary' BEGIN SELECT RAISE(ABORT, 'full'); END")
    const changes: string[] = []
    const off = r.storage.bus.on((c) => changes.push(c.kind))
    assert.throws(() => r.storage.editHour(T0, 'A title', 'A summary'))
    off()
    assert.equal(r.storage.hourAt(T0), null)
    assert.deepEqual(changes, [])
    assert.equal((r.store.database.prepare('SELECT count(*) AS n FROM corrections').get() as { n: number }).n, 0)
  } finally {
    r.close()
  }
})
