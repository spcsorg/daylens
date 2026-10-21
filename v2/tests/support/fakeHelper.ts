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
const wallOffset = Number(process.env.FAKE_WALL_OFFSET_MS ?? 0)
// A new boot: the monotonic clock restarts near zero.
const monoBase = process.env.FAKE_NEW_BOOT_UPTIME_MS ? performance.timeOrigin + performance.now() - Number(process.env.FAKE_NEW_BOOT_UPTIME_MS) : 0
const t = () => ({ wall_ms: Date.now() + wallOffset, mono_us: Math.round((performance.timeOrigin + performance.now() - monoBase) * 1000), tz: 'UTC', tz_offset_min: 0 })

// How the Windows helper names the boot: the kernel counter (stable), or the old wall-minus-uptime formula.
function bootId(time: { wall_ms: number; mono_us: number }): string {
  if (process.env.FAKE_BOOT === 'counter') return process.env.FAKE_NEW_BOOT_UPTIME_MS ? 'boot-813' : 'boot-812'
  if (process.env.FAKE_BOOT === 'clock') return `bootclock-${Math.floor((time.wall_ms - time.mono_us / 1000) / 60_000)}`
  // A clock-derived name that happens to match across runs, as after a reboot plus a clock correction.
  if (process.env.FAKE_BOOT === 'clockfixed') return 'bootclock-29868833'
  return 'boot-fake'
}

function emit(kind: string, obs: unknown, source = 'fake'): void {
  if (mode === 'skip_seq' && seq === 5) seq += 3
  const time = t()
  process.stdout.write(JSON.stringify({ v: 1, run, seq: seq++, boot: bootId(time), t: time, platform: 'macos', source, kind, obs }) + '\n')
}

const term = { app_id: 'com.apple.Terminal', name: 'Terminal', path: null, pid: 501, registered_browser: false, engine: 'none', signer: null, version_info: null, identity_state: 'ok', store: null }
const chrome = { app_id: 'com.google.Chrome', name: 'Chrome', path: null, pid: 502, registered_browser: true, engine: 'browser', signer: 'EQHXZ8M8AV', version_info: null, identity_state: 'ok', store: null }
let n = 0
function focus(trigger: string): void {
  const browser = n % 2 === 1
  emit('focus', { trigger, app: browser ? chrome : term, window: { window: 'w', title: browser ? `${canary} page ${n}` : `zsh ${n}`, title_state: 'ok' } })
}
function snapshot(): void {
  focus('snapshot')
  emit('input', { state: 'active', last_input_wall_ms: Date.now(), threshold_s: 120, snapshot: true })
  emit('session', { state: 'unlocked', snapshot: true })
  // Lines emitted through this snapshot: the file is written before the supervisor has read them.
  if (process.env.FAKE_SNAPFILE) appendFileSync(process.env.FAKE_SNAPFILE, `snapshot ${seq}\n`)
}

emit('hello', { helper: 'fake', boot_identity: process.env.FAKE_BOOT?.startsWith('clock') ? 'clock' : 'kernel', version: '0', pid: process.pid, os: 'test', permissions: { accessibility: 'granted' }, config: { heartbeat_s: 1, idle_threshold_s: 120, reconcile_s: 60 } })
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
      titles: mode === 'titles_stalled' || mode === 'titles_stuck' || (mode === 'titles_recover' && Date.now() - started < afterMs) ? 'stalled' : 'ok',
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
    case 'loss': {
      // A switch to B was dropped 8 s ago; the next focus line (C) is the first trustworthy one.
      focusPaused = true
      const now = Date.now()
      emit('loss', { channel: 'focus', count: 1, from_wall_ms: now - 8000, to_wall_ms: now - 8000 })
      setTimeout(() => {
        focusPaused = false
        focus('app_changed')
      }, 400)
      break
    }
    case 'display_cycle':
      emit('power', { state: 'display_off' })
      setTimeout(() => emit('power', { state: 'display_on' }), 200)
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
