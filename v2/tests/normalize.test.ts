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

test('a window’s file is kept with its title, and never for a window whose title is withheld', () => {
  const { sink, n } = setup()
  const withFile = (l: ReturnType<typeof focus>, file: string) => ((l.obs as { window: { document?: string } }).window.document = file, l)
  n.handle(withFile(focus(app('com.example.notes'), 'Plan.txt', T0, 'app_changed'), '/Users/example/Plan.txt'))
  n.handle(withFile(focus(app('com.example.notes'), 'Plan.txt', T0 + 1), '/Users/example/Old/Plan.txt'))
  n.handle(withFile(focus(app('com.google.Chrome'), CANARY, T0 + 2, 'app_changed'), `/Users/example/${CANARY}.html`))
  assert.deepEqual(sink.rows.map((r) => r.document), ['/Users/example/Plan.txt', '/Users/example/Old/Plan.txt', null], 'another file under the same title is a new row')
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

test('a title that stays the same through long active work is never flagged; only losing the ability to read it is', () => {
  const { sink, n } = setup()
  const te = app('com.apple.TextEdit')
  n.handle(line('input', { state: 'active', last_input_wall_ms: T0, threshold_s: 120, snapshot: false }, T0))
  n.handle(focus(te, 'Draft.rtf', T0))
  for (let m = 1; m <= 180; m++) n.onTitleChannel('ok', T0 + m * 60_000)
  n.handle(focus(te, 'Draft.rtf', T0 + 181 * 60_000, 'reconcile'))
  assert.deepEqual(sink.rows.find((r) => r.kind === 'focus')!.flags, [], 'three hours in one document with input throughout is not stale')
  assert.equal(sink.rows.filter((r) => r.kind === 'focus').length, 1)
  n.onTitleChannel('stalled', T0 + 182 * 60_000)
  assert.deepEqual(sink.rows.find((r) => r.kind === 'focus')!.flags, ['possibly_stale'])
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
  assert.deepEqual(focusRows.map((r) => [r.tz, r.repeat_count]), [['Example/Town', 0], ['Europe/London', 1]])
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
  n.handle(focus(app('com.1password.1password'), CANARY, T0 + 8 * 3_600_000 + 5, 'snapshot'))
  assert.equal(sink.gaps.length, 1, 'still locked')
  n.handle(line('session', { state: 'unlocked', snapshot: false }, T0 + 8 * 3_600_000 + 8))
  n.handle(focus(app('com.1password.1password'), CANARY, T0 + 8 * 3_600_000 + 10, 'snapshot'))
  assert.equal(sink.gaps.length, 2)
  assert.equal(sink.gaps[1]!.start.wall_ms, T0 + 8 * 3_600_000 + 10, 'the night is not counted as excluded')
})

test('Codex registers for web links but is not a browser; Atlas stays withheld', () => {
  const { sink, n } = setup()
  n.handle(focus(app('com.openai.codex', { name: 'ChatGPT', registered_browser: true, engine: 'app_runtime', signer: '2DC432GLL2', pid: 1 }), 'Fix capture tests', T0, 'app_changed'))
  n.handle(focus(app('com.openai.atlas', { name: 'ChatGPT Atlas', registered_browser: true, pid: 2 }), `${CANARY} page`, T0 + 1, 'app_changed'))
  n.handle(focus(app('com.openai.atlas.beta', { name: 'ChatGPT Atlas', registered_browser: false, pid: 3 }), `${CANARY} beta`, T0 + 2, 'app_changed'))
  const [codex, atlas, beta] = sink.rows
  assert.equal(codex!.title, 'Fix capture tests')
  assert.equal(codex!.app_name, 'Codex', 'named after the product, not the bundle name')
  assert.equal(atlas!.title_state, 'withheld_browser')
  assert.equal(beta!.title_state, 'withheld_browser', 'Atlas is withheld even without a URL registration')
  assert.ok(!JSON.stringify(sink).includes(CANARY))
})

test('Codex keeps its titles only while its window is not reported private; exclusions still apply', () => {
  const { sink, n } = setup()
  const codex = app('com.openai.codex', { name: 'ChatGPT', registered_browser: true, engine: 'app_runtime', signer: '2DC432GLL2' })
  const at = (mode: 'normal' | 'private' | 'unknown' | undefined, title: string, t: number) => {
    const l = focus(codex, title, t, 'title_changed') as unknown as { obs: { window: Record<string, unknown> } }
    if (mode) l.obs.window.mode = mode
    return l as unknown as ReturnType<typeof focus>
  }
  n.handle(at(undefined, 'Fix capture tests', T0))
  n.handle(at('normal', 'Review the diff', T0 + 1))
  n.handle(at('private', `${CANARY} private page`, T0 + 2))
  assert.deepEqual(sink.rows.map((r) => [r.title, r.title_state]), [
    ['Fix capture tests', 'ok'],
    ['Review the diff', 'ok'],
    [null, 'withheld_browser'],
  ])
  const excluded = new Normalizer(sink, new Privacy([{ match: 'app_id', value: 'com.openai.codex', label: 'Codex' }]))
  excluded.handle(at(undefined, `${CANARY} excluded`, T0 + 3))
  assert.equal(sink.gaps.at(-1)!.reason, 'excluded')
  assert.ok(!JSON.stringify(sink).includes(CANARY))
  assert.ok(sink.rows.every((r) => !('url' in r)), 'no address is ever stored')
})

test('a browser on no list and without a link registration is still withheld when its engine says browser', () => {
  const { sink, n } = setup()
  const palemoon = app('C:\\Tools\\PaleMoonPortable\\App\\Palemoon\\palemoon.exe', {
    path: 'C:\\Tools\\PaleMoonPortable\\App\\Palemoon\\palemoon.exe',
    registered_browser: false,
    engine: 'browser',
  })
  n.handle(focus(palemoon, `${CANARY} Private Browsing`, T0, 'app_changed'))
  assert.equal(sink.rows[0]!.title_state, 'unknown')
  assert.equal(JSON.parse(sink.rows[0]!.detail!).title_reason, 'browser_engine')
  assert.ok(!JSON.stringify(sink).includes(CANARY))
})

test('when the helper cannot tell what engine an app has, its title is withheld', () => {
  const { sink, n } = setup()
  n.handle(focus(app('com.example.NewBrowser', { registered_browser: false, engine: 'unknown' }), `${CANARY} private`, T0, 'app_changed'))
  assert.equal(sink.rows[0]!.title_state, 'unknown')
  assert.equal(JSON.parse(sink.rows[0]!.detail!).title_reason, 'engine_uncertain')
  assert.equal(sink.rows[0]!.app_id, 'com.example.NewBrowser', 'the app time is still recorded')
  assert.ok(!JSON.stringify(sink).includes(CANARY))
})

test('an unregistered Electron browser with private tabs (Min, portable) stores no title', () => {
  const { sink, n } = setup()
  const minMac = app('com.electron.min', { engine: 'app_runtime', signer: null, pid: 1 })
  const minWin = app('C:\\Tools\\Min\\Min.exe', { path: 'C:\\Tools\\Min\\Min.exe', engine: 'app_runtime', signer: null, pid: 2 })
  n.handle(focus(minMac, `${CANARY} private tab`, T0, 'app_changed'))
  n.handle(focus(minWin, `${CANARY} private tab`, T0 + 1, 'app_changed'))
  for (const r of sink.rows) {
    assert.equal(r.title_state, 'unknown')
    assert.equal(JSON.parse(r.detail!).title_reason, 'web_runtime_not_listed')
  }
  assert.ok(!JSON.stringify(sink).includes(CANARY))
})

test('listed web-runtime apps keep their titles only with a matching OS-verified signer, never by ID or name alone', () => {
  const { sink, n } = setup()
  n.handle(focus(app('com.tinyspeck.slackmacgap', { engine: 'app_runtime', signer: 'BQR82RBBHL', pid: 1 }), 'general - Slack', T0, 'app_changed'))
  n.handle(focus(app('com.spotify.client', { engine: 'app_runtime', signer: '2FNC3A47ZF', pid: 2 }), 'Spotify Premium', T0 + 1, 'app_changed'))
  n.handle(focus(app('com.tinyspeck.slackmacgap', { engine: 'app_runtime', signer: null, pid: 3 }), `${CANARY} unsigned look-alike`, T0 + 2, 'app_changed'))
  n.handle(focus(app('com.tinyspeck.slackmacgap', { engine: 'app_runtime', signer: 'ABCDE12345', pid: 4 }), `${CANARY} other team`, T0 + 3, 'app_changed'))
  const slackExe = 'C:\\Users\\me\\AppData\\Local\\slack\\app-4.41.0\\slack.exe'
  n.handle(focus(app(slackExe, { path: slackExe, engine: 'app_runtime', signer: 'Slack Technologies, LLC', version_info: { original_filename: 'slack.exe', product_name: 'Slack' }, pid: 5 }), 'general - Slack', T0 + 4, 'app_changed'))
  n.handle(focus(app(slackExe, { path: slackExe, engine: 'app_runtime', signer: null, pid: 6 }), `${CANARY} unsigned slack.exe`, T0 + 5, 'app_changed'))
  n.handle(focus(app('MSTeams_8wekyb3d8bbwe!MSTeams', { engine: 'app_runtime', pid: 7, store: { aumid: 'MSTeams_8wekyb3d8bbwe!MSTeams', package: 'MSTeams_25.1.0_x64__8wekyb3d8bbwe' } }), 'Chat | Microsoft Teams', T0 + 6, 'app_changed'))
  assert.deepEqual(sink.rows.map((r) => r.title_state), ['ok', 'ok', 'unknown', 'unknown', 'ok', 'unknown', 'ok'])
  assert.ok(!JSON.stringify(sink).includes(CANARY))
})

test('a Windows trusted app must match its version resource; a browser engine or link handler is never exempted', () => {
  const { sink, n } = setup()
  const code = 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'
  const vs = { original_filename: 'Code.exe', product_name: 'Visual Studio Code' }
  const edge = { original_filename: 'msedge.exe', product_name: 'Microsoft Edge' }
  const at = (extra: object, title: string, t: number) => focus(app(code, { path: code, signer: 'Microsoft Corporation', pid: t, ...extra }), title, T0 + t, 'app_changed')
  n.handle(at({ engine: 'app_runtime', version_info: vs }, 'store.ts - v2 - Visual Studio Code', 1))
  n.handle(at({ engine: 'app_runtime', version_info: edge }, `${CANARY} renamed Edge`, 2))
  n.handle(at({ engine: 'app_runtime', version_info: null }, `${CANARY} no version resource`, 3))
  n.handle(at({ engine: 'browser', version_info: vs }, `${CANARY} browser engine under a trusted name`, 4))
  n.handle(at({ engine: 'app_runtime', version_info: vs, registered_browser: true }, `${CANARY} registered handler`, 5))
  assert.deepEqual(sink.rows.map((r) => r.title_state), ['ok', 'unknown', 'unknown', 'unknown', 'withheld_browser'])
  assert.ok(!JSON.stringify(sink).includes(CANARY))
})

test('Codex is the one listed app allowed to register for web links, as decided', () => {
  const { sink, n } = setup()
  n.handle(focus(app('com.openai.codex', { registered_browser: true, engine: 'app_runtime', signer: '2DC432GLL2', pid: 1 }), 'Fix capture tests', T0, 'app_changed'))
  n.handle(focus(app('com.tinyspeck.slackmacgap', { registered_browser: true, engine: 'app_runtime', signer: 'BQR82RBBHL', pid: 2 }), `${CANARY} slack as handler`, T0 + 1, 'app_changed'))
  assert.deepEqual(sink.rows.map((r) => r.title_state), ['ok', 'withheld_browser'])
})

test('a wall clock set back after a stop does not let a line stamped after it through', () => {
  for (const stop of ['woke', 'locked', 'display_off'] as const) {
    const { sink, n } = setup()
    if (stop === 'woke') n.handle(line('power', { state: 'resume' }, T0 + 100_000))
    if (stop === 'locked') n.handle(line('session', { state: 'locked', snapshot: false }, T0 + 100_000))
    if (stop === 'display_off') n.handle(line('power', { state: 'display_off' }, T0 + 100_000))
    // Two seconds later by the monotonic clock, after the wall clock was set back a minute.
    const late = focus(app('com.apple.Terminal'), 'secret.md', T0 + 42_000, 'snapshot')
    n.handle({ ...late, t: { ...late.t, mono_us: (T0 + 102_000) * 1000 } } as typeof late)
    assert.deepEqual(sink.rows.filter((r) => r.kind === 'focus').map((r) => r.title), [], stop)
  }
})
