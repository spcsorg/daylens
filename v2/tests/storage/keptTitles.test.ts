import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KeepTitlesRefused } from '../../storage/index.ts'
import { app, focus, resetSeq } from '../support/lines.ts'
import { HOUR, MIN, rig, T0 } from './support.ts'

// An Electron note-taking app Daylens does not ship as trusted: its titles are withheld until the user keeps them.
const notes = app('com.example.notes', { name: 'Notes', engine: 'app_runtime', signer: 'TEAMNOTES1' })

test('an app the user keeps titles for keeps them from the next line, and the change is announced once it is in force', async () => {
  resetSeq()
  const r = rig()
  r.feed(focus(notes, 'Groceries - Notes', T0))
  const seen: string[] = []
  r.storage.bus.on((c) => {
    if (c.kind !== 'kept_titles') return
    r.feed(focus(notes, 'Seen by the listener - Notes', r.clock.t + 1))
    seen.push(String(r.q<{ title_state: string }>(`SELECT title_state FROM observations ORDER BY id DESC LIMIT 1`)[0]!.title_state))
  })
  r.clock.t = T0 + MIN
  const id = await r.storage.keepTitles(notes)
  r.feed(focus(notes, 'Groceries - Notes', T0 + 2 * MIN, 'reconcile'))
  r.store.flush()
  assert.deepEqual(seen, ['ok'], 'in force before the announcement')
  assert.deepEqual(r.q(`SELECT title, title_state FROM observations ORDER BY id`), [
    { title: null, title_state: 'unknown' },
    { title: 'Seen by the listener - Notes', title_state: 'ok' },
    { title: 'Groceries - Notes', title_state: 'ok' },
  ])
  assert.deepEqual(r.storage.keptTitleApps().map((a) => [a.id, a.app_id, a.signer]), [[id, 'com.example.notes', 'TEAMNOTES1']])
  r.close()
})

test('removing an app stops its titles at once, and its open row is not extended past the change', async () => {
  resetSeq()
  const r = rig()
  const id = await r.storage.keepTitles(notes)
  r.feed(focus(notes, 'Diary - Notes', T0))
  r.feed(focus(notes, 'Diary - Notes', T0 + MIN, 'reconcile'))
  r.clock.t = T0 + 2 * MIN
  r.storage.stopKeepingTitles(id)
  r.feed(focus(notes, 'Diary - Notes', T0 + 3 * MIN, 'reconcile'))
  r.store.flush()
  assert.deepEqual(r.q(`SELECT title, title_state, last_seen_wall_ms FROM observations ORDER BY id`), [
    { title: 'Diary - Notes', title_state: 'ok', last_seen_wall_ms: T0 + MIN },
    { title: null, title_state: 'unknown', last_seen_wall_ms: T0 + 3 * MIN },
  ])
  assert.deepEqual(r.storage.keptTitleApps(), [])
  r.close()
})

test('an entry is keyed by the verified signer: the same bundle ID signed by someone else keeps nothing', async () => {
  resetSeq()
  const r = rig()
  await r.storage.keepTitles(notes)
  r.feed(focus(app('com.example.notes', { name: 'Notes', engine: 'app_runtime', signer: 'SOMEONEELS' }), 'Impostor - Notes', T0))
  r.feed(focus(app('com.example.notes', { name: 'Notes', engine: 'app_runtime', signer: null }), 'Unsigned - Notes', T0 + MIN))
  r.store.flush()
  assert.deepEqual(r.q(`SELECT title_state FROM observations ORDER BY id`), [{ title_state: 'unknown' }, { title_state: 'unknown' }])
  r.close()
})

