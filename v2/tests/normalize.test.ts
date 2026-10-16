import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanTitle, Normalizer, Privacy } from '../capture/normalize.ts'
import { MemorySink } from './support/memorySink.ts'
import { app, focus, line } from './support/lines.ts'

const T0 = 1_792_130_000_000
const CANARY = 'CANARY-7f3a-secret-page'

function setup() {
  const sink = new MemorySink()
  return { sink, n: new Normalizer(sink, new Privacy()) }
}

test('cleanTitle strips spinner frames at the edges only', () => {
  const cases: [string, string | null][] = [
    ['⠋ Claude Code', 'Claude Code'],
    ['⠙ Claude Code', 'Claude Code'],
    ['✳ Fix capture', 'Fix capture'],
    ['· Fix capture', 'Fix capture'],
    ['◐ npm run build', 'npm run build'],
    ['npm run build ◓', 'npm run build'],
    ['🌘 deploy', 'deploy'],
    ['🕐 deploy', 'deploy'],
    ['⏳ installing', 'installing'],
    ['⠋', null],
    ['   spaced    out   ', 'spaced out'],
  ]
  for (const [raw, want] of cases) assert.equal(cleanTitle(raw).title, want, raw)
})

test('cleanTitle keeps meaningful text that only looks like progress', () => {
  const keep = [
    '⠃⠗⠁⠊⠇⠇⠑ notes',
    'Inbox · Gmail',
    '50% off sale.pdf',
    'Q3 revenue up 45%',
    'Chapter 3/10 draft',
    'Budget 2026 — Numbers',
    '✳✳✳ stars',
  ]
  for (const t of keep) assert.equal(cleanTitle(t).title, t, t)
})

test('cleanTitle strips progress indicators', () => {
  const cases: [string, string][] = [
    ['[45%] Downloading model', 'Downloading model'],
    ['45% - Downloading model', 'Downloading model'],
    ['Downloading model (45%)', 'Downloading model'],
    ['Downloading model — 45%', 'Downloading model'],
    ['Build [####------] app', 'Build app'],
    ['Copy ███░░░ files', 'Copy files'],
    ['(3) Slack | general', 'Slack | general'],
  ]
  for (const [raw, want] of cases) assert.equal(cleanTitle(raw).title, want, raw)
})

test('an animated terminal title is one observation, not one per frame', () => {
  const { sink, n } = setup()
  const term = app('com.apple.Terminal')
  const frames = ['◐', '◓', '◑', '◒']
  for (let s = 0; s < 60; s++) n.handle(focus(term, `${frames[s % 4]} claude — daylens`, T0 + s * 1000))
  assert.equal(sink.rows.length, 1)
  assert.equal(sink.rows[0]!.title, 'claude — daylens')
  assert.equal(sink.rows[0]!.title_raw, '◐ claude — daylens')
  assert.equal(sink.rows[0]!.repeat_count, 59)
  assert.equal(sink.rows[0]!.last_seen_wall_ms, T0 + 59_000)
})

test('repeated identical observations merge; a real change inserts', () => {
  const { sink, n } = setup()
  const code = app('com.microsoft.VSCode')
  n.handle(focus(code, 'a.ts — v2', T0, 'app_changed'))
  n.handle(focus(code, 'a.ts — v2', T0 + 60_000, 'reconcile'))
  n.handle(focus(code, 'a.ts — v2', T0 + 61_000, 'snapshot'))
  n.handle(focus(code, 'b.ts — v2', T0 + 62_000))
  n.handle(focus(code, 'a.ts — v2', T0 + 63_000))
  assert.deepEqual(sink.rows.map((r) => [r.title, r.repeat_count]), [['a.ts — v2', 2], ['b.ts — v2', 0], ['a.ts — v2', 0]])
})

