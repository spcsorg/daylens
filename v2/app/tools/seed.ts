// Fills a data folder with two invented days through the engine's own normalizer and storage, so the interface can be
// shown and measured without anyone's real record. Times are relative to now: yesterday 8 AM to 6 PM, and today from
// 8 AM to the current minute.
// Usage: node app/tools/seed.ts --data-dir <dir> [--days 2] [--switch-s 45] [--now <ISO time>]  (--switch-s: a busier day, a new
// window title that often; --now: seed as of that moment, so an evaluation always sees the same day)
import { existsSync, mkdirSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { Normalizer, Privacy } from '../../capture/normalize.ts'
import type { AppIdentity, Kind, Line, LineOf, ObsByKind } from '../../capture/protocol.ts'
import { Store } from '../../capture/store.ts'
import { Storage } from '../../storage/index.ts'

const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, days: { type: 'string', default: '2' }, 'switch-s': { type: 'string' }, now: { type: 'string' } } })
const dir = values['data-dir']
if (!dir) {
  process.stderr.write('usage: seed.ts --data-dir <dir>\n')
  process.exit(64)
}
if (existsSync(`${dir}/daylens-v2.sqlite`)) {
  process.stderr.write('refusing to seed a folder that already has a database\n')
  process.exit(1)
}
mkdirSync(dir, { recursive: true })

const MIN = 60_000
const tzOffset = -new Date().getTimezoneOffset()
let seq = 0
// One capture run per day seeded: the engine counts time as recorded only inside a run.
let run = 'run-seed'
function line<K extends Kind>(kind: K, obs: ObsByKind[K], wallMs: number): Line {
  return {
    v: 1,
    run,
    seq: seq++,
    boot: 'boot-seed',
    t: { wall_ms: wallMs, mono_us: wallMs * 1000, tz: 'Example/Town', tz_offset_min: tzOffset },
    platform: 'macos',
    source: 'seed',
    kind,
    obs,
  } as Line
}

function app(appId: string, name: string, path: string): AppIdentity {
  return { app_id: appId, name, path, pid: 100, registered_browser: false, engine: 'none', signer: null, version_info: null, identity_state: 'ok', store: null }
}

const notes = app('com.apple.Notes', 'Notes', '/System/Applications/Notes.app')
const mail = app('com.apple.mail', 'Mail', '/System/Applications/Mail.app')
const calendar = app('com.apple.iCal', 'Calendar', '/System/Applications/Calendar.app')
const preview = app('com.apple.Preview', 'Preview', '/System/Applications/Preview.app')
const textedit = app('com.apple.TextEdit', 'TextEdit', '/System/Applications/TextEdit.app')
const numbers = app('com.apple.reminders', 'Reminders', '/System/Applications/Reminders.app')
const terminal = app('com.apple.Terminal', 'Terminal', '/System/Applications/Utilities/Terminal.app')
const chrome = app('com.google.Chrome', 'Google Chrome', '/Applications/Google Chrome.app')

// [minutes into the hour, app, window title], one hour's worth of focus changes.
const HOURS: [number, AppIdentity, string][][] = [
  [[0, mail, 'Weekend cake orders'], [18, notes, 'Order list for Saturday'], [40, calendar, 'Week of deliveries']],
  [[0, numbers, 'Flour and butter costs'], [20, chrome, 'Mill Lane Flour – wholesale prices'], [35, mail, 'Re: Supplier price change']],
  [[0, textedit, 'Autumn menu draft.rtf'], [30, preview, 'Autumn menu proof.pdf']],
  [[0, terminal, 'brightside-site — npm run dev'], [25, textedit, 'order-form notes.txt'], [50, notes, 'Order form checklist']],
  [[0, terminal, 'brightside-site — git log'], [20, notes, 'Card payment questions']],
  [[0, mail, 'Corner Café invoice for October'], [15, numbers, 'Invoices to send'], [45, mail, 'Sent: October invoice']],
  [[0, calendar, 'Pickup schedule'], [30, notes, 'Pickup reminders']],
  [[0, preview, 'Packaging labels.pdf'], [40, textedit, 'Label wording.rtf']],
  [[0, mail, 'Wholesale enquiry'], [10, chrome, 'Corner Café – menu and opening hours'], [20, numbers, 'Wholesale follow-ups']],
  [[0, notes, 'Tomorrow’s bakes'], [30, calendar, 'Thursday']],
]

