import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KeepTitlesRefused } from '../../storage/index.ts'
import { app, focus, resetSeq } from '../support/lines.ts'
import { diskContains, MIN, rig, T0 } from './support.ts'

const notes = app('com.example.notes', { engine: 'app_runtime', signer: 'TEAMNOTES1' })

test('kept titles survive restart, removal survives restart, and duplicate actions announce no change', () => {
  resetSeq()
  const first = rig()
  let changes = 0
  first.storage.bus.on((c) => { if (c.kind === 'kept_titles') changes++ })
  const id = first.storage.keepTitles(notes)
  assert.equal(first.storage.keepTitles({ ...notes, name: 'Renamed Notes' }), id)
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

test('kept titles never override exclusions, private windows, link registration or engine changes', () => {
  resetSeq()
  const r = rig()
  r.storage.keepTitles(notes)
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

test('unverifiable identities and changed Windows product identities cannot use a kept entry', () => {
  resetSeq()
  const r = rig()
  assert.throws(() => r.storage.keepTitles({ ...notes, identity_state: 'access_denied' }), (e) => e instanceof KeepTitlesRefused && e.reason === 'unsigned')
  const exe = app('C:\\Apps\\Jot\\jot.exe', {
    path: 'C:\\Apps\\Jot\\jot.exe', engine: 'app_runtime', signer: 'Jot Labs',
    version_info: { original_filename: 'jot.exe', product_name: 'Jot' },
  })
  r.storage.keepTitles(exe)
  r.feed(focus(exe, 'Kept Jot', T0))
  r.feed(focus({ ...exe, version_info: { original_filename: 'jot.exe', product_name: 'Browser' } }, 'ChangedProductCanary', T0 + MIN))
  assert.deepEqual(r.q('SELECT title_state FROM observations ORDER BY id'), [{ title_state: 'ok' }, { title_state: 'unknown' }])
  r.close()
})


test('delayed titles before activation stay off disk and out of observations and search, including after re-add and restart', () => {
  resetSeq()
  const r = rig()
  r.clock.t = T0 + MIN
  const id = r.storage.keepTitles(notes)
  r.feed(focus(notes, 'BeforeAddDiskCanary ⠋', T0))
  r.feed(focus(notes, 'At activation', T0 + MIN, 'window_changed', 'at'))
  r.clock.t = T0 + 2 * MIN
  r.storage.stopKeepingTitles(id)
  r.feed(focus(notes, 'AfterRemovalDiskCanary ⠋', T0 + 3 * MIN))
  r.feed(focus(notes, 'DelayedAfterRemovalDiskCanary ⠋', T0 + MIN, 'window_changed', 'delayed'))
  r.clock.t = T0 + 4 * MIN
  r.storage.keepTitles(notes)
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


test('a wall-clock rollback cannot admit a queued pre-consent title, including across sleep', () => {
  const r = rig()
  try {
    r.clock.t = T0
    r.clock.monoUs = 200_000
    r.storage.keepTitles(notes)
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

test('a reboot after activation admits only events from the proven current kernel boot', () => {
  const r = rig()
  try {
    r.storage.keepTitles(notes)
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
