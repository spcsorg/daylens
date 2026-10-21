import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BrowserPages } from '../../capture/browser.ts'
import { Privacy, type ObservationRow } from '../../capture/normalize.ts'
import { app, focus } from '../support/lines.ts'
import { MemorySink } from '../support/memorySink.ts'
import { HOUR, rig, T0 } from './support.ts'

function page(t: number, url: string, title: string, app = 'com.google.Chrome'): ObservationRow & { url: string } {
  return {
    run: 'ext', seq: 0, boot: 'b', platform: 'macos', source: 'browser_ext', kind: 'page', event_wall_ms: t, event_mono_us: t * 1000, tz: 'Africa/Kigali',
    tz_offset_min: 120, app_id: app, app_name: 'Browser', app_path: null, pid: 500, window: 'ext:1', title, title_raw: null, title_state: 'ok', state: 'normal', detail: null, url,
  }
}

test('a page on an excluded site or from an excluded browser is never stored, however it is written', () => {
  const r = rig()
  r.storage.addExclusion({ match: 'site', value: 'secret-bank.example', label: 'Bank' })
  r.storage.addExclusion({ match: 'app_id', value: 'company.thebrowser.dia', label: 'Dia' })
  r.store.insertObservation(page(T0, 'https://login.secret-bank.example/accounts', 'Wombatcanary balance'))
  r.store.insertObservation(page(T0 + 1000, 'https://example.org/dia', 'Wombatcanary dia', 'company.thebrowser.dia'))
  r.store.insertObservation(page(T0 + 2000, 'https://example.org/kept', 'Kept page'))
  const imported = r.storage.importObservations([page(T0 + 3000, 'https://secret-bank.example/', 'Wombatcanary import')])
  assert.equal(imported.refused, 1)
  assert.deepEqual(r.q<{ title: string }>(`SELECT title FROM observations WHERE kind = 'page'`).map((x) => x.title), ['Kept page'])
  assert.ok(r.q<{ n: number }>(`SELECT count(*) AS n FROM capture_gaps WHERE reason = 'excluded'`)[0]!.n >= 2)
  r.clock.t = T0 + HOUR
  r.close()
})

test('an exclusion added while running reaches the page gate', () => {
  const sink = new MemorySink()
  const pages = new BrowserPages(sink, new Privacy([]))
  pages.setPrivacy(new Privacy([{ match: 'site', value: 'secret-bank.example', label: 'Bank' }]))
  const id = pages.connect({ send: () => {} })
  const browser = { app_id: 'com.google.Chrome', name: 'Chrome', path: '/Applications/Google Chrome.app', pid: 500, registered_browser: true, identity_state: 'ok' as const, store: null, engine: 'browser' as const, signer: null, version_info: null }
  const t = { wall_ms: T0, mono_us: T0 * 1000, tz: 'Africa/Kigali', tz_offset_min: 120 }
  pages.onFront({ v: 1, run: 'h', seq: 0, boot: 'b', t, platform: 'macos', source: 'nsworkspace', kind: 'focus', obs: { trigger: 'app_changed', app: browser, window: { window: 'w', title: null, title_state: 'empty' } } })
  pages.onTab(id, {
    v: 1, run: 'e', seq: 0, boot: 'b', t: { ...t, wall_ms: T0 + 10, mono_us: (T0 + 10) * 1000 }, platform: 'macos', source: 'browser_ext', kind: 'tab',
    obs: { trigger: 'activated', state: 'page', reason: null, browser, extension: 'abcdefghijklmnopabcdefghijklmnop', window: '1', tab: '1', url: 'https://login.secret-bank.example/', title: 'Wombatcanary' },
  })
  assert.ok(!JSON.stringify(sink.rows).includes('Wombatcanary'))
  assert.ok(sink.gaps.some((g) => g.reason === 'excluded'))
})

test('a browser paused on its own stores none of its pages or windows while others keep recording, and resumes', () => {
  const r = rig()
  const chrome = app('com.google.Chrome', { pid: 500, registered_browser: true, engine: 'browser' })
  const notes = app('com.apple.Notes', { pid: 600 })
  const p = r.storage.pauseApp('com.google.Chrome', 'hour')
  assert.equal(p.until_wall_ms, T0 + HOUR)
  assert.equal(r.storage.paused(), null, 'nothing else is paused')
  r.feed(focus(chrome, 'Wombatcanary window', T0 + 1000, 'app_changed'))
  r.store.insertObservation(page(T0 + 1500, 'https://example.org/private', 'Wombatcanary page'))
  r.feed(focus(notes, 'Groceries', T0 + 2000, 'app_changed'))
  assert.equal(r.storage.importObservations([page(T0 + 2500, 'https://example.org/imported', 'Wombatcanary import')]).refused, 1)
  r.clock.t = T0 + 3000
  r.storage.resumeApp('com.google.Chrome')
  r.feed(focus(chrome, null, T0 + 4000, 'app_changed'))
  const rows = r.q<{ app_id: string; kind: string; title: string | null; event_wall_ms: number }>(`SELECT app_id, kind, title, event_wall_ms FROM observations WHERE kind IN ('focus', 'page') ORDER BY event_wall_ms`)
  assert.ok(!JSON.stringify(rows).includes('Wombatcanary'), JSON.stringify(rows))
  assert.deepEqual(rows.map((x) => [x.app_id, x.event_wall_ms]), [['com.apple.Notes', T0 + 2000], ['com.google.Chrome', T0 + 4000]])
  assert.deepEqual(r.q(`SELECT reason, start_wall_ms, end_wall_ms FROM capture_gaps WHERE reason = 'paused'`), [{ reason: 'paused', start_wall_ms: T0 + 1000, end_wall_ms: T0 + 2000 }])
  assert.deepEqual(r.storage.pausedApps(), [])
  r.close()
})
