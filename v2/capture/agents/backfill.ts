// A worker keeps decoder state across slices without loading a second Electron process.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Worker } from 'node:worker_threads'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'
import { classifyFile, healthFromCounts, type AgentRoot, type RootCounts } from './reader.ts'
import type { Span } from './withheld.ts'
import type { GatePolicy, HostRecordBasis } from './gate.ts'
import { AgentStore, loadFingerprintKey, removeStaging, STAGING_FILE, type SourceUpdate } from './store.ts'
import { addCounts, emptyCounts, type Agent, type AgentRecord, type Basis, type SessionOrigin, type TurnEndState, type TurnOpener, type UserAct, type WaitReason } from './types.ts'

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
// A slice reads at most SLICE_BYTES and takes about 0.1 s; one still running after this is hung.
const SLICE_TIMEOUT_MS = 60_000

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

  constructor(staging: string, roots: PlainRoot[], log: (msg: string) => void, spans: readonly Span[] = [], live: string | null = null, platform: NodeJS.Platform = process.platform) {
    this.worker = new Worker(MAIN, { workerData: { staging, roots, spans, live, platform }, execArgv: [], resourceLimits: { maxYoungGenerationSizeMb: 1 } })
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

  slice(files: string[], budget: number, timeoutMs = Infinity): Promise<BackfillStats | 'timeout' | null> {
    if (this.failed) return Promise.resolve(null)
    return new Promise((resolve) => {
      const timer = Number.isFinite(timeoutMs)
        ? setTimeout(() => {
            this.pending = null
            this.failed = true
            void this.worker.terminate()
            void this.exited.then(() => resolve('timeout'))
          }, timeoutMs)
        : null
      this.pending = {
        resolve: (stats) => {
          if (timer) clearTimeout(timer)
          resolve(stats)
        },
      }
      this.worker.postMessage({ files, budget })
    })
  }

  async close(): Promise<void> {
    if (!this.failed) this.worker.postMessage({ stop: true })
    await this.exited
  }

  async terminate(): Promise<void> {
    this.failed = true
    await this.worker.terminate()
    await this.exited
  }
}

// First reads in progress. A deletion stops them: what they staged before it may be what it deletes.
const running = new Set<() => Promise<void>>()

/** Stops every first read in progress and removes its staging copy; the live reader then reads the logs itself. */
export async function stopBackfills(): Promise<void> {
  await Promise.all([...running].map((stop) => stop()))
}

