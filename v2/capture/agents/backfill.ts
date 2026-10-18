// A worker keeps decoder state across slices without loading a second Electron process.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Worker } from 'node:worker_threads'
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
  bytes_read?: number
  lines: number
  records: number
  roots?: RootCounts[]
  progressed?: boolean
  deferred_files?: string[]
  entrypoint?: string
  runtime?: { electron: string | null; node: string }
  remaining?: boolean
}

export interface BackfillResult {
  merged: boolean
  children: number
  slices: number
  max_slice_bytes: number
  // RSS includes the capture process and its worker threads.
  child: BackfillStats | null
  peaks_mb: number[]
  merge_ms: number
}

// Roots cross the worker boundary as plain data; folders that need a guard (WSL) are read in the service instead.
export type PlainRoot = Omit<AgentRoot, 'available'>

const source = path.extname(fileURLToPath(import.meta.url)) === '.ts'
const MAIN = fileURLToPath(new URL(source ? '../../build/js/capture/agents/backfillMain.js' : './backfillMain.js', import.meta.url))
const exec = promisify(execFile)
let compiled: Promise<unknown> | null = null

const SLICE_BYTES = 4 << 20

async function prepareWorker(): Promise<void> {
  if (!source) return
  const root = fileURLToPath(new URL('../..', import.meta.url))
  compiled ??= exec(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, 'tsconfig.build.json')])
  await compiled
}

class BackfillWorker {
  private readonly worker: Worker
  private readonly exited: Promise<number>
  private pending: { resolve: (stats: BackfillStats | null) => void } | null = null
  private failed = false

  constructor(staging: string, roots: PlainRoot[], log: (msg: string) => void) {
    this.worker = new Worker(MAIN, { workerData: { staging, roots }, execArgv: [], resourceLimits: { maxYoungGenerationSizeMb: 1 } })
    this.worker.on('message', (result: BackfillStats) => {
      this.pending?.resolve(result)
      this.pending = null
    })
    this.worker.on('error', (err) => {
      this.failed = true
      log(`agent backfill failed code=${(err as { code?: unknown }).code ?? 'unknown'}`)
    })
    this.exited = new Promise((resolve) => this.worker.on('exit', (code) => {
      this.failed = true
      if (this.pending) log(`agent backfill exited before replying exit=${code}`)
      this.pending?.resolve(null)
      this.pending = null
      resolve(code)
    }))
  }

  slice(files: string[], budget: number): Promise<BackfillStats | null> {
    if (this.failed) return Promise.resolve(null)
    return new Promise((resolve) => {
      this.pending = { resolve }
      this.worker.postMessage({ files, budget })
    })
  }

  async close(): Promise<void> {
    if (!this.failed) this.worker.postMessage({ stop: true })
    await this.exited
  }
}

export async function runChild(staging: string, roots: PlainRoot[], files: string[], budget: number, log: (msg: string) => void): Promise<BackfillStats | null> {
  await prepareWorker()
  const worker = new BackfillWorker(staging, roots, log)
  try { return await worker.slice(files, budget) }
  finally { await worker.close() }
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
        INSERT INTO agent_sources (path, agent, root, session_id, dev, ino, offset, size, state, turnless, lines, bad_lines, unknown_records, updated_wall_ms)
          SELECT path, agent, root, session_id, dev, ino, offset, size, state, turnless, lines, bad_lines, unknown_records, updated_wall_ms FROM staging.agent_sources WHERE true
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
  const filesToRead = await listLogs(roots)
  if (filesToRead.length === 0) return { merged: true, children: 0, slices: 0, max_slice_bytes: 0, child: null, merge_ms: 0, peaks_mb: [] }
  await prepareWorker()
  const worker = new BackfillWorker(staging, roots, log)
  try {
    let files = filesToRead
    const total: BackfillStats = { wall_ms: 0, cpu_ms: 0, peak_rss_mb: 0, files_read: 0, mb_read: 0, lines: 0, records: 0 }
    const counts = new Map<string, RootCounts>()
    const peaks: number[] = []
    let maxSlice = 0
    for (let remaining = files.length > 0; remaining; ) {
      const child = await worker.slice(files, sliceBytes)
      if (!child) return { merged: false, children: 0, slices: 0, max_slice_bytes: 0, child: null, merge_ms: 0, peaks_mb: [] }
      peaks.push(child.peak_rss_mb)
      maxSlice = Math.max(maxSlice, child.bytes_read ?? 0)
      total.entrypoint = child.entrypoint
      total.runtime = child.runtime
      total.bytes_read = (total.bytes_read ?? 0) + (child.bytes_read ?? 0)
      total.wall_ms += child.wall_ms
      total.cpu_ms += child.cpu_ms
      total.peak_rss_mb = Math.max(total.peak_rss_mb, child.peak_rss_mb)
      total.peak_mb ??= {}
      for (const [key, value] of Object.entries(child.peak_mb ?? {})) total.peak_mb[key] = Math.max(total.peak_mb[key] ?? 0, value)
      total.files_read += child.files_read
      total.mb_read += child.mb_read
      total.lines += child.lines
      total.records += child.records
      remaining = child.remaining === true
      const deferred = new Set(child.deferred_files)
      files = files.filter((f) => !deferred.has(f))
      for (const r of child.roots ?? []) {
        const prev = counts.get(r.dir)
        counts.set(r.dir, prev ? { ...prev, counts: addCounts(prev.counts, r.counts), unreadable: prev.unreadable || r.unreadable } : r)
      }
      if (remaining && !child.progressed) {
        log('agent backfill made no committed progress; live reader takes over remaining logs')
        break
      }
    }
    const t0 = performance.now()
    mergeStaging(db, staging)
    // Health is decided once over every slice, so a clean last slice cannot hide a problem in an earlier one.
    const store = new AgentStore(db)
    for (const r of counts.values()) {
      if (r.unreadable) store.setHealth(r.agent, r.dir, 'unreadable', 'file_unreadable', null)
      else if (r.counts.lines > 0) {
        const h = healthFromCounts(r.counts, store.hasTurnlessSource(r.dir))
        store.setHealth(r.agent, r.dir, h.state, h.reason, h.detail)
      }
    }
    return { merged: true, children: 1, slices: peaks.length, max_slice_bytes: maxSlice, child: total, merge_ms: Math.round(performance.now() - t0), peaks_mb: peaks }
  } finally {
    await worker.close()
    clean()
  }
}
