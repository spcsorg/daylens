// Reads every Claude Code and Codex log under a home folder into a fresh database and reports the cost of that first scan.
// Usage: node tools/agentScan.ts --data-dir <empty dir> [--home <dir>] [--again] [--in-process]
//   --again        runs a second pass over the same database, which must read nothing new
//   --in-process   reads the history in this process instead of the backfill child the service uses
import os from 'node:os'
import { parseArgs } from 'node:util'
import { backfill, type BackfillResult } from '../capture/agents/backfill.ts'
import { AgentReader, homeRoots } from '../capture/agents/reader.ts'
import { AgentStore } from '../capture/agents/store.ts'
import { Store } from '../capture/store.ts'

const { values } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
    home: { type: 'string' },
    again: { type: 'boolean', default: false },
    'in-process': { type: 'boolean', default: false },
  },
})

const store = new Store(values['data-dir']!)
const agentStore = new AgentStore(store.database)
const roots = homeRoots(values.home ?? os.homedir())

async function pass(label: string): Promise<void> {
  let peakRss = process.memoryUsage().rss
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }, 50)
  const cpu0 = process.cpuUsage()
  const t0 = performance.now()
  let child: BackfillResult | null = null
  const reader = new AgentReader(agentStore, roots, {
    reconcileMs: 3_600_000,
    ...(values['in-process'] ? {} : { backfill: async (r) => (child = await backfill(store.database, values['data-dir']!, r, console.error)).merged }),
  })
  await reader.start()
  await reader.settle()
  await reader.stop()
  const wall = performance.now() - t0
  const cpu = process.cpuUsage(cpu0)
  clearInterval(sampler)
  peakRss = Math.max(peakRss, process.memoryUsage().rss)
  const counts = store.query<{ t: string; n: number }>(
    `SELECT 'sessions' AS t, count(*) AS n FROM agent_sessions UNION ALL SELECT 'turns', count(*) FROM agent_turns
     UNION ALL SELECT 'user_events', count(*) FROM agent_events WHERE kind = 'user' UNION ALL SELECT 'waits', count(*) FROM agent_events WHERE kind = 'wait'`,
  )
  console.log(
    JSON.stringify({
      pass: label,
      backfill_child: child,
      wall_ms: Math.round(wall),
      cpu_ms: Math.round((cpu.user + cpu.system) / 1000),
      peak_rss_mb: Math.round(peakRss / 1e6),
      kernel_peak_rss_mb: process.resourceUsage().maxRSS * 1024 / 1e6,
      rss_after_mb: Math.round(process.memoryUsage().rss / 1e6),
      files_read: reader.stats.filesRead,
      bytes_read: reader.stats.bytesRead,
      mb_read: Math.round(reader.stats.bytesRead / 1e6),
      lines: reader.stats.lines,
      records: reader.stats.records,
      table_rows: Object.fromEntries(counts.map((c) => [c.t, c.n])),
      health: agentStore.health().map((h) => ({ agent: h.agent, root: h.root.replace(os.homedir(), '~'), state: h.state, reason: h.reason, detail: h.detail })),
    }),
  )
}

await pass('first')
if (values.again) await pass('again')
store.close()
