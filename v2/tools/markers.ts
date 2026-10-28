// Scripted app switches and title changes at logged times, compared with what capture recorded.
// It takes over the screen for about a minute. Usage: node tools/markers.ts --helper <path> --out <dir>
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { DELETION_STALL_MS } from '../capture/defaults.ts'

const { values } = parseArgs({ options: { helper: { type: 'string' }, out: { type: 'string' }, 'deletion-stall-ms': { type: 'string', default: String(DELETION_STALL_MS) } } })
const out = values.out!
const service = fileURLToPath(new URL('../capture/service.ts', import.meta.url))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const osa = (script: string) => execFileSync('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()

const APPS: Record<string, string> = {
  Finder: 'com.apple.finder',
  TextEdit: 'com.apple.TextEdit',
  Terminal: 'com.apple.Terminal',
  Calculator: 'com.apple.calculator',
}

interface Marker {
  t_ms: number
  kind: 'app' | 'title'
  app_id: string
  title?: string
}

async function main(): Promise<void> {
  mkdirSync(out, { recursive: true })
  const original = osa('tell application "System Events" to get name of first application process whose frontmost is true')
  for (const app of Object.keys(APPS)) execFileSync('open', ['-g', '-a', app])
  osa('tell application "Terminal" to if (count of windows) is 0 then do script ""')
  await sleep(1500)

  const svc = spawn(process.execPath, [service, '--helper', values.helper!, '--deletion-stall-ms', values['deletion-stall-ms']!, '--data-dir', path.join(out, 'data')], { stdio: ['ignore', 'ignore', 'inherit'] })
  await sleep(2000)

  const markers: Marker[] = []
  const names = Object.keys(APPS)
  // Normal pace, then sub-second switches that a polling design would miss.
  const gaps = [...Array(12).fill(1200), ...Array(8).fill(250)]
  for (let i = 0; i < gaps.length; i++) {
    const app = names[i % names.length]!
    markers.push({ t_ms: Date.now(), kind: 'app', app_id: APPS[app]! })
    osa(`tell application "${app}" to activate`)
    await sleep(gaps[i]!)
  }
  osa('tell application "Terminal" to activate')
  await sleep(800)
  for (let i = 0; i < 5; i++) {
    // Another app can take the front at any time; a title change only counts on the focused window.
    osa('tell application "Terminal" to activate')
    await sleep(400)
    const title = `daylens-marker-${i}`
    markers.push({ t_ms: Date.now(), kind: 'title', app_id: APPS.Terminal!, title })
    osa(`tell application "Terminal" to set custom title of front window to "${title}"`)
    await sleep(800)
  }
  await sleep(1500)
  svc.kill('SIGTERM')
  await new Promise((r) => svc.once('exit', r))
  osa(`tell application "${original}" to activate`)

  const db = new Database(path.join(out, 'data', 'daylens-v2.sqlite'), { readonly: true })
  const rows = db.prepare(`SELECT app_id, title, event_wall_ms FROM observations WHERE kind = 'focus' ORDER BY event_wall_ms`).all() as {
    app_id: string | null
    title: string | null
    event_wall_ms: number
  }[]
  db.close()

  const results = markers.map((m, i) => {
    const until = markers[i + 1]?.t_ms ?? m.t_ms + 3000
    const hit = rows.find((r) => r.event_wall_ms >= m.t_ms - 20 && r.event_wall_ms < Math.max(until, m.t_ms + 150) + 400 && r.app_id === m.app_id && (m.kind === 'app' || r.title?.includes(m.title!)))
    return { ...m, seen: hit !== undefined, latency_ms: hit ? hit.event_wall_ms - m.t_ms : null }
  })
  const lat = results.filter((r) => r.latency_ms !== null).map((r) => r.latency_ms!).sort((a, b) => a - b)
  const pct = (p: number) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] ?? null
  const summary = {
    markers: results.length,
    missed: results.filter((r) => !r.seen).map((r) => ({ kind: r.kind, app_id: r.app_id, title: r.title })),
    latency_ms: { p50: pct(50), p95: pct(95), max: lat[lat.length - 1] ?? null },
    fast_switches_seen: results.slice(12, 20).filter((r) => r.seen).length + '/8',
  }
  writeFileSync(path.join(out, 'markers.json'), JSON.stringify({ summary, results }, null, 2))
  console.log(JSON.stringify(summary, null, 2))
}

await main()