// What the browser extension reports for the pages open in Chrome; without it a browser window's title isn't kept.
const PAGES: Record<string, string> = {
  'Mill Lane Flour – wholesale prices': 'https://millaneflour.example/wholesale',
  'Corner Café – menu and opening hours': 'https://cornercafe.example/menu',
}

const now = values.now ? Date.parse(values.now) : Date.now()
if (!Number.isFinite(now)) throw new Error('--now must be a time')
const store = new Store(dir)
const storage = new Storage(store, dir, { deletionStallMs: Infinity })
const normalizer = new Normalizer(store, new Privacy(store.exclusions()))
storage.attachCapture({ interrupt: () => normalizer.interrupt({ wall_ms: Date.now(), mono_us: null, boot: null }), setPrivacy: (p) => normalizer.setPrivacy(p) })

function seedDay(dayStart: number, until: number): void {
  for (let h = 0; h < HOURS.length; h++) {
    const hourStart = dayStart + (8 + h) * 60 * MIN
    // Lunch: the computer sleeps from 12 to 1 on the first day seeded.
    if (h === 4 && until !== now) {
      normalizer.handle(line('power', { state: 'sleep' }, hourStart))
      normalizer.handle(line('power', { state: 'resume_user' }, hourStart + 60 * MIN - 1000))
      continue
    }
    for (const [i, [m, a, title]] of HOURS[h]!.entries()) {
      const t = hourStart + m * MIN
      if (t >= until) return
      const next = HOURS[h]![i + 1]?.[0] ?? 60
      normalizer.handle(line('focus', { trigger: 'app_changed', app: a, window: { window: `w${h}${i}`, title, title_state: 'ok' } }, t))
      const url = PAGES[title]
      if (url) {
        store.insertObservation({
          run: 'run-seed-ext', seq: seq++, boot: 'boot-seed', platform: 'macos', source: 'browser_ext', kind: 'page', event_wall_ms: t, event_mono_us: t * 1000, tz: 'Example/Town',
          tz_offset_min: tzOffset, app_id: a.app_id, app_name: a.name, app_path: a.path, pid: a.pid, window: 'ext:1', title, title_raw: null, title_state: 'ok', state: 'normal', detail: null, url,
        })
      }
      const step = switchMs ?? 60_000
      for (let s = t + step, n = 1; s < Math.min(hourStart + next * MIN, until); s += step, n++) {
        const shown = switchMs ? `${title} (${n})` : title
        normalizer.handle(line('focus', { trigger: switchMs ? 'title_changed' : 'reconcile', app: a, window: { window: `w${h}${i}`, title: shown, title_state: 'ok' } }, s))
      }
    }
  }
}

const days = Number(values.days)
const switchMs = values['switch-s'] ? Number(values['switch-s']) * 1000 : null
const today = new Date(now)
for (let d = days - 1; d >= 0; d--) {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - d).getTime()
  const until = d === 0 ? now : start + 24 * 60 * MIN
  run = `run-seed-${d}`
  store.startRun(line('hello', { awake_us: 0, helper: 'seed', boot_identity: 'kernel', version: '1', pid: 1, os: 'seed', permissions: { accessibility: 'granted' }, config: { heartbeat_s: 15, idle_threshold_s: 120, reconcile_s: 60 } }, start + 8 * 60 * MIN) as LineOf<'hello'>)
  seedDay(start, until)
  store.recordHeartbeat(line('heartbeat', { awake_us: 0, permissions: { accessibility: 'granted' }, registrations: { focus: true, session: true, power: true }, titles: 'ok', stall_ms: 0, dropped: 0 }, Math.min(until, start + (8 + HOURS.length) * 60 * MIN)))
}
store.flush(true)
storage.start()
await storage.derivationSettled()
storage.stop()
store.close()
process.stdout.write(`seeded ${dir}\n`)
