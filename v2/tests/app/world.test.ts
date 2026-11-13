// The invented world's starting states: an empty record, and capture paused as the pause action would leave it.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
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

test('importing the world leaves Electron unloaded, so checking a packaged app never fetches it', () => {
  const script = `
    import { createRequire } from 'node:module'
    await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, '..', '..', 'app', 'tools', 'world.ts')).href)})
    process.stdout.write(String(Object.keys(createRequire(import.meta.url).cache).some((f) => f.includes(\`node_modules\${path.sep}electron\${path.sep}\`))))`
  const loaded = execFileSync(process.execPath, ['--input-type=module', '-e', `import path from 'node:path'\n${script}`], { encoding: 'utf8' })
  assert.equal(loaded, 'false')
})
