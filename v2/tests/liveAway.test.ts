import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AWAY_IDLE_S, NOT_AWAY_EXIT, endAll, gate, mayTakeScreen, stopReason, watch, type Signals } from '../browser/tools/away.ts'
import { runQueue, splitArgs } from '../browser/tools/queue.ts'

const live = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'browser', 'tools', 'live.ts'), 'utf8')

function fake(over: Partial<{ marker: boolean; locked: boolean; asleep: boolean; idle: number }> = {}): Signals {
  const v = { marker: true, locked: false, asleep: false, idle: 0, ...over }
  return { marker: () => v.marker, locked: () => v.locked, displayAsleep: () => v.asleep, idleSeconds: () => v.idle }
}

test('no live run starts without the away marker, however long the Mac has been idle or asleep', () => {
  for (const s of [fake({ marker: false, idle: 10_000 }), fake({ marker: false, asleep: true }), fake({ marker: false, locked: true })])
    assert.equal(gate(s), 'no_marker')
})

test('two minutes without input is not away: reading at the Mac looks the same', () => {
  assert.equal(gate(fake({ idle: 120 })), 'present')
  assert.equal(gate(fake({ idle: AWAY_IDLE_S - 1 })), 'present')
  assert.equal(AWAY_IDLE_S, 600)
})

test('with the marker, ten idle minutes or a sleeping display mean away; a locked screen waits', () => {
  assert.equal(gate(fake({ idle: AWAY_IDLE_S })), 'away')
  assert.equal(gate(fake({ asleep: true, idle: 5 })), 'away')
  assert.equal(gate(fake({ locked: true, idle: 10_000 })), 'locked')
})

