import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { symlinkSync } from 'node:fs'
import { once } from 'node:events'
import path from 'node:path'
import { createInterface } from 'node:readline'
import Database from 'better-sqlite3'
import { DB_FILE } from '../../capture/store.ts'
import { rig, T0, tmpDir } from '../storage/support.ts'
import { day } from '../retrieval/support.ts'

process.env.TZ = 'Etc/GMT+5'
const MAIN = path.resolve(import.meta.dirname, '../../mcp/main.ts')
// A failed assertion must not leave a server holding the test process open.
const started: ChildProcess[] = []
after(() => started.forEach((c) => c.kill('SIGKILL')))

function seeded() {
  const r = rig()
  day(r)
  r.storage.writeHour({ start_wall_ms: T0, tz: 'Example/Town', status: 'written', title: 'Budget review', summary: 'Went through Q4 numbers.', sources: [{ app_id: 'com.example.editor' }] }, r.storage.hourBasis(T0))
  r.store.flush()
  return r
}

/** The server as a client starts it, with a way to send a request and wait for its reply. */
function start(dataDir: string, child: ChildProcess = spawn(process.execPath, [MAIN, '--data-dir', dataDir], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TZ: 'Etc/GMT+5' } })) {
  started.push(child)
  const waiting = new Map<number, (m: Record<string, unknown>) => void>()
  const stdout: string[] = []
  let stderr = ''
  child.stderr?.on('data', (d) => (stderr += d))
  createInterface({ input: child.stdout! }).on('line', (line) => {
    stdout.push(line)
    const m = JSON.parse(line) as { id: number }
    waiting.get(m.id)?.(m)
  })
  let next = 1
  const request = (method: string, params: object = {}) =>
    new Promise<Record<string, any>>((resolve) => {
      const id = next++
      waiting.set(id, resolve)
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  const initialize = () => request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.0.0' } })
  return { child, request, initialize, stdout, stderr: () => stderr }
}

const exited = (child: ChildProcess, ms: number) =>
  Promise.race([once(child, 'exit').then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))])

test('a client lists the tools, reads a day, and the read is logged under its name', async () => {
  const r = seeded()
  const s = start(r.dir)
  const init = await s.initialize()
  assert.equal(init.result.protocolVersion, '2025-06-18')
  assert.deepEqual(init.result.capabilities, { tools: {} })
  s.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  const tools = await s.request('tools/list')
  assert.deepEqual(
    tools.result.tools.map((t: { name: string }) => t.name),
    ['list_days', 'get_day', 'get_hour', 'search', 'get_agent_work', 'get_apps', 'get_status'],
  )
  assert.ok(tools.result.tools.every((t: { annotations: { readOnlyHint: boolean } }) => t.annotations.readOnlyHint))
  const got = await s.request('tools/call', { name: 'get_day', arguments: { date: '2026-10-16' } })
  assert.equal(got.result.isError, undefined, got.result.content[0].text)
  assert.deepEqual(JSON.parse(got.result.content[0].text).hours.map((h: { title: string }) => h.title), ['Budget review'])
  const bad = await s.request('tools/call', { name: 'get_day', arguments: { date: 'yesterday' } })
  assert.deepEqual([bad.result.isError, bad.result.content[0].text], [true, 'date must be a date written YYYY-MM-DD'])
  assert.equal((await s.request('resources/list')).error.code, -32601)
  assert.deepEqual(r.q<{ assistant: string; tool: string }>('SELECT assistant, tool FROM assistant_reads ORDER BY id'), [
    { assistant: 'Claude Code', tool: 'get_day' },
    { assistant: 'Claude Code', tool: 'get_day' },
  ])
  assert.ok(s.stdout.every((l) => JSON.parse(l).jsonrpc === '2.0'), 'nothing but replies on stdout')
  s.child.stdin!.end()
  assert.ok(await exited(s.child, 5000))
  r.close()
})

test('the server exits the moment its client closes stdin', async () => {
  const r = seeded()
  const s = start(r.dir)
  await s.initialize()
  await s.request('tools/call', { name: 'list_days', arguments: { from: '2026-10-16', to: '2026-10-16' } })
  const t = performance.now()
  s.child.stdin!.end()
  assert.ok(await exited(s.child, 1000), 'still running a second after stdin closed')
  assert.equal(s.child.exitCode, 0)
  assert.ok(performance.now() - t < 1000)
  r.close()
})

