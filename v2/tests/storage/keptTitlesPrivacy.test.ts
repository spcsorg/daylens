import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readOrderingPoint } from '../../capture/ordering.ts'
import { KeepTitlesRefused } from '../../storage/index.ts'
import { app, focus, resetSeq } from '../support/lines.ts'
import { diskContains, MIN, rig, T0 } from './support.ts'

const notes = app('com.example.notes', { engine: 'app_runtime', signer: 'TEAMNOTES1' })

test('kept titles survive restart, removal survives restart, and duplicate actions announce no change', async () => {
  resetSeq()
  const first = rig()
  let changes = 0
  first.storage.bus.on((c) => { if (c.kind === 'kept_titles') changes++ })
  const id = await first.storage.keepTitles(notes)
  assert.equal(await first.storage.keepTitles({ ...notes, name: 'Renamed Notes' }), id)
  assert.equal(changes, 1)
  first.close()
  const second = rig(first.dir)
  assert.equal(second.storage.keptTitleApps()[0]!.id, id)
  second.feed(focus({ ...notes, name: 'Renamed Notes' }, 'Kept after restart', T0))
  assert.equal(second.q<{ title: string }>('SELECT title FROM observations')[0]!.title, 'Kept after restart')
  second.storage.stopKeepingTitles(id)
  second.close()
  const third = rig(first.dir)
  third.feed(focus(notes, 'Withheld after restart', T0 + MIN))
  assert.deepEqual(third.storage.keptTitleApps(), [])
  assert.equal(third.q<{ title: string | null }>('SELECT title FROM observations ORDER BY id DESC')[0]!.title, null)
  third.close()
})

test('kept titles never override exclusions, private windows, link registration or engine changes', async () => {
  resetSeq()
  const r = rig()
  await r.storage.keepTitles(notes)
  const privateLine = focus(notes, 'PrivateCanary', T0)
  if (privateLine.kind !== 'focus') throw new Error('expected focus')
  privateLine.obs.window.mode = 'private'
  r.feed(privateLine)
  r.feed(focus({ ...notes, registered_browser: true }, 'LinkCanary', T0 + MIN, 'window_changed', 'links'))
  r.feed(focus({ ...notes, engine: 'browser' }, 'BrowserCanary', T0 + 2 * MIN, 'window_changed', 'browser'))
  r.feed(focus({ ...notes, engine: 'unknown' }, 'UnknownCanary', T0 + 3 * MIN, 'window_changed', 'unknown'))
  r.storage.addExclusion({ match: 'app_id', value: notes.app_id!, label: 'Notes' })
  r.feed(focus(notes, 'ExcludedCanary', T0 + 4 * MIN))
  assert.deepEqual(r.q('SELECT title, title_raw FROM observations'), Array.from({ length: 4 }, () => ({ title: null, title_raw: null })))
  assert.equal(r.q<{ n: number }>("SELECT count(*) AS n FROM capture_gaps WHERE reason = 'excluded'")[0]!.n, 1)
  r.storage.removeExclusion('app_id', notes.app_id!)
  r.feed(focus(notes, 'Kept again', T0 + 5 * MIN))
  assert.equal(r.q<{ title: string }>('SELECT title FROM observations ORDER BY id DESC')[0]!.title, 'Kept again')
  r.close()
})

test('unverifiable identities and changed Windows product identities cannot use a kept entry', async () => {
  resetSeq()
  const r = rig()
  await assert.rejects(r.storage.keepTitles({ ...notes, identity_state: 'access_denied' }), (e) => e instanceof KeepTitlesRefused && e.reason === 'unsigned')
  const exe = app('C:\\Apps\\Jot\\jot.exe', {
    path: 'C:\\Apps\\Jot\\jot.exe', engine: 'app_runtime', signer: 'Jot Labs',
    version_info: { original_filename: 'jot.exe', product_name: 'Jot' },
  })
  await r.storage.keepTitles(exe)
  r.feed(focus(exe, 'Kept Jot', T0))
  r.feed(focus({ ...exe, version_info: { original_filename: 'jot.exe', product_name: 'Browser' } }, 'ChangedProductCanary', T0 + MIN))
  assert.deepEqual(r.q('SELECT title_state FROM observations ORDER BY id'), [{ title_state: 'ok' }, { title_state: 'unknown' }])
  r.close()
})


