// DAYLENS_TEST_NOW from source: Daylens launched on an invented world at a test time has every process on that time.
// Needs Electron's binary and the built interface: npm run app:build, then
//   node --test --test-concurrency=1 "tests/launch/*.launch.ts"
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { after, test } from 'node:test'
import Database from 'better-sqlite3'
import { DB_FILE } from '../../capture/store.ts'
import { makeWorld, source, type World } from '../../app/tools/world.ts'

// 8:30 PM on 4 March in the world's pinned zone (UTC−7), already 5 March in UTC, and years from the real date.
const TEST_NOW = '2031-03-05T03:30:00Z'
const T = Date.parse(TEST_NOW)
const TEST_DAY = '2031-03-04'
// Time passes from the test time; nothing here takes longer than this.
const within = (ms: number) => ms >= T && ms < T + 10 * 60_000

const apps: ChildProcess[] = []
const worlds: World[] = []
after(async () => {
  for (const app of apps) await stop(app)
  for (const w of worlds) rmSync(w.root, { recursive: true, force: true })
})

function launch(env: NodeJS.ProcessEnv, args: string[] = []): ChildProcess {
  const { command, args: entry } = source()
  const app = spawn(command, [...entry, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  apps.push(app)
  return app
}

async function stop(app: ChildProcess): Promise<void> {
  if (app.exitCode !== null || app.signalCode !== null) return
  const exited = new Promise((r) => app.once('exit', r))
  app.kill('SIGTERM')
  const timer = setTimeout(() => app.kill('SIGKILL'), 10_000)
  await exited
  clearTimeout(timer)
}

function line(stream: NodeJS.ReadableStream, match: RegExp, ms: number): Promise<RegExpExecArray> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no line matching ${match} within ${ms} ms`)), ms)
    createInterface({ input: stream }).on('line', (l) => {
      const m = match.exec(l)
      if (!m) return
      clearTimeout(timer)
      resolve(m)
    })
  })
}

async function until<T>(what: string, ms: number, read: () => Promise<T | null> | T | null): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await read()
    if (v !== null) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

// Evaluates an expression in the Daylens window over the DevTools protocol.
async function windowOf(port: string): Promise<(expression: string) => Promise<unknown>> {
  const page = await until('the Daylens window', 30_000, async () => {
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[]
    return targets.find((t) => t.type === 'page' && t.url.startsWith('file:')) ?? null
  })
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  after(() => ws.close())
  let id = 0
  const pending = new Map<number, (m: { result?: { result?: { value?: unknown } }; error?: unknown }) => void>()
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(String(e.data)) as { id?: number; result?: { result?: { value?: unknown } }; error?: unknown }
    if (msg.id !== undefined) pending.get(msg.id)?.(msg)
  })
  return (expression) =>
    new Promise((resolve, reject) => {
      const n = ++id
      pending.set(n, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result?.result?.value)))
      ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    })
}

test('the renderer, the reader, the capture service and the stand-in helper all run on the test time', async () => {
  const world = makeWorld({ now: TEST_NOW })
  worlds.push(world)
  const app = launch(world.env, ['--remote-debugging-port=0'])
  const [, port] = await line(app.stderr!, /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//, 30_000)
  const evaluate = await windowOf(port!)

  // Today's first paint shows the test day's hours, the last one live: the renderer and the reader agree on now.
  const seen = await until('Today with its live hour', 30_000, async () =>
    (await evaluate(`(async () => {
      if (!document.querySelector('[data-current="true"]')) return null
      const d = new Date()
      const renderer = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
      const day = await window.daylens.query({ q: 'day', date: renderer })
      return { renderer, reader: day.today, now: Date.now() }
    })()`)) as { renderer: string; reader: string; now: number } | null,
  )
  assert.equal(seen.renderer, TEST_DAY)
  assert.equal(seen.reader, TEST_DAY)
  assert.ok(within(seen.now), `the renderer's now ${new Date(seen.now).toISOString()}`)

  // The stand-in helper's first window, as the capture service stored it: the helper's time and the service's own.
  const db = new Database(path.join(world.data, DB_FILE), { readonly: true, fileMustExist: true })
  after(() => db.close())
  const focus = await until('the stand-in helper’s focus line', 30_000, () => (db.prepare(`SELECT event_wall_ms, recorded_wall_ms FROM observations WHERE source = 'demo' AND kind = 'focus' ORDER BY id DESC LIMIT 1`).get() as { event_wall_ms: number; recorded_wall_ms: number } | undefined) ?? null)
  assert.ok(within(focus.event_wall_ms), `the helper's time ${new Date(focus.event_wall_ms).toISOString()}`)
  assert.ok(within(focus.recorded_wall_ms), `the service's time ${new Date(focus.recorded_wall_ms).toISOString()}`)
})

test('the main process runs on the test time and the world’s data folder', async () => {
  const world = makeWorld({ now: TEST_NOW })
  worlds.push(world)
  const app = launch({ ...world.env, DAYLENS_BENCH: '1' })
  app.stderr!.resume()
  const [, json] = await line(app.stdout!, /^DAYLENS_BENCH_RUN (.*)$/, 60_000)
  const run = JSON.parse(json!) as { now_ms: number; data_dir: string }
  assert.ok(within(run.now_ms), `main's now ${new Date(run.now_ms).toISOString()}`)
  assert.equal(run.data_dir, world.data)
})

test('a test time without a throwaway data and shell folder is refused, so it never reaches a real record', async () => {
  const world = makeWorld({ world: 'empty', now: TEST_NOW })
  worlds.push(world)
  for (const missing of ['DAYLENS_V2_DATA_DIR', 'DAYLENS_SHELL_DIR']) {
    const { [missing]: _gone, ...env } = world.env
    const app = launch(env)
    app.stdout!.resume()
    const refused = line(app.stderr!, /^DAYLENS_TEST_NOW needs DAYLENS_V2_DATA_DIR and DAYLENS_SHELL_DIR$/, 30_000)
    const code = await new Promise((r) => app.once('exit', r))
    await refused
    assert.equal(code, 64, `without ${missing}`)
  }
})
