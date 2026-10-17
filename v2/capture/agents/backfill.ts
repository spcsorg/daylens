// The first read of a whole log history runs in a short-lived child process that writes a staging database.
// Decoding gigabytes of history leaves memory the allocator does not hand back; a process that exits returns all of it,
// so the long-running capture service only ever reads what is appended afterwards.

import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'
import type { AgentRoot } from './reader.ts'

export interface BackfillStats {
  wall_ms: number
  cpu_ms: number
  peak_rss_mb: number
  files_read: number
  mb_read: number
  lines: number
  records: number
}

export interface BackfillResult {
  merged: boolean
  child: BackfillStats | null
  merge_ms: number
}

// Roots cross the process boundary as plain data; folders that need a guard (WSL) are read in the service instead.
export type PlainRoot = Omit<AgentRoot, 'available'>

const MAIN = fileURLToPath(new URL(`./backfillMain${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url))

export function runChild(staging: string, roots: PlainRoot[], log: (msg: string) => void): Promise<BackfillStats | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, MAIN, staging], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
    let out = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
    child.stderr.setEncoding('utf8').on('data', () => {})
    child.stdin.end(JSON.stringify(roots))
    child.on('error', (err) => {
      log(`agent backfill could not start code=${(err as { code?: unknown }).code ?? 'unknown'}`)
      resolve(null)
    })
    child.on('exit', (code) => {
      if (code !== 0) {
        log(`agent backfill failed exit=${code}`)
        return resolve(null)
      }
      try {
        resolve(JSON.parse(out.trim().split('\n').pop() ?? '') as BackfillStats)
      } catch {
        resolve(null)
      }
    })
  })
}

// Merges the staging tables into the live ones. Rows already present win: they were read by this process.
export function mergeStaging(db: Database.Database, staging: string): void {
  db.prepare('ATTACH DATABASE ? AS staging').run(staging)
  try {
    db.transaction(() => {
      db.exec(`
        INSERT INTO agent_sessions (agent, session_id, origin, parent_session_id, client, project_dir, branch, first_wall_ms, last_wall_ms, recorded_wall_ms)
          SELECT agent, session_id, origin, parent_session_id, client, project_dir, branch, first_wall_ms, last_wall_ms, recorded_wall_ms FROM staging.agent_sessions WHERE true
          ON CONFLICT (agent, session_id) DO UPDATE SET first_wall_ms = min(first_wall_ms, excluded.first_wall_ms), last_wall_ms = max(last_wall_ms, excluded.last_wall_ms);
        INSERT INTO agent_turns (agent, turn_key, session_id, project_dir, branch, opened_by, replayed, start_wall_ms, last_activity_wall_ms, end_wall_ms, end_state, recorded_wall_ms)
          SELECT agent, turn_key, session_id, project_dir, branch, opened_by, replayed, start_wall_ms, last_activity_wall_ms, end_wall_ms, end_state, recorded_wall_ms FROM staging.agent_turns WHERE true
          ON CONFLICT (agent, turn_key) DO NOTHING;
        INSERT INTO agent_events (agent, event_key, session_id, turn_key, kind, detail, basis, wall_ms, end_wall_ms, recorded_wall_ms)
          SELECT agent, event_key, session_id, turn_key, kind, detail, basis, wall_ms, end_wall_ms, recorded_wall_ms FROM staging.agent_events WHERE true
          ON CONFLICT (agent, event_key) DO NOTHING;
        INSERT INTO agent_sources (path, agent, root, session_id, dev, ino, offset, size, state, lines, bad_lines, unknown_records, updated_wall_ms)
          SELECT path, agent, root, session_id, dev, ino, offset, size, state, lines, bad_lines, unknown_records, updated_wall_ms FROM staging.agent_sources WHERE true
          ON CONFLICT (path) DO NOTHING;
        INSERT INTO agent_health (agent, root, state, reason, since_wall_ms, checked_wall_ms, detail)
          SELECT agent, root, state, reason, since_wall_ms, checked_wall_ms, detail FROM staging.agent_health WHERE true
          ON CONFLICT (agent, root) DO UPDATE SET state = excluded.state, reason = excluded.reason, since_wall_ms = excluded.since_wall_ms,
            checked_wall_ms = excluded.checked_wall_ms, detail = excluded.detail;
      `)
    })()
  } finally {
    db.exec('DETACH DATABASE staging')
  }
}

export async function backfill(db: Database.Database, dataDir: string, roots: PlainRoot[], log: (msg: string) => void): Promise<BackfillResult> {
  const staging = path.join(dataDir, 'agent-backfill.sqlite')
  const clean = () => {
    for (const f of [staging, `${staging}-wal`, `${staging}-shm`, `${staging}-journal`]) rmSync(f, { force: true })
  }
  clean()
  try {
    const child = await runChild(staging, roots, log)
    if (!child) return { merged: false, child: null, merge_ms: 0 }
    const t0 = performance.now()
    mergeStaging(db, staging)
    return { merged: true, child, merge_ms: Math.round(performance.now() - t0) }
  } finally {
    clean()
  }
}
