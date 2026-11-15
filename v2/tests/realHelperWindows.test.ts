// The real Windows helper, started the way the app starts it. Windows CI publishes it first, so there a missing helper
// fails; a Windows run from source without it skips, and other platforms always skip.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { helperPath } from '../app/main/helperPath.ts'
import { parseLine } from '../capture/protocol.ts'
import { tempDir } from './support/tmp.ts'

const V2 = fileURLToPath(new URL('..', import.meta.url))
const HELPER = helperPath('win32', false, V2, '')!
const SERVICE = fileURLToPath(new URL('../capture/service.ts', import.meta.url))
const skip = process.platform !== 'win32' ? 'the Windows helper runs only on Windows' : !existsSync(HELPER) && !process.env.CI ? 'the Windows helper is not published (README)' : false
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function start(cmd: string, args: string[]) {
  const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let out = ''
  let err = ''
  let failed: Error | null = null
  proc.stdout.setEncoding('utf8').on('data', (c: string) => (out += c))
  proc.stderr.setEncoding('utf8').on('data', (c: string) => (err += c))
  proc.on('error', (e) => (failed = e))
  // 'close' comes after the exit and after both pipes have drained, and after a failed spawn.
  const closed = new Promise<{ code: number | null; signal: string | null }>((r) => proc.once('close', (code, signal) => r({ code, signal })))
  const within = <T>(p: Promise<T>, ms: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([p, new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)))]).finally(() => clearTimeout(timer))
  }
  /** Waits up to `ms` for it to close; past that, ends it and every process it started, and says it was forced. */
  const settle = async (ms: number) => {
    const done = await within(closed, ms)
    if (done) return { ...done, forced: false }
    // The service's helper is its child: taskkill /T ends both, where kill would leave the helper running.
    if (proc.pid !== undefined) spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
    const killed = await within(closed, 5000)
    if (!killed) throw new Error(`pid ${proc.pid} still running after taskkill`)
    return { ...killed, forced: true }
  }
  return { proc, out: () => out, err: () => err, failed: () => failed, settle }
}

async function until(cond: () => boolean, ms: number, what: () => string): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) assert.fail(what())
    await sleep(100)
  }
}

test('every line the real Windows helper writes passes the protocol validator, ending with a shutdown bye', { skip }, async () => {
  assert.ok(existsSync(HELPER), `no published helper at ${HELPER}`)
  const helper = start(HELPER, ['--heartbeat-s', '1'])
  try {
    await until(() => helper.failed() !== null || (helper.out().match(/"kind":"heartbeat"/g) ?? []).length >= 2, 10_000, () => `no heartbeats:\n${helper.out()}${helper.err()}`)
    assert.equal(helper.failed(), null)
    helper.proc.stdin.write('{"op":"shutdown"}\n')
    assert.deepEqual(await helper.settle(5000), { code: 0, signal: null, forced: false })
    const kinds = new Set<string>()
    let bye: string | null = null
    helper.out().split('\n').filter(Boolean).forEach((l, i) => {
      const r = parseLine(l)
      assert.ok(r.ok, `line ${i}: ${r.ok ? '' : r.reason + ' ' + r.detail}`)
      if (!r.ok) return
      assert.equal(r.line.platform, 'windows')
      kinds.add(r.line.kind)
      if (r.line.kind === 'bye') bye = r.line.obs.reason
    })
    for (const k of ['hello', 'heartbeat']) assert.ok(kinds.has(k), `missing ${k}`)
    assert.equal(bye, 'shutdown')
  } finally {
    await helper.settle(0)
  }
})

test('the capture service runs the real Windows helper with the arguments it passes, and stops it cleanly', { skip }, async () => {
  assert.ok(existsSync(HELPER), `no published helper at ${HELPER}`)
  const svc = start(process.execPath, [SERVICE, '--helper', HELPER, '--data-dir', tempDir('daylens-v2-win-'), '--deletion-stall-ms', 'Infinity', '--heartbeat-s', '1', '--tick-ms', '200'])
  try {
    await until(() => svc.failed() !== null || svc.err().includes('helper hello'), 20_000, () => `no helper hello:\n${svc.err()}`)
    assert.equal(svc.failed(), null)
    await sleep(2500)
    // On Windows the service stops when its stdin closes; it gives the helper 1.5 s to say bye before killing it.
    svc.proc.stdin.end()
    assert.deepEqual(await svc.settle(10_000), { code: 0, signal: null, forced: false })
    const log = svc.err()
    assert.match(log, /helper hello pid=\d+ accessibility=not_applicable/)
    // A helper killed after the grace never says bye, and the service still exits 0.
    assert.match(log, /helper bye reason=shutdown/)
    assert.doesNotMatch(log, /helper spawn failed|line rejected|helper exited/)
    assert.match(log, /stats lines=\d+ heartbeats=[1-9]\d* .* rejected=0/)
  } finally {
    await svc.settle(0)
  }
})
