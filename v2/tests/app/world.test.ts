// The invented world's starting states: an empty record, and capture paused as the pause action would leave it.
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import Database from 'better-sqlite3'
import { DB_FILE, Store } from '../../capture/store.ts'
import { Storage } from '../../storage/index.ts'
import { makeWorld, type World } from '../../app/tools/world.ts'

const TEST_NOW = '2031-03-05T03:30:00Z'
const worlds: World[] = []
after(() => {
  for (const w of worlds) rmSync(w.root, { recursive: true, force: true })
})

function pauseOf(data: string) {
  const store = new Store(data)
  const storage = new Storage(store, data, { deletionStallMs: Infinity })
  try {
    return storage.paused()
  } finally {
    storage.stop()
    store.close()
  }
}

test('an empty world has no record until the app makes one', () => {
  const w = makeWorld({ world: 'empty' })
  worlds.push(w)
  assert.equal(existsSync(path.join(w.data, DB_FILE)), false)
})

test('a paused world starts paused from its now, until resumed or until a time', () => {
  const resumed = makeWorld({ world: 'empty', now: TEST_NOW, paused: true })
  worlds.push(resumed)
  const p = pauseOf(resumed.data)
  assert.equal(p?.since_wall_ms, Date.parse(TEST_NOW))
  assert.equal(p?.until_wall_ms, null)

  const until = Date.parse(TEST_NOW) + 3_600_000
  const timed = makeWorld({ world: 'empty', now: TEST_NOW, paused: { until_ms: until } })
  worlds.push(timed)
  assert.equal(pauseOf(timed.data)?.until_wall_ms, until)
})

test('a seeded world is not paused', () => {
  const plain = makeWorld({ world: 'bakery', now: TEST_NOW })
  worlds.push(plain)
  assert.equal(pauseOf(plain.data), null)
})

test('a failed seed removes its temporary world before throwing', () => {
  const w = makeWorld({ world: 'empty' })
  worlds.push(w)
  assert.throws(() => makeWorld({ root: w.root, world: 'missing' }))
  assert.equal(existsSync(w.root), false)
})

test('importing the world leaves Electron unloaded, so checking a packaged app never fetches it', () => {
  const script = `
    import { createRequire } from 'node:module'
    await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, '..', '..', 'app', 'tools', 'world.ts')).href)})
    process.stdout.write(String(Object.keys(createRequire(import.meta.url).cache).some((f) => f.includes(\`node_modules\${path.sep}electron\${path.sep}\`))))`
  const loaded = execFileSync(process.execPath, ['--input-type=module', '-e', `import path from 'node:path'\n${script}`], { encoding: 'utf8' })
  assert.equal(loaded, 'false')
})

test('the invented world starts its helper with Node and a script argument, without a shell', () => {
  const w = makeWorld({ world: 'empty' })
  worlds.push(w)
  assert.equal(w.env.DAYLENS_HELPER, process.execPath)
  assert.deepEqual(JSON.parse(w.env.DAYLENS_HELPER_ARGS!), [path.join(import.meta.dirname, '..', '..', 'app', 'tools', 'demoHelper.ts')])
})

test('the service runs the Node stand-in in its isolated world and shuts it down cleanly', async () => {
  const w = makeWorld({ world: 'empty', now: TEST_NOW })
  worlds.push(w)
  const args = JSON.parse(w.env.DAYLENS_HELPER_ARGS!) as string[]
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '../../capture/service.ts'), '--helper', w.env.DAYLENS_HELPER!, ...args.flatMap(a => ['--helper-arg', a]), '--data-dir', w.data], {
    env: w.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  })
  let log = ''
  child.stdout.resume()
  child.stderr.setEncoding('utf8').on('data', (s: string) => { log += s })
  const closed = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
  const within = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out: ${log}`)), ms) })]) }
    finally { clearTimeout(timer) }
  }
  try {
    await within(new Promise<void>((resolve, reject) => {
      child.stderr.on('data', () => { if (log.includes('helper hello')) resolve() })
      child.once('close', () => reject(new Error(`service stopped: ${log}`)))
      child.once('error', reject)
    }), 10_000)
    child.stdin.end('{"op":"stop"}\n')
    assert.equal(await within(closed, 10_000), 0)
    assert.match(log, /helper bye reason=shutdown/)
    assert.doesNotMatch(log, /helper spawn failed|line rejected/)
    const db = new Database(path.join(w.data, DB_FILE), { readonly: true, fileMustExist: true })
    try {
      assert.equal((db.prepare("SELECT helper FROM capture_runs").get() as { helper: string }).helper, 'demo')
      assert.ok((db.prepare("SELECT count(*) AS n FROM observations WHERE source = 'demo' AND kind = 'focus'").get() as { n: number }).n > 0)
    } finally { db.close() }
  } finally {
    child.stdin.end('{"op":"stop"}\n')
    if (child.exitCode === null && child.signalCode === null) {
      try { await within(closed, 3000) }
      catch {
        if (child.pid !== undefined) {
          if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
          else { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
        }
        await within(closed, 5000).catch(() => {})
      }
    }
  }
})

test('release startup strips every world override, including helper arguments; test packages keep them', () => {
  const w = makeWorld({ world: 'empty', now: TEST_NOW })
  worlds.push(w)
  const overrides = ['DAYLENS_TEST_NOW', 'DAYLENS_V2_DATA_DIR', 'DAYLENS_SHELL_DIR', 'DAYLENS_HELPER', 'DAYLENS_HELPER_ARGS']
  for (const testBuild of [false, true]) {
    const script = `
      import { registerHooks } from 'node:module'
      registerHooks({
        resolve(specifier, context, next) {
          return specifier === 'electron' ? { url: 'test:electron', shortCircuit: true } : next(specifier, context)
        },
        load(url, context, next) {
          return url === 'test:electron' ? { format: 'module', source: ${JSON.stringify(`export const app = { isPackaged: true, getAppPath: () => ${JSON.stringify(w.root)} }`)}, shortCircuit: true } : next(url, context)
        }
      })
      await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, '../../app/main/testEnv.ts')).href)})
      console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(overrides)}.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]))))`
    writeFileSync(path.join(w.root, 'package.json'), JSON.stringify({ daylensTestBuild: testBuild }))
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: w.env, encoding: 'utf8' })
    assert.deepEqual(JSON.parse(result), testBuild ? Object.fromEntries(overrides.map(k => [k, w.env[k]])) : {})
  }
})

test('Windows shell data honours APPDATA so an isolated world never writes to the real profile', () => {
  const w = makeWorld({ world: 'empty' })
  worlds.push(w)
  const roaming = path.join(w.home, 'AppData', 'Roaming')
  for (const isPackaged of [false, true]) for (const appdata of [roaming, undefined]) {
    const script = `
    import { registerHooks } from 'node:module'
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.resourcesPath = ${JSON.stringify(w.root)}
    registerHooks({
      resolve(s, c, next) { return s === 'electron' ? { url: 'test:electron', shortCircuit: true } : next(s, c) },
      load(u, c, next) { return u === 'test:electron' ? { format: 'module', source: 'export const app = { isPackaged: ${isPackaged}, getPath: () => "outside-the-world" }', shortCircuit: true } : next(u, c) }
    })
    const { appData } = await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, '../../app/main/paths.ts')).href)})
    console.log(appData())`
    const env = { ...w.env, APPDATA: appdata }
    if (appdata === undefined) delete env.APPDATA
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' }).trim()
    assert.equal(result, appdata ?? 'outside-the-world')
  }
})