test('sub-second switches are all kept with their own times', () => {
  const { sink, n } = setup()
  const a = app('com.apple.Notes', { pid: 1 })
  const b = app('com.apple.mail', { pid: 2 })
  n.handle(focus(a, 'Note', T0, 'app_changed'))
  n.handle(focus(b, 'Inbox', T0 + 120, 'app_changed'))
  n.handle(focus(a, 'Note', T0 + 250, 'app_changed'))
  assert.deepEqual(sink.rows.map((r) => [r.app_id, r.event_wall_ms]), [
    ['com.apple.Notes', T0],
    ['com.apple.mail', T0 + 120],
    ['com.apple.Notes', T0 + 250],
  ])
})

test('browser windows keep app time but never their title', () => {
  const { sink, n } = setup()
  const browsers = [
    app('com.example.SomeNewBrowser', { registered_browser: true }),
    app('com.google.Chrome'),
    app('C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', { path: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe' }),
  ]
  let t = T0
  for (const b of browsers) {
    n.handle(focus(b, `${CANARY} - Google Search`, t++, 'app_changed'))
    n.handle(focus(b, `${CANARY} other tab`, t++))
  }
  assert.equal(sink.rows.length, 3, 'tab changes inside one browser merge into one row')
  for (const r of sink.rows) {
    assert.equal(r.title, null)
    assert.equal(r.title_raw, null)
    assert.equal(r.title_state, 'withheld_browser')
  }
  assert.ok(!JSON.stringify(sink).includes(CANARY))
})

test('an app whose identity could not be resolved never stores a title', () => {
  const { sink, n } = setup()
  for (const state of ['access_denied', 'timeout', 'gone'] as const) {
    n.handle(focus(app('com.google.Chrome', { identity_state: state, pid: 7 }), `${CANARY} ${state}`, T0))
  }
  n.handle(focus(app(null), CANARY, T0 + 1))
  assert.ok(sink.rows.every((r) => r.title === null && r.title_state === 'withheld_unknown_app' && r.app_id === null))
  assert.ok(!JSON.stringify(sink).includes(CANARY))
})

test('excluded apps leave only an excluded gap', () => {
  const { sink, n } = setup()
  n.handle(focus(app('com.apple.Terminal'), 'zsh', T0, 'app_changed'))
  n.handle(focus(app('com.1password.1password', { name: '1Password' }), `${CANARY} vault`, T0 + 1000, 'app_changed'))
  n.handle(focus(app('com.1password.1password', { name: '1Password' }), `${CANARY} item`, T0 + 2000))
  n.handle(line('input', { state: 'idle', last_input_wall_ms: T0 + 2000, threshold_s: 120, snapshot: false }, T0 + 122_000))
  n.handle(focus(app('com.apple.Terminal'), 'zsh', T0 + 130_000, 'app_changed'))
  assert.equal(sink.gaps.length, 1)
  assert.equal(sink.gaps[0]!.reason, 'excluded')
  assert.equal(sink.gaps[0]!.start.wall_ms, T0 + 1000)
  assert.equal(sink.gaps[0]!.end!.wall_ms, T0 + 130_000)
  assert.deepEqual(sink.rows.map((r) => r.kind), ['focus', 'input', 'focus'])
  const dump = JSON.stringify(sink)
  assert.ok(!dump.includes(CANARY) && !dump.includes('1password') && !dump.includes('1Password'))
})

test('exclusions match Windows executables and packaged app ids', () => {
  const { sink, n } = setup()
  n.handle(focus(app('C:\\Program Files\\Bitwarden\\Bitwarden.exe', { path: 'C:\\Program Files\\Bitwarden\\Bitwarden.exe' }), CANARY, T0))
  const p = new Privacy([{ match: 'app_id', value: 'Contoso.Vault_abc!App', label: 'Vault' }])
  assert.equal(p.classify(app('x', { store: { aumid: 'Contoso.Vault_abc!App', package: null } })).excluded, true)
  assert.equal(sink.rows.length, 0)
  assert.equal(sink.gaps[0]!.reason, 'excluded')
})

test('interrupt closes an open excluded gap so gaps never overlap', () => {
  const { sink, n } = setup()
  n.handle(focus(app('com.bitwarden.desktop'), CANARY, T0))
  n.interrupt({ wall_ms: T0 + 5000, mono_us: null, boot: null })
  assert.equal(sink.gaps[0]!.end!.wall_ms, T0 + 5000)
  n.handle(focus(app('com.bitwarden.desktop'), CANARY, T0 + 9000, 'snapshot'))
  assert.equal(sink.gaps.length, 2)
  assert.equal(sink.gaps[1]!.end, null)
})

test('granted then revoked: the current title is flagged possibly stale', () => {
  const { sink, n } = setup()
  n.handle(focus(app('com.apple.TextEdit'), 'Draft.rtf', T0))
  n.onTitleChannel('ok', T0 + 15_000)
  assert.deepEqual(sink.rows[0]!.flags, [])
  n.onTitleChannel('no_permission', T0 + 30_000)
  assert.deepEqual(sink.rows[0]!.flags, ['possibly_stale'])
})

test('stalled then recovered with the same title: the fresh read is a new row, not merged into the stale one', () => {
  const { sink, n } = setup()
  const te = app('com.apple.TextEdit')
  n.handle(focus(te, 'Draft.rtf', T0))
  n.onTitleChannel('stalled', T0 + 15_000)
  n.handle(focus(te, 'Draft.rtf', T0 + 20_000, 'reconcile'))
  assert.equal(sink.rows.length, 1, 'while still stalled, repeats extend the stale row')
  n.onTitleChannel('ok', T0 + 30_000)
  n.handle(focus(te, 'Draft.rtf', T0 + 31_000, 'reconcile'))
  n.handle(focus(te, 'Draft.rtf', T0 + 60_000, 'reconcile'))
  assert.equal(sink.rows.length, 2)
  assert.deepEqual(sink.rows.map((r) => r.flags), [['possibly_stale'], []])
  assert.equal(sink.rows[1]!.repeat_count, 1, 'later repeats merge into the fresh row')
})

test('input-aware: a title unchanged for 15 minutes while input continues is flagged; idle time does not count', () => {
  const { sink, n } = setup()
  const te = app('com.apple.TextEdit')
  const input = (state: 'idle' | 'active', t: number) => line('input', { state, last_input_wall_ms: t, threshold_s: 120, snapshot: false }, t)
  n.handle(input('active', T0))
  n.handle(focus(te, 'Draft.rtf', T0))
  n.onTitleChannel('ok', T0 + 10 * 60_000)
  n.handle(input('idle', T0 + 10 * 60_000))
  n.onTitleChannel('ok', T0 + 30 * 60_000)
  assert.deepEqual(sink.rows.find((r) => r.kind === 'focus')!.flags, [], 'reading without input is not stale')
  n.handle(input('active', T0 + 30 * 60_000))
  n.onTitleChannel('ok', T0 + 44 * 60_000)
  assert.deepEqual(sink.rows.find((r) => r.kind === 'focus')!.flags, [])
  n.onTitleChannel('ok', T0 + 45 * 60_000)
  assert.deepEqual(sink.rows.find((r) => r.kind === 'focus')!.flags, ['possibly_stale'])
  n.handle(focus(te, 'Draft.rtf', T0 + 46 * 60_000, 'reconcile'))
  assert.equal(sink.rows.filter((r) => r.kind === 'focus').length, 1, 'an input-stale title is not "fresh" on the next read')
})

test('clock and time zone changes are kept as events, and a zone change splits the focus row', () => {
  const { sink, n } = setup()
  const te = app('com.apple.TextEdit')
  const at = (l: ReturnType<typeof focus>, tz: string, off: number) => ({ ...l, t: { ...l.t, tz, tz_offset_min: off } }) as typeof l
  n.handle(focus(te, 'Draft.rtf', T0))
  n.handle(line('clock', { change: 'time_changed' }, T0 + 1000))
  n.handle(line('clock', { change: 'time_changed' }, T0 + 2000))
  n.handle(line('clock', { change: 'timezone_changed' }, T0 + 3000))
  n.handle(line('clock', { change: 'timezone_changed' }, T0 + 4000))
  n.handle(at(focus(te, 'Draft.rtf', T0 + 5000, 'reconcile'), 'Europe/London', 60))
  n.handle(at(focus(te, 'Draft.rtf', T0 + 6000, 'reconcile'), 'Europe/London', 60))
  const clocks = sink.rows.filter((r) => r.kind === 'clock')
  assert.deepEqual(clocks.map((r) => [r.state, r.event_wall_ms]), [
    ['time_changed', T0 + 1000],
    ['time_changed', T0 + 2000],
    ['timezone_changed', T0 + 3000],
    ['timezone_changed', T0 + 4000],
  ])
  const focusRows = sink.rows.filter((r) => r.kind === 'focus')
  assert.deepEqual(focusRows.map((r) => [r.tz, r.repeat_count]), [['Africa/Kigali', 0], ['Europe/London', 1]])
})

test('waking is not the user returning; unlock or new input after resume is', () => {
  const { sink, n } = setup()
  const presence = () => sink.rows.filter((r) => r.kind === 'presence').length
  n.handle(line('power', { state: 'sleep' }, T0))
  n.handle(line('power', { state: 'resume' }, T0 + 3_600_000))
  n.handle(line('input', { state: 'idle', last_input_wall_ms: T0 - 1000, threshold_s: 120, snapshot: true }, T0 + 3_600_001))
  n.handle(line('session', { state: 'unlocked', snapshot: true }, T0 + 3_600_002))
  assert.equal(presence(), 0, 'automatic wake with stale input and a snapshot is not a return')
  n.handle(line('power', { state: 'resume' }, T0 + 3_600_003))
  n.handle(line('input', { state: 'active', last_input_wall_ms: T0 + 3_700_000, threshold_s: 120, snapshot: false }, T0 + 3_700_000))
  assert.equal(presence(), 1)
  assert.equal(sink.rows.find((r) => r.kind === 'presence')!.event_wall_ms, T0 + 3_700_000)
  n.handle(line('session', { state: 'locked', snapshot: false }, T0 + 3_800_000))
  n.handle(line('session', { state: 'unlocked', snapshot: false }, T0 + 3_900_000))
  assert.equal(presence(), 1, 'unlock without a resume is not counted as a return from sleep')
})

test('Windows resume followed by user resume gives one return and idempotent power rows', () => {
  const { sink, n } = setup()
  n.handle(line('power', { state: 'sleep' }, T0))
  n.handle(line('power', { state: 'resume' }, T0 + 1000))
  n.handle(line('power', { state: 'resume' }, T0 + 1001))
  n.handle(line('power', { state: 'resume_user' }, T0 + 2000))
  n.handle(line('power', { state: 'resume_user' }, T0 + 2001))
  assert.deepEqual(sink.rows.map((r) => `${r.kind}:${r.state}:${r.repeat_count}`), [
    'power:sleep:0',
    'power:resume:1',
    'presence:returned:0',
    'power:resume_user:1',
  ])
})

test('locking or sleeping ends an excluded gap; a later snapshot reopens it', () => {
  const { sink, n } = setup()
  n.handle(focus(app('com.1password.1password'), CANARY, T0, 'app_changed'))
  n.handle(line('session', { state: 'locked', snapshot: false }, T0 + 1000))
  n.handle(line('power', { state: 'sleep' }, T0 + 2000))
  assert.equal(sink.gaps[0]!.end!.wall_ms, T0 + 1000)
  n.handle(line('power', { state: 'resume' }, T0 + 8 * 3_600_000))
  n.handle(focus(app('com.1password.1password'), CANARY, T0 + 8 * 3_600_000 + 10, 'snapshot'))
  assert.equal(sink.gaps.length, 2)
  assert.equal(sink.gaps[1]!.start.wall_ms, T0 + 8 * 3_600_000 + 10, 'the night is not counted as excluded')
})