test('delayed titles before activation stay off disk and out of observations and search, including after re-add and restart', async () => {
  resetSeq()
  const r = rig()
  r.clock.t = T0 + MIN
  const id = await r.storage.keepTitles(notes)
  r.feed(focus(notes, 'BeforeAddDiskCanary ⠋', T0))
  r.feed(focus(notes, 'At activation', T0 + MIN, 'window_changed', 'at'))
  r.clock.t = T0 + 2 * MIN
  r.storage.stopKeepingTitles(id)
  r.feed(focus(notes, 'AfterRemovalDiskCanary ⠋', T0 + 3 * MIN))
  r.feed(focus(notes, 'DelayedAfterRemovalDiskCanary ⠋', T0 + MIN, 'window_changed', 'delayed'))
  r.clock.t = T0 + 4 * MIN
  await r.storage.keepTitles(notes)
  r.close()
  const again = rig(r.dir)
  try {
    again.feed(focus(notes, 'BeforeReAddDiskCanary ⠋', T0 + 3 * MIN))
    again.feed(focus(notes, 'After re-add', T0 + 4 * MIN, 'window_changed', 'after'))
    assert.deepEqual(again.q('SELECT title, title_raw FROM observations ORDER BY id'), [
      { title: null, title_raw: null },
      { title: 'At activation', title_raw: null },
      { title: null, title_raw: null },
      { title: null, title_raw: null },
      { title: null, title_raw: null },
      { title: 'After re-add', title_raw: null },
    ])
    for (const canary of ['BeforeAddDiskCanary', 'AfterRemovalDiskCanary', 'DelayedAfterRemovalDiskCanary', 'BeforeReAddDiskCanary']) {
      assert.deepEqual(again.storage.search(canary), [])
      assert.deepEqual(diskContains(again.dir, canary), [])
    }
  } finally {
    again.close()
  }
})


test('a wall-clock rollback cannot admit a queued pre-consent title, including across sleep', async () => {
  const r = rig()
  try {
    r.clock.t = T0
    r.clock.monoUs = 200_000
    await r.storage.keepTitles(notes)
    const queued = focus(notes, 'RollbackConsentCanary ⠋', T0 + 60 * MIN)
    queued.t.mono_us = 100_000
    r.feed(queued)
    const afterSleep = focus(notes, 'After sleep', T0 - MIN, 'window_changed', 'awake')
    afterSleep.t.mono_us = 300_000
    r.feed(afterSleep)
    assert.deepEqual(r.q('SELECT title, title_raw FROM observations ORDER BY id'), [
      { title: null, title_raw: null }, { title: 'After sleep', title_raw: null },
    ])
    assert.deepEqual(r.storage.search('RollbackConsentCanary'), [])
    assert.deepEqual(diskContains(r.dir, 'RollbackConsentCanary'), [])
  } finally { r.close() }
})

test('a reboot after activation admits only events from the proven current kernel boot', async () => {
  const r = rig()
  try {
    await r.storage.keepTitles(notes)
    r.clock.boot = 'boot-next'
    r.clock.monoUs = 1000
    r.reopenNormalizer()
    const next = focus(notes, 'After reboot', T0 - MIN)
    next.boot = 'boot-next'
    next.t.mono_us = 2000
    r.feed(next)
    const unknown = focus(notes, 'UnprovenBootCanary', T0 + MIN, 'window_changed', 'unknown')
    unknown.boot = 'boot-unseen'
    unknown.t.mono_us = 5000
    r.feed(unknown)
    assert.deepEqual(r.q('SELECT title FROM observations ORDER BY id'), [{ title: 'After reboot' }, { title: null }])
    assert.deepEqual(diskContains(r.dir, 'UnprovenBootCanary'), [])
    r.clock.bootIdentity = 'clock'
    r.reopenNormalizer()
    const uncertain = focus(notes, 'UncertainBootCanary', T0 + 2 * MIN)
    uncertain.boot = 'boot-next'
    r.feed(uncertain)
    assert.equal(r.q<{ title: string | null }>('SELECT title FROM observations ORDER BY id DESC')[0]!.title, null)
  } finally { r.close() }
})

