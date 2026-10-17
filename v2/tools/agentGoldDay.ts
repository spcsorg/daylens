// Gold-day check for agent sessions: reads the agent logs into a fresh database, takes lock, sleep, idle and capture-gap
// spans from the day's frozen hour packets, and prints per hour who was working: the agent with the person present,
// the agent while the person was away, and every act the person made. Prints metadata only, never message text.
// Usage: node tools/agentGoldDay.ts --data-dir <empty dir> --packets <dir> --date 2026-10-14 --utc-offset-min 120 [--home <dir>]
import { readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { agentSegments, presenceTimeline, summarize, type Interval, type PresenceInputs } from '../capture/agents/attribution.ts'
import { backfill } from '../capture/agents/backfill.ts'
import { AgentReader, homeRoots } from '../capture/agents/reader.ts'
import { AgentStore } from '../capture/agents/store.ts'
import { Store } from '../capture/store.ts'

const { values } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
    packets: { type: 'string' },
    date: { type: 'string' },
    'utc-offset-min': { type: 'string', default: '0' },
    home: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
})

const offsetMs = Number(values['utc-offset-min']) * 60_000
const dayStart = Date.parse(`${values.date}T00:00:00Z`) - offsetMs
const HOUR = 3_600_000
const clock = (ms: number) => new Date(ms + offsetMs).toISOString().slice(11, 16)
const minutes = (ms: number) => Math.round(ms / 60_000)

interface PacketGap {
  kind: string
  start: string
  end: string
}

// Packet times are local clock times on the gold day; a span that ends before it starts ran past midnight.
function packetPresence(dir: string): { inputs: PresenceInputs; hours: number[] } {
  const seen = new Set<string>()
  const inputs: PresenceInputs = { covered: [], locked: [], asleep: [], idle: [], unknown: [] }
  const hours: number[] = []
  const at = (hhmmss: string) => {
    const [h, m, s] = hhmmss.split(':').map(Number)
    return dayStart + ((h! * 60 + m!) * 60 + s!) * 1000
  }
  for (const f of readdirSync(dir).filter((n) => /^hour_\d\d\.json$/.test(n)).sort()) {
    const hour = Number(f.slice(5, 7))
    hours.push(hour)
    const p = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as { away_and_gaps: PacketGap[] }
    for (const g of p.away_and_gaps) {
      const key = `${g.kind}|${g.start}|${g.end}`
      if (seen.has(key)) continue
      seen.add(key)
      const start = at(g.start)
      const end = g.end === 'open' ? dayStart + (hour + 1) * HOUR : at(g.end)
      const span: Interval = { start, end: end >= start ? end : end + 24 * HOUR }
      if (g.kind === 'screen_locked') inputs.locked.push(span)
      else if (g.kind === 'asleep') inputs.asleep.push(span)
      else if (g.kind.startsWith('input_idle')) inputs.idle.push(span)
      else if (g.kind === 'capture_gap') inputs.unknown.push(span)
    }
  }
  return { inputs, hours }
}

const store = new Store(values['data-dir']!)
const agentStore = new AgentStore(store.database)
const reader = new AgentReader(agentStore, homeRoots(values.home ?? os.homedir()), {
  reconcileMs: 3_600_000,
  backfill: async (roots) => (await backfill(store.database, values['data-dir']!, roots, console.error)).merged,
})
await reader.start()
await reader.settle()
await reader.stop()

const { inputs, hours } = packetPresence(values.packets!)
// The packets cover midnight to the end of their last hour; the lock and sleep spans inside them explain the night.
inputs.covered = [{ start: dayStart, end: dayStart + (Math.max(...hours) + 1) * HOUR }]
const from = dayStart
const to = dayStart + 24 * HOUR
const presence = presenceTimeline(from, to, inputs)
const turns = agentStore.turns(from, to)
const events = agentStore.events(from, to)
const segments = agentSegments(turns, events, presence)

const report = []
for (let h = 0; h < 24; h++) {
  const a = dayStart + h * HOUR
  const b = a + HOUR
  const people = segments.filter((s) => s.origin !== 'automated')
  const sum = summarize(people, events, a, b)
  const automated = summarize(segments.filter((s) => s.origin === 'automated'), [], a, b)
  const row = {
    hour: clock(a),
    with_you_min: minutes(sum.working.present),
    while_away_min: minutes(sum.working.away + sum.working.asleep),
    unknown_min: minutes(sum.working.unknown),
    waiting_min: minutes(sum.waiting),
    automated_min: minutes(automated.working.present + automated.working.away + automated.working.asleep + automated.working.unknown),
    sessions: sum.sessions
      .filter((s) => s.working_ms > 0)
      .map((s) => `${s.agent === 'codex' ? 'Codex' : 'Claude'}:${s.project ? path.basename(s.project) : '?'}${s.origin === 'subagent' ? '(sub)' : ''} ${minutes(s.working_ms)}m`),
    automated: automated.sessions.filter((s) => s.working_ms > 0).map((s) => `${s.agent === 'codex' ? 'Codex' : 'Claude'}:${s.project ? path.basename(s.project) : '?'} ${minutes(s.working_ms)}m`),
    acts: sum.user.map((u) => `${clock(u.at)} ${u.act}${u.basis === 'inferred' ? '?' : ''}`),
    away: presence
      .filter((p) => p.state !== 'present' && p.end > a && p.start < b && Math.min(p.end, b) - Math.max(p.start, a) >= 60_000)
      .map((p) => `${p.why ?? p.state} ${clock(Math.max(p.start, a))}-${clock(Math.min(p.end, b))}`),
  }
  if (row.with_you_min + row.while_away_min + row.unknown_min + row.automated_min + row.acts.length === 0) continue
  report.push(row)
}

if (values.json) console.log(JSON.stringify(report, null, 1))
else
  for (const r of report) {
    console.log(`${r.hour}  with you ${r.with_you_min}m · away ${r.while_away_min}m · unknown ${r.unknown_min}m · waiting ${r.waiting_min}m · automated ${r.automated_min}m`)
    if (r.sessions.length) console.log(`       sessions: ${r.sessions.join(', ')}`)
    if (r.automated.length) console.log(`       automated: ${r.automated.join(', ')}`)
    if (r.acts.length) console.log(`       your acts (${r.acts.length}): ${r.acts.join(', ')}`)
    if (r.away.length) console.log(`       away: ${r.away.join(', ')}`)
  }
store.close()
