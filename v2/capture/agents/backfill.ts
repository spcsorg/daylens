// The first read of a whole log history runs in short-lived child processes that write a staging database, each over a
// bounded slice of the files. Decoding gigabytes of logs leaves memory the allocator does not hand back; a process that
// exits returns all of it, so neither the children nor the long-running capture service grow with the history.

import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'
import { classifyFile, healthFromCounts, type AgentRoot, type RootCounts } from './reader.ts'
import { AgentStore } from './store.ts'
import { addCounts } from './types.ts'

export interface BackfillStats {
  wall_ms: number
  cpu_ms: number
  peak_rss_mb: number
  peak_mb?: Record<string, number>
  files_read: number
  mb_read: number
  lines: number
  records: number
  roots?: RootCounts[]
  remaining?: boolean
}

export interface BackfillResult {
  merged: boolean
  children: number
  // Totals over the children; peak_rss_mb is the largest single child.
  child: BackfillStats | null
  peaks_mb: number[]
  merge_ms: number
}

// Roots cross the process boundary as plain data; folders that need a guard (WSL) are read in the service instead.
export type PlainRoot = Omit<AgentRoot, 'available'>

const MAIN = fileURLToPath(new URL(`./backfillMain${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url))

// Bytes of log one child reads before it hands over to the next; a compressed archive counts at its decoded size.
// It bounds how much a child decodes, and so its memory, not how much of the history is read.
const SLICE_BYTES = 32 << 20
// A small young generation keeps the children's short-lived line strings from inflating their footprint.
const CHILD_FLAGS = ['--max-semi-space-size=1']

export function runChild(staging: string, roots: PlainRoot[], files: string[], budget: number, log: (msg: string) => void): Promise<BackfillStats | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, ...CHILD_FLAGS, MAIN, staging], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
    let out = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
    child.stderr.setEncoding('utf8').on('data', () => {})
    child.stdin.end(JSON.stringify({ roots, files, budget }))
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

// Every session log under the roots, in root order, so a session read plain is known before its compressed archive.
export async function listLogs(roots: PlainRoot[]): Promise<string[]> {
  const files: string[] = []
  for (const root of roots) {
    let names: string[]
    try {
      names = (await readdir(root.dir, { recursive: root.layout !== 'codex_archive' })) as string[]
    } catch {
      continue
    }
    for (const name of names.sort()) {
      const file = path.join(root.dir, name)
      if (classifyFile(root, file)) files.push(file)
    }
  }
  return files
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
      `)
    })()
  } finally {
    db.exec('DETACH DATABASE staging')
  }
}

export async function backfill(db: Database.Database, dataDir: string, roots: PlainRoot[], log: (msg: string) => void, sliceBytes = SLICE_BYTES): Promise<BackfillResult> {
  const staging = path.join(dataDir, 'agent-backfill.sqlite')
  const clean = () => {
    for (const f of [staging, `${staging}-wal`, `${staging}-shm`, `${staging}-journal`]) rmSync(f, { force: true })
  }
  clean()
  try {
    const files = await listLogs(roots)
    const total: BackfillStats = { wall_ms: 0, cpu_ms: 0, peak_rss_mb: 0, files_read: 0, mb_read: 0, lines: 0, records: 0 }
    const counts = new Map<string, RootCounts>()
    const peaks: number[] = []
    for (let remaining = files.length > 0; remaining; ) {
      const child = await runChild(staging, roots, files, sliceBytes, log)
      if (!child) return { merged: false, children: 0, child: null, merge_ms: 0, peaks_mb: [] }
      peaks.push(child.peak_rss_mb)
      total.wall_ms += child.wall_ms
      total.cpu_ms += child.cpu_ms
      total.peak_rss_mb = Math.max(total.peak_rss_mb, child.peak_rss_mb)
      total.files_read += child.files_read
      total.mb_read += child.mb_read
      total.lines += child.lines
      total.records += child.records
      remaining = child.remaining === true
      for (const r of child.roots ?? []) {
        const prev = counts.get(r.dir)
        counts.set(r.dir, prev ? { ...prev, counts: addCounts(prev.counts, r.counts), unreadable: prev.unreadable || r.unreadable } : r)
      }
    }
    const t0 = performance.now()
    mergeStaging(db, staging)
    // Health is decided once over every slice, so a clean last slice cannot hide a problem in an earlier one.
    const store = new AgentStore(db)
    for (const r of counts.values()) {
      if (r.unreadable) store.setHealth(r.agent, r.dir, 'unreadable', 'file_unreadable', null)
      else if (r.counts.lines > 0) {
        const h = healthFromCounts(r.counts)
        store.setHealth(r.agent, r.dir, h.state, h.reason, h.detail)
      }
    }
    return { merged: true, children: peaks.length, child: total, merge_ms: Math.round(performance.now() - t0), peaks_mb: peaks }
  } finally {
    clean()
  }
}
