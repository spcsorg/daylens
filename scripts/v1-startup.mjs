// Launch and navigation baselines for the V1 launch plan. Runs the packaged app
// in the fail-closed real-day harness mode (no capture, sync, network or
// background services) against an APFS clone of the CLI harness work copy.
//
//   node scripts/v1-startup.mjs --app <Electron executable> [--app-path .] \
//     --source <work dir> --root <scratch dir> --runs 5 --output <file.json>
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import WebSocket from 'ws'

const argument = (name, fallback = null) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback
}
const executable = argument('app')
const appPath = argument('app-path')
const sourceDir = argument('source')
const root = argument('root')
const runs = Number(argument('runs', '5'))
const output = argument('output')
const pastDate = argument('date', '2026-10-05')
const idleSeconds = Number(argument('idle', '30'))
const pastDayMarker = argument('past-day-marker', 'Morning')
const weekMinBlocks = Number(argument('week-min-blocks', '12'))
if (!executable || !sourceDir || !root || !output) throw new Error('missing --app/--source/--root/--output')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function availablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => { try { resolve(JSON.parse(body)) } catch (error) { reject(error) } })
    })
    request.once('error', reject)
    request.setTimeout(1_000, () => request.destroy(new Error('timeout')))
  })
}

async function connect(port, deadlineMs) {
  while (Date.now() < deadlineMs) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`)
      const page = targets.find((target) => target.type === 'page')
      if (page?.webSocketDebuggerUrl) {
        const socket = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
        let nextId = 1
        const pending = new Map()
        socket.on('message', (raw) => {
          const message = JSON.parse(raw.toString())
          const entry = message.id ? pending.get(message.id) : null
          if (!entry) return
          pending.delete(message.id)
          if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
          else entry.resolve(message.result)
        })
        const call = (method, params = {}) => new Promise((resolve, reject) => {
          const id = nextId++
          pending.set(id, { resolve, reject })
          socket.send(JSON.stringify({ id, method, params }))
        })
        const evaluate = async (expression) => {
          const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
          if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? 'evaluate failed')
          return response.result?.value
        }
        return { call, evaluate, close: () => socket.close() }
      }
    } catch { /* target not up yet */ }
    await wait(25)
  }
  throw new Error('no renderer target')
}

// Sets the route and polls on animation frames until the selector (or text)
// appears, measured inside the renderer so CDP round-trips are excluded.
const navExpression = (hash, readyJs, timeoutMs = 120_000) => `(async () => {
  const ready = () => { try { return Boolean(${readyJs}) } catch { return false } }
  const t0 = performance.now()
  location.hash = ${JSON.stringify(hash)}
  await new Promise((r) => requestAnimationFrame(r))
  while (!ready()) {
    if (performance.now() - t0 > ${timeoutMs}) return -1
    await new Promise((r) => requestAnimationFrame(r))
  }
  return performance.now() - t0
})()`

const ipcExpression = (call) => `(async () => {
  const t0 = performance.now()
  const result = await ${call}
  return { ms: performance.now() - t0, size: Array.isArray(result) ? result.length : (result?.blocks?.length ?? null) }
})()`

function descendants(rootPid) {
  const table = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,pcpu=,comm=']).toString().trim().split('\n')
    .map((line) => line.trim().split(/\s+/))
    .map(([pid, ppid, rss, pcpu, ...comm]) => ({ pid: Number(pid), ppid: Number(ppid), rssKb: Number(rss), pcpu: Number(pcpu), comm: comm.join(' ') }))
  const keep = new Set([rootPid])
  let grew = true
  while (grew) {
    grew = false
    for (const row of table) if (keep.has(row.ppid) && !keep.has(row.pid)) { keep.add(row.pid); grew = true }
  }
  return table.filter((row) => keep.has(row.pid))
}

async function oneRun(index, sampleIdle) {
  const runDir = path.join(root, `run-${Date.now()}-${index}`)
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 })
  execFileSync('cp', ['-c', path.join(sourceDir, 'daylens.sqlite'), path.join(runDir, 'daylens.sqlite')])
  if (fs.existsSync(path.join(sourceDir, 'config.json'))) fs.copyFileSync(path.join(sourceDir, 'config.json'), path.join(runDir, 'config.json'))

  const port = await availablePort()
  const spawnedAt = Date.now()
  const child = spawn(executable, [`--remote-debugging-port=${port}`, ...(appPath ? [appPath] : [])], {
    env: { ...process.env, DAYLENS_DEV_USERDATA: runDir, DAYLENS_REAL_DAY_HARNESS: '1', DAYLENS_REAL_DAY_DATE: pastDate, DAYLENS_REAL_DAY_ALLOW_MODEL_NETWORK: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stages = []
  let log = ''
  const onData = (chunk) => {
    const text = chunk.toString()
    log += text
    for (const match of text.matchAll(/\[startup\] (.+?) \+(\d+)ms/g)) stages.push({ stage: match[1], processMs: Number(match[2]), wallMs: Date.now() - spawnedAt })
    for (const match of text.matchAll(/\[db\] quick integrity check completed in (\d+)ms/g)) stages.push({ stage: 'integrity quick_check', durationMs: Number(match[1]), wallMs: Date.now() - spawnedAt })
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)

  const result = { run: index, stages }
  try {
    const cdp = await connect(port, Date.now() + 60_000)
    result.rendererTargetMs = Date.now() - spawnedAt
    const firstBlock = await cdp.evaluate(`(async () => {
      const t0 = performance.now()
      while (!document.querySelector('[data-timeline-block-id]')) {
        if (performance.now() - t0 > 120000) return -1
        await new Promise((r) => requestAnimationFrame(r))
      }
      return { navStartToBlocksMs: performance.now(), route: location.hash }
    })()`)
    result.launchToTimelineBlocksMs = Date.now() - spawnedAt
    result.rendererNavStartToBlocksMs = firstBlock?.navStartToBlocksMs ?? null
    result.initialRoute = firstBlock?.route ?? null
    result.paint = await cdp.evaluate(`Object.fromEntries(performance.getEntriesByType('paint').map((e) => [e.name, e.startTime]))`)

    const appsReady = `document.body.innerText.includes('Select an app') || document.querySelector('[aria-label="Previous period"]')`
    const nav = {}
    nav.timelineToApps = await cdp.evaluate(navExpression('#/apps', appsReady))
    // Timeline stays mounted behind other routes, so readiness must match
    // content that only the target day or week renders.
    nav.appsToPastDay = await cdp.evaluate(navExpression(`#/timeline?view=day&date=${pastDate}`, `[...document.querySelectorAll('[data-timeline-block-id]')].some((n) => n.innerText.includes(${JSON.stringify(pastDayMarker)}))`))
    nav.pastDayToAI = await cdp.evaluate(navExpression('#/ai', `document.querySelector('[aria-label="Ask Daylens about your work history"]')`))
    nav.aiToWeek = await cdp.evaluate(navExpression(`#/timeline?view=week&date=${pastDate}`, `document.querySelectorAll('[data-timeline-block-id]').length > ${weekMinBlocks}`))
    nav.weekToApps = await cdp.evaluate(navExpression('#/apps', appsReady))
    result.navigationMs = nav

    const ipc = {}
    ipc.timelineDayPast = await cdp.evaluate(ipcExpression(`window.daylens.db.getTimelineDay(${JSON.stringify(pastDate)})`))
    ipc.appSummaries7d = await cdp.evaluate(ipcExpression('window.daylens.db.getAppSummaries(7)'))
    ipc.appSummaries30d = await cdp.evaluate(ipcExpression('window.daylens.db.getAppSummaries(30)'))
    if (sampleIdle) ipc.appSummariesAll = await cdp.evaluate(ipcExpression('window.daylens.db.getAppSummaries(36500)'))
    result.ipcMs = ipc

    if (sampleIdle) {
      await wait(idleSeconds * 1000)
      const procs = descendants(child.pid)
      result.idle = {
        afterSeconds: idleSeconds,
        totalRssMb: Math.round(procs.reduce((s, p) => s + p.rssKb, 0) / 1024),
        totalCpuPct: Math.round(procs.reduce((s, p) => s + p.pcpu, 0) * 10) / 10,
        processes: procs.map((p) => ({ comm: path.basename(p.comm), rssMb: Math.round(p.rssKb / 1024), cpuPct: p.pcpu })),
      }
    }
    cdp.close()
  } catch (error) {
    result.error = String(error?.message ?? error)
    result.logTail = log.slice(-2000)
  } finally {
    child.kill('SIGTERM')
    await wait(1500)
    if (child.exitCode == null) child.kill('SIGKILL')
    fs.rmSync(runDir, { recursive: true, force: true })
  }
  console.log(JSON.stringify({ run: index, launchToTimelineBlocksMs: result.launchToTimelineBlocksMs, nav: result.navigationMs, ipc: result.ipcMs, error: result.error }))
  return result
}

const results = []
for (let i = 0; i < runs; i++) results.push(await oneRun(i, i === runs - 1))
fs.writeFileSync(output, JSON.stringify({ takenAt: new Date().toISOString(), executable, pastDate, runs: results }, null, 2))
