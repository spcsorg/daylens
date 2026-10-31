// A stand-in capture helper for showing the interface on invented data: it reports three invented windows in turn and
// nothing about the real computer. DEMO_ACCESSIBILITY=denied shows the window-title permission as missing.
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? Number(process.argv[i + 1]) : fallback
}
const heartbeatS = arg('--heartbeat-s', 15)
const accessibility = process.env.DEMO_ACCESSIBILITY === 'denied' ? 'denied' : 'granted'
const run = randomUUID()
let seq = 0
const t = () => ({ wall_ms: Date.now(), mono_us: Math.round((performance.timeOrigin + performance.now()) * 1000), tz: 'Example/Town', tz_offset_min: -new Date().getTimezoneOffset() })
const emit = (kind: string, obs: unknown) => process.stdout.write(JSON.stringify({ v: 1, run, seq: seq++, boot: 'boot-demo', t: t(), platform: 'macos', source: 'demo', kind, obs }) + '\n')
const app = (app_id: string, name: string, path: string) => ({ app_id, name, path, pid: 700, registered_browser: false, engine: 'none', signer: null, version_info: null, identity_state: 'ok', store: null })
const windows: { app: ReturnType<typeof app>; title: string; document?: string }[] = [
  { app: app('notion.id', 'Notion', '/Applications/Notion.app'), title: 'Pricing research' },
  { app: app('com.apple.mail', 'Mail', '/System/Applications/Mail.app'), title: 'Re: Q2 budget' },
  { app: app('com.apple.TextEdit', 'TextEdit', '/System/Applications/TextEdit.app'), title: 'Pricing memo.txt', document: path.join(homedir(), 'Documents', 'Pricing memo.txt') },
]
let n = 0
const focus = (trigger: string) => {
  const w = windows[n % windows.length]!
  const granted = accessibility === 'granted'
  emit('focus', { trigger, app: w.app, window: { window: `demo${n % windows.length}`, title: granted ? w.title : null, title_state: granted ? 'ok' : 'no_permission', ...(granted && w.document ? { document: w.document } : {}) } })
}
const snapshot = () => {
  emit('power', { state: 'display_on', snapshot: true })
  emit('session', { state: 'unlocked', snapshot: true })
  focus('snapshot')
  emit('input', { state: 'active', last_input_wall_ms: Date.now(), threshold_s: 120, snapshot: true })
}
emit('hello', { awake_us: t().mono_us, helper: 'demo', boot_identity: 'kernel', version: '0', pid: process.pid, os: 'demo', permissions: { accessibility }, config: { heartbeat_s: heartbeatS, idle_threshold_s: 120, reconcile_s: 60 } })
// The lid opens as the stand-in starts: a seeded day may have ended with it closed.
emit('power', { state: 'resume_user' })
snapshot()
setInterval(() => {
  emit('heartbeat', { awake_us: t().mono_us, permissions: { accessibility }, registrations: { focus: true, session: true, power: true }, titles: accessibility === 'granted' ? 'ok' : 'no_permission', stall_ms: 0, dropped: 0 })
}, heartbeatS * 1000)
setInterval(() => {
  n++
  focus('app_changed')
}, 90_000)
createInterface({ input: process.stdin })
  .on('line', (l) => {
    const msg = JSON.parse(l) as { op: string }
    if (msg.op === 'snapshot') snapshot()
    if (msg.op === 'shutdown') {
      emit('bye', { reason: 'shutdown' })
      process.exit(0)
    }
  })
  .on('close', () => process.exit(0))