test('apps that open web links, browsers, browser engines, unverifiable and unsigned apps cannot be added, each with a reason', async () => {
  const r = rig()
  const refused = async (a: ReturnType<typeof app>) => {
    try {
      await r.storage.keepTitles(a)
    } catch (err) {
      assert.ok(err instanceof KeepTitlesRefused)
      return [err.reason, err.message]
    }
    return null
  }
  assert.deepEqual(await refused(app('com.example.mailer', { engine: 'app_runtime', signer: 'TEAMMAIL01', registered_browser: true })), [
    'opens_web_links',
    "Daylens can't keep titles for apps that open web links, since they can show private browsing.",
  ])
  assert.equal((await refused(app('com.google.Chrome', { engine: 'browser', signer: 'EQHXZ8M8AV' })))![0], 'browser')
  assert.equal((await refused(app('com.example.chromium-fork', { engine: 'browser', signer: 'TEAMFORK01' })))![0], 'browser_engine')
  assert.equal((await refused(app('com.example.odd', { engine: 'unknown', signer: 'TEAMODD001' })))![0], 'engine_unknown')
  assert.equal((await refused(app('com.example.notes', { engine: 'app_runtime', signer: null })))![0], 'unsigned')
  assert.equal((await refused(app('C:\\Apps\\Tool\\tool.exe', { path: 'C:\\Apps\\Tool\\tool.exe', engine: 'app_runtime', signer: 'Tool Inc.', version_info: null })))![0], 'unsigned')
  assert.equal((await refused(app('com.apple.TextEdit', { engine: 'none', signer: null })))![0], 'already_kept')
  assert.equal((await refused(app('com.todesktop.230313mzl4w4u92', { engine: 'app_runtime', signer: 'VDXQ22DGB9' })))![0], 'already_kept')
  assert.deepEqual(r.storage.keptTitleApps(), [])
  r.close()
})

test('a Windows app is kept by its package identity, or by executable, publisher and product, never by file name alone', async () => {
  resetSeq()
  const r = rig()
  const packaged = app('Contoso.Notes_abc123!App', { engine: 'app_runtime', store: { aumid: 'Contoso.Notes_abc123!App', package: 'Contoso.Notes_1.0_x64__abc123' } })
  const exe = app('C:\\Apps\\Jot\\jot.exe', {
    path: 'C:\\Apps\\Jot\\jot.exe',
    engine: 'app_runtime',
    signer: 'Jot Labs',
    version_info: { original_filename: 'jot.exe', product_name: 'Jot' },
  })
  await r.storage.keepTitles(packaged)
  await r.storage.keepTitles(exe)
  r.feed(line2(packaged, 'Packaged - Notes', T0))
  r.feed(line2(exe, 'Jot doc - Jot', T0 + MIN))
  r.feed(line2(app('D:\\Other\\jot.exe', { path: 'D:\\Other\\jot.exe', engine: 'app_runtime', signer: 'Someone Else', version_info: { original_filename: 'jot.exe', product_name: 'Jot' } }), 'Renamed - Jot', T0 + 2 * MIN))
  r.store.flush()
  assert.deepEqual(r.q(`SELECT title_state FROM observations ORDER BY id`), [{ title_state: 'ok' }, { title_state: 'ok' }, { title_state: 'unknown' }])
  assert.ok(HOUR)
  r.close()
})

function line2(a: ReturnType<typeof app>, title: string, t: number) {
  return focus(a, title, t, 'app_changed', a.app_id ?? 'w')
}


for (const scheme of ['http', 'https']) {
  test(`a ${scheme}-only handler cannot be added or keep titles through an existing entry`, async () => {
    resetSeq()
    const r = rig()
    try {
      await r.storage.keepTitles(notes)
      const handler = { ...notes, registered_browser: true }
      await assert.rejects(r.storage.keepTitles(handler), (e) => e instanceof KeepTitlesRefused && e.reason === 'opens_web_links')
      r.feed(focus(handler, `${scheme}HandlerCanary`, T0))
      assert.deepEqual(r.q('SELECT title, title_raw, title_state FROM observations'), [
        { title: null, title_raw: null, title_state: 'withheld_browser' },
      ])
      assert.deepEqual(r.storage.search(`${scheme}HandlerCanary`), [])
    } finally {
      r.close()
    }
  })
}
