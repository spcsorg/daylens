import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket from 'ws'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const electron = require('electron')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const output = path.resolve(process.argv[2] ?? 'artifacts/desktop-synthetic')
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.mkdirSync(output) // A failed rerun must not leave a previous PASS report beside new logs.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-synthetic-'))
const userData = path.join(temporary, 'profile')
let child
let socket
let sessionId
const pending = new Map()
let nextId = 0

function call(method, params = {}) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP timed out: ${method}`))
    }, 30_000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
}

async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails))
  return result.result?.value
}

async function until(operation, description) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const value = await operation()
    if (value) return value
    await wait(50)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function screenshot(name) {
  // Two animation frames allow the committed React DOM to reach a paint.
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')
  const { data } = await call('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(data, 'base64'))
}

try {
  const seed = spawn(electron, ['--loader', './tests/support/ts-loader.mjs', 'scripts/performance/seed.ts', userData], {
    cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const seedLog = fs.createWriteStream(path.join(output, 'seed.log'))
  seed.stdout.pipe(seedLog, { end: false })
  seed.stderr.pipe(seedLog, { end: false })
  const [seedCode] = await once(seed, 'exit')
  seedLog.end()
  assert.equal(seedCode, 0, 'Synthetic fixture creation failed; see seed.log')
  const fixture = JSON.parse(fs.readFileSync(path.join(userData, 'fixture.json'), 'utf8'))
  const environment = { ...process.env, DAYLENS_DEV_USERDATA: userData,
    DAYLENS_REAL_DAY_HARNESS: '1', DAYLENS_REAL_DAY_DATE: fixture.today,
    DAYLENS_REAL_DAY_ALLOW_MODEL_NETWORK: '0' }
  delete environment.ELECTRON_RUN_AS_NODE
  const launchedAt = performance.now()
  child = spawn(electron, ['--remote-debugging-port=0', 'dist/main/main.js'], {
    cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (chunk) => { log += chunk })
  child.stderr.on('data', (chunk) => { log += chunk })
  child.on('exit', () => fs.writeFileSync(path.join(output, 'desktop.log'), log))
  const endpoint = await until(() => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Electron exited: ${child.exitCode ?? child.signalCode}`)
    return log.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-zA-Z0-9-]+)/)?.[1]
  }, 'spawned Electron debugging endpoint')
  socket = new WebSocket(endpoint)
  await once(socket, 'open')
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    const request = pending.get(message.id)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(message.id)
    if (message.error) request.reject(new Error(JSON.stringify(message.error)))
    else request.resolve(message.result)
  })
  const rendererUrl = pathToFileURL(path.join(root, 'dist/renderer/main_window/index.html')).href
  const target = await until(async () => {
    const { targetInfos } = await call('Target.getTargets')
    return targetInfos.find((entry) => entry.type === 'page' && (entry.url === rendererUrl || entry.url.startsWith(`${rendererUrl}#`)))
  }, 'built Daylens renderer target')
  const attached = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true })
  sessionId = attached.sessionId
  await until(() => evaluate('Boolean(window.daylens && document.querySelector("main"))'), 'application shell')
  const shellObservedMs = performance.now() - launchedAt
  const started = performance.now()
  await evaluate(`location.hash = ${JSON.stringify(`#/timeline?view=day&date=${fixture.today}`)}`)
  await until(() => evaluate('document.querySelectorAll("[data-timeline-block-id]").length'), 'Timeline blocks')
  const timelineObservedMs = performance.now() - started
  await screenshot('timeline')
  await evaluate('location.hash = "#/apps"')
  await until(() => evaluate('[...document.querySelectorAll("button")].some(b => b.textContent.trim() === "30d")'), 'Apps range selector')
  await screenshot('apps-day')
  await evaluate('[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "30d").click()')
  await until(() => evaluate('document.body.innerText.includes("Last 30 days")'), '30-day selection')
  // A separate IPC read measures the service boundary; it is not a renderer load timer.
  const apps = await evaluate(`(async () => {
    const start = performance.now()
    const rows = await window.daylens.db.getAppSummaries(30)
    return { ipcMs: performance.now() - start, count: rows.length, names: rows.map(row => row.appName) }
  })()`)
  assert.ok(apps.count > 0, '30-day Apps returned no rows')
  await until(() => evaluate('document.body.innerText.includes("VS Code") && document.body.innerText.includes("Google Chrome") && document.body.innerText.includes("Zoom") && document.body.innerText.includes("30 sessions") && !document.body.innerText.includes("Could not load apps")'), '30-day fixture rows rendered')
  await screenshot('apps-30d')
  await evaluate('location.hash = "#/ai"')
  await until(() => evaluate(`Boolean(document.querySelector('[aria-label="Ask Daylens about your work history"]'))`), 'AI composer')
  await screenshot('ai')
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({
    schemaVersion: 1, platform: process.platform, arch: process.arch, fixture,
    shellObservedMs, timelineObservedMs, apps,
    limitations: [
      'Development Electron runtime, not installed-app cold start or OS cold-cache evidence.',
      'Synthetic 32-day fixture, not representative large-profile performance.',
      'Harness disables capture, background integrations, and range worker; Apps uses inline fallback.',
      'DOM observation times include CDP polling and do not measure first paint or click-to-interactive.',
      'Apps IPC read can overlap or follow the renderer read; it is not an uncached first read.',
      'AI composer only; no provider request, TTFT, or subscription-provider validation.',
    ],
  }, null, 2))
  fs.writeFileSync(path.join(output, 'desktop.log'), log)
  console.log(`Synthetic desktop check passed: ${output}`)
} catch (error) {
  if (socket?.readyState === WebSocket.OPEN) {
    try {
      fs.writeFileSync(path.join(output, 'failure.txt'), await evaluate('document.body.innerText'))
      await screenshot('failure')
    } catch (diagnosticError) {
      console.error('Could not capture failure diagnostics:', diagnosticError)
    }
  }
  throw error
} finally {
  socket?.close()
  for (const request of pending.values()) clearTimeout(request.timer)
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill()
    await Promise.race([once(child, 'exit'), wait(5000)])
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
  }
  fs.rmSync(temporary, { recursive: true, force: true })
}