test('the runner gates on the marker and exits before launching anything when it is missing', () => {
  assert.doesNotMatch(live, /'idle-s'/, 'the old two-minute setting is gone')
  const announce = live.slice(live.indexOf('async function announce'), live.indexOf('\n}\n', live.indexOf('async function announce')))
  assert.match(announce, /gate\(signals/)
  assert.match(announce, /'no_marker'[\s\S]*process\.exit\(NOT_AWAY_EXIT\)/)
  assert.equal(NOT_AWAY_EXIT, 75)
})

function clock() {
  let t = 0
  let tick: (() => void) | null = null
  return {
    now: () => t,
    every: (fn: () => void) => {
      tick = fn
      return () => {
        tick = null
      }
    },
    advance(ms: number) {
      t += ms
      tick?.()
    },
    get running() {
      return tick !== null
    },
  }
}

test('the first input after the run takes the screen stops it, even in the first second; idle time growing does not', () => {
  const v = { idle: 600 }
  const s: Signals = { marker: () => true, locked: () => false, displayAsleep: () => false, idleSeconds: () => v.idle }
  const c = clock()
  const stops: string[] = []
  watch(s, c, (r) => stops.push(r))
  for (let i = 0; i < 40; i++) {
    v.idle += 0.25
    c.advance(250)
  }
  assert.deepEqual(stops, [], 'ten seconds of growing idle time is no input')
  v.idle = 0.2
  c.advance(250)
  assert.deepEqual(stops, ['someone is using the Mac'])
  assert.equal(c.running, false, 'it stops watching after the first stop')

  const early = clock()
  const v2 = { idle: 700 }
  const got: string[] = []
  watch({ ...s, idleSeconds: () => v2.idle }, early, (r) => got.push(r))
  v2.idle = 0.1
  early.advance(250)
  assert.deepEqual(got, ['someone is using the Mac'], 'input a quarter second in counts')
})

test('removing the marker or locking the screen during a run stops it too', () => {
  const v = { marker: true, locked: false, idle: 900 }
  const s: Signals = { marker: () => v.marker, locked: () => v.locked, displayAsleep: () => false, idleSeconds: () => v.idle }
  assert.equal(stopReason(s, 900, 0), null)
  v.marker = false
  assert.equal(stopReason(s, 900, 0), 'the away marker was removed')
  v.marker = true
  v.locked = true
  assert.equal(stopReason(s, 900, 0), 'the screen locked')
})

test('a stop quits every launched process within the grace period, killing the ones that ignore TERM', async () => {
  const alive = new Set([11, 22, 33])
  const sent: string[] = []
  let slept = 0
  await endAll([11, 22, 33], {
    kill: (pid, sig) => {
      sent.push(`${sig} ${pid}`)
      if (sig === 'SIGKILL' || pid !== 33) alive.delete(pid)
    },
    alive: (pid) => alive.has(pid),
    sleep: async (ms) => {
      slept += ms
    },
  }, 1500)
  assert.deepEqual(sent, ['SIGTERM 11', 'SIGTERM 22', 'SIGTERM 33', 'SIGKILL 33'])
  assert.equal(alive.size, 0)
  assert.ok(slept <= 1500)
})

test('a queue stops at the first run that ended because someone may be at the Mac', () => {
  const ran: string[] = []
  const codes = runQueue([['cft'], ['firefox', '--local'], ['firefox']], (args) => {
    ran.push(args.join(' '))
    return args[0] === 'firefox' && args.length === 2 ? NOT_AWAY_EXIT : 1
  })
  assert.deepEqual(ran, ['cft', 'firefox --local'])
  assert.deepEqual(codes, [1, NOT_AWAY_EXIT])
  assert.deepEqual(splitArgs('canary --app "/Apps/Daylens Test Browsers/Firefox.app" --local'), ['canary', '--app', '/Apps/Daylens Test Browsers/Firefox.app', '--local'])
})

test('the runner watches from the countdown on, ends the run on a stop, and no longer waits to take the screen again', () => {
  const announce = live.slice(live.indexOf('async function announce'), live.indexOf('\n}\n', live.indexOf('async function announce')))
  assert.ok(announce.indexOf('watch(signals') < announce.indexOf('display notification'), 'watching starts before the countdown')
  assert.doesNotMatch(announce, /waiting again/)
  assert.doesNotMatch(live, /The canary test, continuing/)
  const stop = live.slice(live.indexOf('async function stopRun'), live.indexOf('\n}\n', live.indexOf('async function stopRun')))
  assert.match(stop, /stopped: \$\{reason\}/)
  assert.match(stop, /endAll\(launched/)
  assert.match(stop, /process\.exit\(NOT_AWAY_EXIT\)/)
  assert.doesNotMatch(stop, /activate/)
  for (const spawned of ['this.proc = spawn(this.binary, [...this.args()', "this.proc = spawn(this.binary, ['-profile'", 'this.proc = spawn(process.execPath, [SERVICE']) {
    const at = live.indexOf(spawned)
    assert.ok(at >= 0 && live.slice(at, at + 700).includes('launched.add(this.proc.pid)'), spawned)
  }
})

test('nothing launches or comes to the front before the gate passes, or once the marker is gone', () => {
  assert.equal(mayTakeScreen(false, fake()), false, 'before the gate')
  assert.equal(mayTakeScreen(true, fake({ marker: false })), false, 'marker removed')
  assert.equal(mayTakeScreen(true, fake()), true)
  const launches = [...live.matchAll(/  async launch\(url: string\): Promise<void> \{\n([^\n]*)/g)].map((m) => m[1]!.trim())
  assert.equal(launches.length, 2, 'Chromium and Firefox drivers')
  for (const first of launches) assert.match(first, /^takeScreen\(/, 'the first thing a launch does is check the gate')
  const activate = live.slice(live.indexOf('function activateApp'), live.indexOf('\n}\n', live.indexOf('function activateApp')))
  assert.ok(activate.indexOf('takeScreen(') >= 0 && activate.indexOf('takeScreen(') < activate.indexOf('execFileSync('), 'checked before activating')
  const open = live.slice(live.indexOf('function openApp'), live.indexOf('\n}\n', live.indexOf('function openApp')))
  assert.ok(open.indexOf('takeScreen(') < open.indexOf("'/usr/bin/open'"))
  assert.doesNotMatch(live.replace(open, ''), /'\/usr\/bin\/open', \['-a'/, 'every app opening goes through openApp')
  const take = live.slice(live.indexOf('function takeScreen'), live.indexOf('\n}\n', live.indexOf('function takeScreen')))
  assert.match(take, /mayTakeScreen\(screenHeld, signals\)/)
  const announce = live.slice(live.indexOf('async function announce'), live.indexOf('\n}\n', live.indexOf('async function announce')))
  assert.ok(announce.indexOf('screenHeld = true') > announce.indexOf("if (g === 'away') break"), 'the screen is held only after the gate passed')
})