test('the server exits when the process that started it dies, even while its stdin stays open', { skip: process.platform === 'win32' && 'needs a named pipe' }, async () => {
  const r = seeded()
  const fifo = path.join(tmpDir(), 'stdin')
  execFileSync('mkfifo', [fifo])
  // A parent that starts the server on a stdin that never ends (a pipe it holds open for writing too), then is killed.
  const parent = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { spawn } from 'node:child_process'
       import { openSync } from 'node:fs'
       const c = spawn(process.execPath, [${JSON.stringify(MAIN)}, '--data-dir', ${JSON.stringify(r.dir)}], { stdio: [openSync(${JSON.stringify(fifo)}, 'r+'), 'ignore', 'ignore'] })
       process.stderr.write('server ' + c.pid + '\\n')
       setInterval(() => {}, 1e6)`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  const [line] = (await once(createInterface({ input: parent.stderr! }), 'line')) as [string]
  const pid = Number(/server (\d+)/.exec(line)![1])
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.doesNotThrow(() => process.kill(pid, 0), 'the server is running')
  parent.kill('SIGKILL')
  const gone = async () => {
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(pid, 0)
      } catch {
        return true
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return false
  }
  try {
    assert.ok(await gone(), 'the server outlived its parent by 5 seconds')
  } finally {
    if (!(await gone())) process.kill(pid, 'SIGKILL')
    r.close()
  }
})

test('with no record yet, or one from a newer Daylens, a call says so and the server keeps running', async () => {
  const dir = tmpDir()
  const s = start(dir)
  await s.initialize()
  const none = await s.request('tools/call', { name: 'get_day', arguments: { date: '2026-10-16' } })
  assert.equal(none.result.isError, true)
  assert.match(none.result.content[0].text, /hasn't recorded anything on this computer yet/)

  // Daylens starts recording while the assistant is connected.
  const r = rig(dir)
  day(r)
  r.store.flush()
  const now = await s.request('tools/call', { name: 'get_day', arguments: { date: '2026-10-16' } })
  assert.equal(now.result.isError, undefined, now.result.content[0].text)

  // An update moves the record on while the server runs.
  const db = new Database(path.join(dir, DB_FILE))
  db.prepare(`UPDATE meta SET value = '99' WHERE key = 'schema_version'`).run()
  db.close()
  const newer = await s.request('tools/call', { name: 'get_day', arguments: { date: '2026-10-16' } })
  assert.equal(newer.result.isError, true)
  assert.match(newer.result.content[0].text, /newer version of Daylens/)
  assert.equal((await s.request('ping')).result !== undefined, true, 'still answering')
  assert.equal(s.child.exitCode, null)
  s.child.stdin!.end()
  await once(s.child, 'exit')
  r.close()
})

test('a line that is not JSON gets a parse error, and the server carries on', async () => {
  const r = seeded()
  const s = start(r.dir)
  const reply = new Promise<string>((resolve) => createInterface({ input: s.child.stdout! }).once('line', resolve))
  s.child.stdin!.write('not json\n')
  assert.equal(JSON.parse(await reply).error.code, -32700)
  assert.equal((await s.initialize()).result.serverInfo.name, 'daylens')
  s.child.stdin!.end()
  await once(s.child, 'exit')
  assert.equal(r.q<{ n: number }>('SELECT count(*) AS n FROM assistant_reads')[0]!.n, 0)
  r.close()
})

test('a server whose parent died while it started exits too', { skip: process.platform === 'win32' && 'needs a named pipe' }, async () => {
  const r = seeded()
  const fifo = path.join(tmpDir(), 'stdin')
  execFileSync('mkfifo', [fifo])
  const parent = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { spawn } from 'node:child_process'
       import { openSync } from 'node:fs'
       const c = spawn(process.execPath, [${JSON.stringify(MAIN)}, '--data-dir', ${JSON.stringify(r.dir)}], { stdio: [openSync(${JSON.stringify(fifo)}, 'r+'), 'ignore', 'ignore'] })
       process.stderr.write('server ' + c.pid + '\\n', () => process.exit(0))`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  const [line] = (await once(createInterface({ input: parent.stderr! }), 'line')) as [string]
  const pid = Number(/server (\d+)/.exec(line)![1])
  let gone = false
  for (let i = 0; i < 30 && !gone; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    try {
      process.kill(pid, 0)
    } catch {
      gone = true
    }
  }
  if (!gone) process.kill(pid, 'SIGKILL')
  assert.ok(gone, 'the server outlived a parent that died before it started')
  r.close()
})

test('a batch gets one reply per request in it', async () => {
  const r = seeded()
  const s = start(r.dir)
  const reply = new Promise<string>((resolve) => createInterface({ input: s.child.stdout! }).once('line', resolve))
  s.child.stdin!.write(
    `${JSON.stringify([
      { jsonrpc: '2.0', id: 'a', method: 'initialize', params: { protocolVersion: '2025-03-26', clientInfo: { name: 'codex-mcp-client' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 'b', method: 'ping' },
    ])}\n`,
  )
  const replies = JSON.parse(await reply) as { id: string; result: Record<string, unknown> }[]
  assert.deepEqual(replies.map((x) => x.id), ['a', 'b'])
  assert.equal(replies[0]!.result.protocolVersion, '2025-03-26')
  s.child.stdin!.end()
  await once(s.child, 'exit')
  r.close()
})

test('the packaged build compiles the server, and the compiled entry answers', async () => {
  const v2 = path.resolve(import.meta.dirname, '../..')
  const out = tmpDir()
  execFileSync(process.execPath, [path.join(v2, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(v2, 'app', 'package', 'tsconfig.json'), '--outDir', out])
  symlinkSync(path.join(v2, 'node_modules'), path.join(out, 'node_modules'), 'junction')
  const r = seeded()
  const s = start(r.dir, spawn(process.execPath, [path.join(out, 'mcp', 'main.js'), '--data-dir', r.dir], { stdio: ['pipe', 'pipe', 'pipe'] }))
  assert.equal((await s.initialize()).result.serverInfo.name, 'daylens')
  const day = await s.request('tools/call', { name: 'get_day', arguments: { date: '2026-10-16' } })
  assert.equal(day.result.isError, undefined, day.result.content[0].text)
  s.child.stdin!.end()
  await once(s.child, 'exit')
  r.close()
})
