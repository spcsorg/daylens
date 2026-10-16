// A scriptable stand-in for a native helper, speaking protocol v1.
import { randomUUID } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const mode = process.env.FAKE_MODE ?? 'normal'
const hbMs = Number(process.env.FAKE_HB_MS ?? 100)
const afterMs = Number(process.env.FAKE_AFTER_MS ?? 400)
const canary = process.env.FAKE_CANARY ?? 'CANARY'
if (process.env.FAKE_PIDFILE) appendFileSync(process.env.FAKE_PIDFILE, `${process.pid}\n`)

const run = randomUUID()
const started = Date.now()
let seq = 0
const t = () => ({ wall_ms: Date.now(), mono_us: Math.round((performance.timeOrigin + performance.now()) * 1000), tz: 'UTC', tz_offset_min: 0 })

function emit(kind: string, obs: unknown, source = 'fake'): void {
  if (mode === 'skip_seq' && seq === 5) seq += 3
  process.stdout.write(JSON.stringify({ v: 1, run, seq: seq++, boot: 'boot-fake', t: t(), platform: 'macos', source, kind, obs }) + '\n')
}

const term = { app_id: 'com.apple.Terminal', name: 'Terminal', path: null, pid: 501, registered_browser: false, engine: 'none', identity_state: 'ok', store: null }
const chrome = { app_id: 'com.google.Chrome', name: 'Chrome', path: null, pid: 502, registered_browser: true, engine: 'browser', identity_state: 'ok', store: null }
let n = 0
function focus(trigger: string): void {
  const browser = n % 2 === 1
  emit('focus', { trigger, app: browser ? chrome : term, window: { window: 'w', title: browser ? `${canary} page ${n}` : `zsh ${n}`, title_state: 'ok' } })
}
function snapshot(): void {
  focus('snapshot')
  emit('input', { state: 'active', last_input_wall_ms: Date.now(), threshold_s: 120, snapshot: true })
  emit('session', { state: 'unlocked', snapshot: true })
  if (process.env.FAKE_SNAPFILE) appendFileSync(process.env.FAKE_SNAPFILE, 'snapshot\n')
}

emit('hello', { helper: 'fake', version: '0', pid: process.pid, os: 'test', permissions: { accessibility: 'granted' }, config: { heartbeat_s: 1, idle_threshold_s: 120, reconcile_s: 60 } })
if (mode === 'crash_always') process.exit(3)
snapshot()

let heartbeats = true
let asleep = false
let sleepStart = 0
let sleptUs = 0
const awakeUs = () => t().mono_us - sleptUs
const hb = setInterval(() => {
  if (heartbeats && !asleep)
    emit('heartbeat', {
      awake_us: awakeUs(),
      permissions: { accessibility: 'granted' },
      registrations: { focus: true, session: !(mode === 'session_unregistered' && Date.now() - started < afterMs), power: true },
      titles: mode === 'titles_stalled' || mode === 'titles_stuck' ? 'stalled' : 'ok',
      stall_ms: mode === 'titles_stuck' ? Date.now() - started : 0,
      dropped: 0,
    })
}, hbMs)
let focusPaused = false
setInterval(() => {
  if (focusPaused) return
  n++
  focus(n % 2 === 1 ? 'app_changed' : 'title_changed')
}, Number(process.env.FAKE_FOCUS_MS ?? 150))

setTimeout(() => {
  switch (mode) {
    case 'crash':
      process.exit(3)
    case 'main_stuck':
      heartbeats = false
      break
    case 'sleep_then_hang':
      emit('power', { state: 'sleep' })
      heartbeats = false
      break
    case 'loss':
      // A switch to B was dropped 8 s ago; the next focus line (C) is the first trustworthy one.
      focusPaused = true
      emit('loss', { channel: 'focus', count: 1, from_wall_ms: Date.now() - 8000, to_wall_ms: Date.now() - 8000 })
      setTimeout(() => {
        focusPaused = false
        focus('app_changed')
      }, 400)
      break
    case 'session_unregistered':
      emit('session', { state: 'locked', snapshot: false })
      emit('session', { state: 'unlocked', snapshot: false })
      break
    case 'garbage':
      process.stdout.write(`not json ${canary}\n`)
      process.stdout.write(JSON.stringify({ v: 1, run, seq: 999, kind: 'focus', obs: { title: canary } }) + '\n')
      process.stdout.write('x'.repeat(20_000) + canary + '\n')
      process.stderr.write(`Error: failed to read title "${canary}"\n`)
      process.stderr.write('code=ax_error state=-25204\n')
      break
  }
}, afterMs)

// Simulated sleep: awake time stops between these two signals, as CLOCK_UPTIME_RAW does.
process.on('SIGUSR1', () => {
  emit('power', { state: 'sleep' })
  asleep = true
  sleepStart = t().mono_us
})
process.on('SIGUSR2', () => {
  if (asleep) sleptUs += t().mono_us - sleepStart
  asleep = false
  emit('power', { state: 'resume' })
})

createInterface({ input: process.stdin })
  .on('line', (l) => {
    const msg = JSON.parse(l) as { op: string }
    if (msg.op === 'snapshot') snapshot()
    if (msg.op === 'shutdown' && mode !== 'ignore_shutdown') {
      emit('bye', { reason: 'shutdown' })
      clearInterval(hb)
      process.exit(0)
    }
  })
  .on('close', () => {
    if (process.env.FAKE_EOF_FILE) writeFileSync(process.env.FAKE_EOF_FILE, String(Date.now()))
    process.exit(0)
  })
