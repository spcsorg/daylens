import type { ObservationRow } from '../../capture/normalize.ts'
import { app, focus, line, resetSeq } from '../support/lines.ts'
import { MIN, T0, type rig } from '../storage/support.ts'

const editor = app('com.example.editor', { name: 'Editor' })
const notes = app('com.example.notes', { name: 'Notes' })
const chrome = app('com.google.Chrome', { name: 'Chrome' })

export function page(t: number, url: string, title: string): ObservationRow & { url: string } {
  return {
    run: 'ext', seq: 0, boot: 'b', platform: 'macos', source: 'browser_ext', kind: 'page', event_wall_ms: t, event_mono_us: t * 1000, tz: 'Africa/Kigali',
    tz_offset_min: 120, app_id: 'com.google.Chrome', app_name: 'Chrome', app_path: null, pid: 500, window: 'ext:1', title, title_raw: null, title_state: 'ok', state: 'normal', detail: null, url,
  }
}

// Editor with a file 0-10 min, a plain window 10-20, Chrome on one page 20-30, Notes 30-31, then the screen locks.
export function day(r: ReturnType<typeof rig>): void {
  resetSeq()
  for (let m = 0; m < 10; m++) r.feed(focus(editor, 'q4-budget.xlsx - Editor', T0 + m * MIN))
  for (let m = 10; m < 20; m++) r.feed(focus(editor, 'Scratch - Editor', T0 + m * MIN))
  r.feed(focus(chrome, 'Budget review - Google Docs', T0 + 20 * MIN, 'app_changed'))
  r.store.insertObservation(page(T0 + 20 * MIN, 'https://docs.example.com/d/budget', 'Budget review'))
  for (let m = 21; m < 30; m++) r.feed(focus(chrome, 'Budget review - Google Docs', T0 + m * MIN))
  r.feed(focus(notes, 'Groceries', T0 + 30 * MIN, 'app_changed'))
  r.feed(line('session', { state: 'locked', snapshot: false }, T0 + 31 * MIN))
  r.store.flush()
}