export async function runChild(staging: string, roots: PlainRoot[], files: string[], budget: number, log: (msg: string) => void, live: string | null = null): Promise<BackfillStats | null> {
  await prepareWorker()
  const worker = new BackfillWorker(staging, roots, log, [], live)
  try {
    const stats = await worker.slice(files, budget)
    return stats === 'timeout' ? null : stats
  }
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

// Merges the staging tables into the live ones, replayed session by session through the same gate as a live read:
// parents first, so a subagent resolves its app and its parent's tombstones through them. Each session lands in its
// own transaction, and capture runs between them; a merge cut short leaves the rest to the live reader, which reads
// logs with no read position whole.
export async function mergeStaging(db: Database.Database, staging: string, policy: Partial<GatePolicy> = {}, stopped: () => boolean = () => false): Promise<void> {
  db.prepare('ATTACH DATABASE ? AS staging').run(staging)
  try {
    // A worker stopped before its tables were set up left nothing to merge; the newest column marks them complete.
    if (db.prepare(`SELECT 1 FROM pragma_table_info('agent_sources', 'staging') WHERE name = 'turnless'`).get() === undefined) return
    const store = Object.assign(new AgentStore(db), policy)
    db.exec(`CREATE INDEX IF NOT EXISTS staging.merge_turns ON agent_turns(agent, session_id, start_wall_ms);
      CREATE INDEX IF NOT EXISTS staging.merge_events ON agent_events(agent, session_id, wall_ms)`)
    const withHosts = db.prepare(`SELECT 1 FROM staging.sqlite_master WHERE type = 'table' AND name = 'agent_hosts'`).get() !== undefined
    const all = db.prepare(`SELECT agent, session_id FROM staging.agent_sessions UNION SELECT agent, session_id FROM staging.agent_turns
      UNION SELECT agent, session_id FROM staging.agent_events UNION SELECT agent, session_id FROM staging.agent_sources WHERE session_id IS NOT NULL
      ${withHosts ? 'UNION SELECT agent, session_id FROM staging.agent_hosts' : ''}`).all() as { agent: Agent; session_id: string }[]
    const parents = new Map((db.prepare('SELECT agent, session_id, parent_session_id AS p FROM staging.agent_sessions WHERE parent_session_id IS NOT NULL').all() as { agent: Agent; session_id: string; p: string }[]).map((x) => [`${x.agent}\n${x.session_id}`, x.p]))
    const depth = (agent: Agent, session: string) => {
      const seen = new Set<string>()
      for (let s: string | undefined = session; s !== undefined && !seen.has(s); s = parents.get(`${agent}\n${s}`)) seen.add(s)
      return seen.size
    }
    const ordered = all.map((x) => ({ ...x, depth: depth(x.agent, x.session_id) })).sort((a, b) => a.depth - b.depth || a.agent.localeCompare(b.agent) || a.session_id.localeCompare(b.session_id))
    const q = {
      session: db.prepare('SELECT * FROM staging.agent_sessions WHERE agent = ? AND session_id = ?'),
      hosts: withHosts ? db.prepare('SELECT app_id, app_name, app_path, basis, from_wall_ms FROM staging.agent_hosts WHERE agent = ? AND session_id = ? ORDER BY from_wall_ms, id') : null,
      turns: db.prepare('SELECT * FROM staging.agent_turns WHERE agent = ? AND session_id = ? ORDER BY start_wall_ms, id'),
      events: db.prepare('SELECT * FROM staging.agent_events WHERE agent = ? AND session_id = ? ORDER BY wall_ms, id'),
      sources: db.prepare('SELECT * FROM staging.agent_sources WHERE agent = ? AND session_id IS ? ORDER BY path'),
    }
    for (const { agent, session_id: session } of ordered) {
      if (stopped()) return
      const records: AgentRecord[] = []
      const s = q.session.get(agent, session) as StagedSession | undefined
      if (s) records.push({ t: 'session', session, origin: s.origin, parent: s.parent_session_id, client: s.client, dir: s.project_dir, branch: s.branch, at: s.first_wall_ms })
      for (const t of q.turns.all(agent, session) as StagedTurn[]) {
        records.push({ t: 'turn', key: t.turn_key, session, dir: t.project_dir, branch: t.branch, opener: t.opened_by, start: t.start_wall_ms, replayed: t.replayed === 1, ...(t.source_session ? { source: t.source_session } : {}) })
        if (t.last_activity_wall_ms > t.start_wall_ms) records.push({ t: 'activity', key: t.turn_key, session, at: t.last_activity_wall_ms })
        if (t.end_state !== null) records.push({ t: 'end', key: t.turn_key, state: t.end_state, at: t.end_wall_ms })
      }
      for (const e of q.events.all(agent, session) as StagedEvent[]) {
        records.push(e.kind === 'user'
          ? { t: 'user', key: e.event_key, session, turn: e.turn_key, act: e.detail as UserAct, basis: e.basis as Basis, at: e.wall_ms, ...(e.source_session ? { source: e.source_session } : {}) }
          : { t: 'wait', key: e.event_key, session, turn: e.turn_key, reason: e.detail as WaitReason, start: e.wall_ms, end: e.end_wall_ms })
      }
      const hosts = ((q.hosts?.all(agent, session) ?? []) as StagedHost[]).map((h) => ({ session, app: h.app_id === null ? null : { app_id: h.app_id, name: h.app_name, path: h.app_path }, basis: h.basis as HostRecordBasis, at: h.from_wall_ms }))
      const sources = (q.sources.all(agent, session) as StagedSource[]).map(sourceUpdate)
      store.apply(agent, records, sources[0], { hosts })
      for (const src of sources.slice(1)) store.apply(agent, [], src)
      await new Promise((resolve) => setImmediate(resolve))
    }
    if (stopped()) return
    for (const agent of ['claude_code', 'codex'] as const) for (const src of q.sources.all(agent, null) as StagedSource[]) store.apply(agent, [], sourceUpdate(src))
  } finally {
    db.exec('DETACH DATABASE staging')
  }
}

interface StagedSession {
  origin: SessionOrigin
  parent_session_id: string | null
  client: string | null
  project_dir: string | null
  branch: string | null
  first_wall_ms: number
}

interface StagedTurn {
  turn_key: string
  project_dir: string | null
  branch: string | null
  opened_by: TurnOpener
  replayed: number
  start_wall_ms: number
  last_activity_wall_ms: number
  end_wall_ms: number | null
  end_state: TurnEndState | null
  source_session: string | null
}

interface StagedEvent {
  event_key: string
  turn_key: string | null
  kind: 'user' | 'wait'
  detail: string
  basis: string | null
  wall_ms: number
  end_wall_ms: number | null
  source_session: string | null
}

interface StagedHost {
  app_id: string | null
  app_name: string | null
  app_path: string | null
  basis: string
  from_wall_ms: number
}

interface StagedSource {
  path: string
  agent: Agent
  root: string
  session_id: string | null
  dev: string | null
  ino: string | null
  offset: number
  size: number
  state: string | null
  turnless: number
  lines: number
  bad_lines: number
  unknown_records: number
}

function sourceUpdate(s: StagedSource): SourceUpdate {
  return {
    path: s.path, agent: s.agent, root: s.root, session: s.session_id, dev: s.dev ?? '', ino: s.ino ?? '', offset: s.offset, size: s.size, state: s.state, turnless: s.turnless === 1,
    counts: { ...emptyCounts(), lines: s.lines, bad: s.bad_lines, unknown: s.unknown_records },
  }
}

export async function backfill(
  db: Database.Database,
  dataDir: string,
  roots: PlainRoot[],
  log: (msg: string) => void,
  sliceBytes = SLICE_BYTES,
  sliceTimeoutMs = SLICE_TIMEOUT_MS,
  policy: Partial<GatePolicy> = {},
  platform: NodeJS.Platform = process.platform,
): Promise<BackfillResult> {
  const staging = path.join(dataDir, STAGING_FILE)
  const clean = () => removeStaging(dataDir)
  clean()
  const filesToRead = await listLogs(roots)
  if (filesToRead.length === 0) return { merged: true, children: 0, slices: 0, max_slice_bytes: 0, child: null, merge_ms: 0, peaks_mb: [] }
  loadFingerprintKey(dataDir)
  await prepareWorker()
  const worker = new BackfillWorker(staging, roots, log, policy.withheld?.() ?? [], db.name && db.name !== ':memory:' ? db.name : null, platform)
  let stopped = false
  let cleaned!: () => void
  const done = new Promise<void>((resolve) => (cleaned = resolve))
  const stop = async () => {
    stopped = true
    await worker.terminate()
    await done
  }
  running.add(stop)
  const unmerged: BackfillResult = { merged: false, children: 0, slices: 0, max_slice_bytes: 0, child: null, merge_ms: 0, peaks_mb: [] }
  try {
    let files = filesToRead
    const total: BackfillStats = { wall_ms: 0, cpu_ms: 0, peak_rss_mb: 0, files_read: 0, mb_read: 0, lines: 0, records: 0 }
    const counts = new Map<string, RootCounts>()
    const peaks: number[] = []
    let maxSlice = 0
    for (let remaining = files.length > 0; remaining; ) {
      const child = await worker.slice(files, sliceBytes, sliceTimeoutMs)
      if (stopped) {
        log('agent backfill stopped by a deletion; live reader takes over')
        return unmerged
      }
      if (child === 'timeout') {
        log(`agent backfill slice exceeded ${sliceTimeoutMs} ms; live reader takes over remaining logs`)
        break
      }
      if (!child) return unmerged
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
    await mergeStaging(db, staging, policy, () => stopped)
    if (stopped) {
      log('agent backfill stopped by a deletion; live reader takes over')
      return unmerged
    }
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
    running.delete(stop)
    cleaned()
  }
}