test('a kept Windows identity survives Squirrel updates without admitting another app from the same publisher', async () => {
  const r = rig()
  const windowsApp = (root: string, exe = 'jot.exe') => app(`${root}\\${exe}`, {
    path: `${root}\\${exe}`, engine: 'app_runtime', signer: 'Jot Labs',
    version_info: { original_filename: exe, product_name: 'Jot' },
  })
  try {
    const old = windowsApp('C:\\Users\\me\\Jot\\app-4.41.0')
    const id = await r.storage.keepTitles(old)
    const saved = r.storage.keptTitleApps()[0]!
    const legacyId = JSON.stringify(['exe', old.app_id!.toLowerCase(), 'jot.exe', 'jot labs', 'jot.exe', 'jot'])
    r.storage.db.prepare("UPDATE settings SET value = ? WHERE key = 'kept_title_apps'").run(JSON.stringify([{ ...saved, id: legacyId }]))
    r.reopenNormalizer()
    r.feed(focus(old, 'Before update', T0))
    const updated = windowsApp('C:\\Users\\me\\Jot\\app-4.42.0')
    r.feed(focus(updated, 'After update', T0 + MIN))
    assert.deepEqual(r.q('SELECT title FROM observations ORDER BY id'), [{ title: 'Before update' }, { title: 'After update' }])
    assert.equal(await r.storage.keepTitles(updated), id)
    assert.equal(r.storage.keptTitleApps().length, 1)
    r.feed(focus(windowsApp('C:\\Users\\me\\Jot\\app-4.42.0', 'other.exe'), 'OtherExeCanary', T0 + 2 * MIN))
    r.feed(focus(windowsApp('C:\\Users\\me\\Other\\app-4.42.0'), 'OtherRootCanary', T0 + 3 * MIN))
    assert.deepEqual(r.q('SELECT title FROM observations ORDER BY id DESC LIMIT 2'), [{ title: null }, { title: null }])
    for (const canary of ['OtherExeCanary', 'OtherRootCanary']) assert.deepEqual(diskContains(r.dir, canary), [])
  } finally { r.close() }
})

test('generic settings cannot bypass kept-title validation or replace the live privacy list', async () => {
  const r = rig()
  try {
    const id = await r.storage.keepTitles(notes)
    assert.throws(() => r.storage.setSetting('kept_title_apps', []), /keepTitles.*stopKeepingTitles/)
    assert.equal(r.storage.keptTitleApps()[0]!.id, id)
    r.feed(focus(notes, 'Still kept', T0))
    assert.equal(r.q<{ title: string }>('SELECT title FROM observations')[0]!.title, 'Still kept')
    r.storage.stopKeepingTitles(id)
    assert.deepEqual(r.storage.keptTitleApps(), [])
  } finally { r.close() }
})

const slowHelper = (ms: number, p: { boot: string; mono_us: number; boot_identity: 'kernel' }, errors: string[]) => () =>
  readOrderingPoint(process.execPath, ['-e', `setTimeout(() => process.stdout.write(${JSON.stringify(JSON.stringify(p))}), ${ms})`, '--'], (c) => errors.push(c))

test('after a restart into a new boot, titles kept earlier stay withheld until a slow first ordering read succeeds, then return in the same session', async () => {
  resetSeq()
  const first = rig()
  await first.storage.keepTitles(notes)
  first.close()
  const errors: string[] = []
  const r = rig(first.dir, { orderingPoint: slowHelper(700, { boot: 'boot-next', mono_us: 5000, boot_identity: 'kernel' }, errors) })
  try {
    const before = focus(notes, 'BeforeOrderingReadCanary', T0 + MIN)
    before.boot = 'boot-next'
    before.t.mono_us = 6000
    r.feed(before)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const after = focus(notes, 'After the ordering read', T0 + 2 * MIN, 'window_changed', 'after')
    after.boot = 'boot-next'
    after.t.mono_us = 7000
    r.feed(after)
    assert.deepEqual(r.q('SELECT title FROM observations ORDER BY id'), [{ title: null }, { title: 'After the ordering read' }])
    assert.deepEqual(diskContains(r.dir, 'BeforeOrderingReadCanary'), [])
    assert.deepEqual(errors, [])
  } finally { r.close() }
})

test('keeping titles waits for a slow first run of the ordering helper instead of refusing', async () => {
  resetSeq()
  const errors: string[] = []
  const r = rig(undefined, { orderingPoint: slowHelper(800, { boot: 'boot-test', mono_us: T0 * 1000, boot_identity: 'kernel' }, errors) })
  try {
    const id = await r.storage.keepTitles(notes)
    assert.equal(r.storage.keptTitleApps()[0]!.id, id)
    assert.deepEqual(r.storage.keptTitleApps()[0]!.activation, { boot: 'boot-test', mono_us: T0 * 1000, boot_identity: 'kernel' })
    r.feed(focus(notes, 'Kept after a slow start', T0 + MIN))
    assert.equal(r.q<{ title: string }>('SELECT title FROM observations')[0]!.title, 'Kept after a slow start')
    assert.deepEqual(errors, [])
  } finally { r.close() }
})
