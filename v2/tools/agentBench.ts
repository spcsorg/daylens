// Cost of the agent readers while coding agents write busy logs, and of the first read of a large history.
// The reader runs in its own process, as in the capture service; this process writes synthetic logs and samples it.
// Usage: node tools/agentBench.ts --out <dir> [--minutes 10] [--warmup-s 30] [--history-mb 0] [--sessions 4]
//   --history-mb N   first writes N MB of synthetic history and reports how long the first read takes
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { claude, claudeCtx, codex, codexCtx, type ClaudeCtx, type CodexCtx } from '../tests/agents/fixtures.ts'

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    minutes: { type: 'string', default: '10' },
    'warmup-s': { type: 'string', default: '30' },
    'history-mb': { type: 'string', default: '0' },
    sessions: { type: 'string', default: '4' },
    child: { type: 'boolean', default: false },
    home: { type: 'string' },
    data: { type: 'string' },
  },
})

const filler = (n: number) => 'x'.repeat(n)

if (values.child) {
  // The measured process: a store and an agent reader, sampling itself every second.
  const { Store } = await import('../capture/store.ts')
  const { AgentStore } = await import('../capture/agents/store.ts')
  const { AgentReader, homeRoots } = await import('../capture/agents/reader.ts')
  const { backfill } = await import('../capture/agents/backfill.ts')
  const store = new Store(values.data!)
  const t0 = performance.now()
  const reader = new AgentReader(new AgentStore(store.database), homeRoots(values.home!, {}), {
    reconcileMs: 60_000,
    backfill: async (roots) => {
      const r = await backfill(store.database, values.data!, roots, () => {})
      process.stdout.write(`${JSON.stringify({ backfill: r })}\n`)
      return r.merged
    },
  })
  await reader.start()
  process.stdout.write(`${JSON.stringify({ started_ms: Math.round(performance.now() - t0), rss: process.memoryUsage().rss })}\n`)
  let last = process.cpuUsage()
  let lastT = performance.now()
  setInterval(() => {
    const cpu = process.cpuUsage(last)
    const now = performance.now()
    const m = process.memoryUsage()
    process.stdout.write(`${JSON.stringify({ t: Date.now(), cpu_pct: ((cpu.user + cpu.system) / 1000 / (now - lastT)) * 100, rss: m.rss, heap: m.heapUsed, ...reader.stats })}\n`)
    last = process.cpuUsage()
    lastT = now
  }, 1000)
  process.stdin.on('end', () => void reader.stop().then(() => process.exit(0))).resume()
} else {
  const out = values.out!
  const home = path.join(out, 'home')
  const data = path.join(out, 'data')
  mkdirSync(data, { recursive: true })
  const nSessions = Number(values.sessions)
  const claudeSessions: { c: ClaudeCtx; file: string }[] = []
  const codexSessions: { c: CodexCtx; file: string }[] = []
  for (let i = 0; i < nSessions; i++) {
    if (i % 4 === 3) {
      const c = codexCtx()
      const dir = path.join(home, '.codex', 'sessions', '2026', '10', '17')
      mkdirSync(dir, { recursive: true })
      codexSessions.push({ c, file: path.join(dir, `rollout-2026-10-17T09-00-00-${c.id}.jsonl`) })
    } else {
      const c = claudeCtx()
      const dir = path.join(home, '.claude', 'projects', `-bench-${i}`)
      mkdirSync(dir, { recursive: true })
      claudeSessions.push({ c, file: path.join(dir, `${c.session}.jsonl`) })
    }
  }

  // Synthetic history shaped like real logs: most bytes are tool output, a few are prompts and replies.
  const historyMb = Number(values['history-mb'])
  if (historyMb > 0) {
    let written = 0
    let n = 0
    let t = Date.parse('2026-09-01T08:00:00Z')
    while (written < historyMb * 1e6) {
      const c = claudeCtx()
      const dir = path.join(home, '.claude', 'projects', `-history-${n % 40}`)
      mkdirSync(dir, { recursive: true })
      const parts: string[] = []
      for (let turn = 0; turn < 20; turn++) {
        parts.push(claude.prompt(c, (t += 60_000), `history prompt ${turn}`))
        for (let k = 0; k < 8; k++) {
          const id = `toolu_${randomUUID()}`
          parts.push(claude.assistant(c, (t += 3_000), 'tool_use', { text: filler(400), tools: [{ id, name: 'Bash' }] }))
          parts.push(claude.toolResult(c, (t += 4_000), id, filler(2_000 + ((n * 7919 + k * 104_729) % 60_000))))
        }
        parts.push(claude.assistant(c, (t += 2_000), 'end_turn', { text: filler(800) }))
        parts.push(claude.system(c, (t += 100), 'turn_duration'))
      }
      const body = `${parts.join('\n')}\n`
      writeFileSync(path.join(dir, `${c.session}.jsonl`), body)
      written += body.length
      n++
    }
    process.stderr.write(`history: ${n} files, ${(written / 1e6).toFixed(0)} MB\n`)
  }

  const self = fileURLToPath(import.meta.url)
  const child = spawn(process.execPath, [self, '--child', '--home', home, '--data', data], { stdio: ['pipe', 'pipe', 'inherit'] })
  const samples: Record<string, number>[] = []
  let started: Record<string, unknown> | null = null
  let backfillResult: unknown = null
  let buf = ''
  child.stdout.setEncoding('utf8').on('data', (d: string) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const o = JSON.parse(buf.slice(0, i)) as Record<string, unknown>
      buf = buf.slice(i + 1)
      if ('backfill' in o) backfillResult = o.backfill
      else if ('started_ms' in o) started = o
      else samples.push(o as Record<string, number>)
    }
  })
  while (!started) await new Promise((r) => setTimeout(r, 50))

  // Busy agents: each Claude session replies every 2 s and returns tool output (10-200 KB) every 5 s, with a new
  // prompt every minute; each Codex session writes items every second and a 50 KB tool output every 10 s.
  let appended = 0
  const append = (file: string, ls: string[]) => {
    const s = `${ls.join('\n')}\n`
    appendFileSync(file, s)
    appended += s.length
  }
  const t0 = Date.now()
  const end = t0 + Number(values.minutes) * 60_000
  let tick = 0
  const turnOf = new Map<string, string>()
  while (Date.now() < end) {
    const now = Date.now()
    for (const { c, file } of claudeSessions) {
      if (tick % 60 === 0) append(file, [claude.system(c, now, 'turn_duration'), claude.prompt(c, now, `bench prompt ${tick}`)])
      if (tick % 2 === 0) append(file, [claude.assistant(c, now, 'tool_use', { text: filler(1500), tools: [{ id: `toolu_${tick}`, name: 'Bash' }] })])
      if (tick % 5 === 0) append(file, [claude.toolResult(c, now, `toolu_${tick}`, filler(10_000 + ((tick * 7919) % 190_000)))])
    }
    for (const { c, file } of codexSessions) {
      if (tick === 0) append(file, [codex.meta(c, now)])
      if (tick % 60 === 0) {
        const prev = turnOf.get(c.id)
        const turn = randomUUID()
        turnOf.set(c.id, turn)
        append(file, [...(prev ? [codex.complete(now, prev, now - 60_000, now)] : []), codex.started(now, turn, 'composer'), codex.userItem(now, `bench ${tick}`, ['user.text'])])
      }
      append(file, [codex.assistant(now, filler(2_000)), codex.tokens(now)])
      if (tick % 10 === 0) append(file, [codex.toolCall(now, filler(50_000))])
    }
    tick++
    await new Promise((r) => setTimeout(r, Math.max(0, t0 + tick * 1000 - Date.now())))
  }
  child.stdin.end()
  await new Promise((r) => child.on('exit', r))

  const warm = samples.filter((s) => s.t! >= t0 + Number(values['warmup-s']) * 1000)
  const cpu = warm.map((s) => s.cpu_pct!)
  const rss = warm.map((s) => s.rss! / 1e6)
  const xs = warm.map((s) => (s.t! - warm[0]!.t!) / 3_600_000)
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
  const mx = mean(xs)
  const my = mean(rss)
  const slope = xs.reduce((acc, x, i) => acc + (x - mx) * (rss[i]! - my), 0) / xs.reduce((acc, x) => acc + (x - mx) ** 2, 0)
  const sorted = [...cpu].sort((a, b) => a - b)
  const summary = {
    sessions: { claude: claudeSessions.length, codex: codexSessions.length },
    minutes: Number(values.minutes),
    appended_mb_per_min: +(appended / 1e6 / Number(values.minutes)).toFixed(2),
    first_read: started,
    backfill: backfillResult,
    cpu_pct_mean: +mean(cpu).toFixed(3),
    cpu_pct_p95: +(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(3),
    rss_mb_mean: +my.toFixed(1),
    rss_mb_max: +Math.max(...rss).toFixed(1),
    rss_mb_first: +(rss[0] ?? 0).toFixed(1),
    rss_mb_last: +(rss[rss.length - 1] ?? 0).toFixed(1),
    rss_slope_mb_per_hour: +slope.toFixed(2),
    lines_read: warm[warm.length - 1]?.lines,
    db_mb: +(statSync(path.join(data, 'daylens-v2.sqlite')).size / 1e6).toFixed(1),
  }
  writeFileSync(path.join(out, 'samples.jsonl'), samples.map((s) => JSON.stringify(s)).join('\n'))
  writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
}
