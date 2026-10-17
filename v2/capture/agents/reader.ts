// Watches the Claude Code and Codex log folders and reads only what was appended since the last read.
// File events drive reading; a slow check compares file sizes with the stored read positions for events a watcher missed.

import { existsSync, watch, type FSWatcher } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { ClaudeParser } from './claude.ts'
import { CodexParser } from './codex.ts'
import { readAppended, readCompressed } from './tail.ts'
import type { AgentStore, HealthState, SourceRow } from './store.ts'
import { emptyCounts, type Agent, type AgentRecord, type LineParser, type ParseCounts } from './types.ts'

export type Layout = 'claude' | 'codex_sessions' | 'codex_archive'

export interface AgentRoot {
  agent: Agent
  dir: string
  layout: Layout
  // Folders where file events cannot be had (a WSL distribution over its network share) are checked on the reconcile timer.
  poll?: boolean
  // Checked before every access; false means the folder must not be touched now (a stopped WSL distribution).
  available?: () => boolean
}

export function homeRoots(home: string, env: NodeJS.ProcessEnv = process.env): AgentRoot[] {
  const claude = env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude')
  const codex = env.CODEX_HOME ?? path.join(home, '.codex')
  return [
    { agent: 'claude_code', dir: path.join(claude, 'projects'), layout: 'claude' },
    { agent: 'codex', dir: path.join(codex, 'sessions'), layout: 'codex_sessions' },
    { agent: 'codex', dir: path.join(codex, 'archived_sessions'), layout: 'codex_archive' },
  ]
}

interface FileInfo {
  session: string
  parent: string | null
  compressed: boolean
}

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/

export function classifyFile(root: AgentRoot, file: string): FileInfo | null {
  const rel = path.relative(root.dir, file)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  const parts = rel.split(/[\\/]+/)
  const name = parts[parts.length - 1]!
  if (root.layout === 'claude') {
    if (!name.endsWith('.jsonl')) return null
    if (parts.length === 2) return { session: name.slice(0, -6), parent: null, compressed: false }
    if (parts.length === 4 && parts[2] === 'subagents') return { session: name.slice(0, -6), parent: parts[1]!, compressed: false }
    return null
  }
  if (!name.startsWith('rollout-')) return null
  const compressed = name.endsWith('.jsonl.zst')
  if (!name.endsWith('.jsonl') && !(compressed && root.layout === 'codex_archive')) return null
  const id = UUID.exec(name)?.[1] ?? name.replace(/\.jsonl(\.zst)?$/, '')
  return { session: id, parent: null, compressed }
}

function makeParser(root: AgentRoot, info: FileInfo, saved: string | null): LineParser {
  return root.agent === 'claude_code' ? new ClaudeParser(info.session, info.parent, saved) : new CodexParser(info.session, saved)
}

export interface ReaderOptions {
  reconcileMs?: number
  // File events arriving together are read together: a busy log is read at most this often.
  coalesceMs?: number
  log?: (msg: string) => void
  // Folders that can appear later (WSL distributions that start), asked for on the reconcile timer.
  discover?: () => Promise<AgentRoot[]>
  // Reads the whole history of unguarded folders elsewhere and merges it, the first time this database sees agent logs.
  backfill?: (roots: Omit<AgentRoot, 'available'>[]) => Promise<boolean>
}

export interface ReaderStats {
  filesRead: number
  bytesRead: number
  lines: number
  records: number
}

interface RootState {
  root: AgentRoot
  watcher: FSWatcher | null
  present: boolean
  polling: boolean
  counts: ParseCounts
  unreadable: boolean
}

const FLUSH_RECORDS = 2000

function errCode(err: unknown): string {
  const c = (err as { code?: unknown })?.code
  return typeof c === 'string' ? c : 'unknown'
}

export class AgentReader {
  readonly stats: ReaderStats = { filesRead: 0, bytesRead: 0, lines: 0, records: 0 }
  private readonly store: AgentStore
  private readonly roots: RootState[]
  private readonly reconcileMs: number
  private readonly coalesceMs: number
  private readonly log: (msg: string) => void
  private readonly discover: (() => Promise<AgentRoot[]>) | null
  private readonly backfill: ReaderOptions['backfill'] | null
  private readonly dirty = new Map<string, RootState>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private reconcileTimer: ReturnType<typeof setInterval> | null = null
  private draining: Promise<void> | null = null
  private stopped = false

  constructor(store: AgentStore, roots: AgentRoot[], opts: ReaderOptions = {}) {
    this.store = store
    this.roots = roots.map((root) => ({ root, watcher: null, present: false, polling: root.poll === true, counts: emptyCounts(), unreadable: false }))
    this.reconcileMs = opts.reconcileMs ?? 60_000
    this.coalesceMs = opts.coalesceMs ?? 1000
    this.log = opts.log ?? (() => {})
    this.discover = opts.discover ?? null
    this.backfill = opts.backfill ?? null
  }

  private async discoverRoots(): Promise<void> {
    if (!this.discover) return
    let found: AgentRoot[] = []
    try {
      found = await this.discover()
    } catch (err) {
      this.log(`agent discovery failed code=${errCode(err)}`)
    }
    for (const root of found) {
      if (this.roots.some((r) => r.root.dir === root.dir)) continue
      this.roots.push({ root, watcher: null, present: false, polling: root.poll === true, counts: emptyCounts(), unreadable: false })
    }
  }

  async start(): Promise<void> {
    await this.discoverRoots()
    if (this.backfill && !this.store.hasSources()) {
      const plain = this.roots.filter((r) => !r.root.available).map(({ root }) => ({ agent: root.agent, dir: root.dir, layout: root.layout, ...(root.poll ? { poll: true } : {}) }))
      if (plain.length > 0 && !(await this.backfill(plain))) this.log('agent backfill unavailable; reading history in this process')
    }
    for (const r of this.roots) await this.reconcile(r)
    await this.drain()
    this.reconcileTimer = setInterval(() => void this.tick(), this.reconcileMs)
    this.reconcileTimer.unref()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    if (this.reconcileTimer) clearInterval(this.reconcileTimer)
    for (const r of this.roots) r.watcher?.close()
    await this.draining
  }

  // Resolves once every file event seen so far has been read and written.
  async settle(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    while (this.dirty.size > 0 || this.draining) await this.drain()
  }

  // The slow check for missed file events: sizes are compared with the stored read positions, and only a file that
  // grew or appeared is read. Folders without file events (WSL) rely on it entirely.
  private async tick(): Promise<void> {
    await this.discoverRoots()
    for (const r of this.roots) await this.reconcile(r)
    await this.drain()
  }

  private async reconcile(r: RootState): Promise<void> {
    const { root } = r
    if (root.available && !root.available()) return
    let names: string[]
    try {
      names = (await readdir(root.dir, { recursive: root.layout !== 'codex_archive' })) as string[]
    } catch (err) {
      const code = errCode(err)
      r.present = false
      r.watcher?.close()
      r.watcher = null
      if (code === 'ENOENT' || code === 'ENOTDIR') this.store.setHealth(root.agent, root.dir, 'not_found', null, null)
      else this.store.setHealth(root.agent, root.dir, 'unreadable', code, null)
      return
    }
    const appeared = !r.present
    r.present = true
    // A folder that is back is readable again; a format problem stays reported until a clean read clears it.
    if (appeared) {
      const prev = this.store.healthFor(root.agent, root.dir)
      if (!prev || prev.state === 'not_found' || prev.state === 'unreadable') this.store.setHealth(root.agent, root.dir, 'ok', null, null)
    }
    if (!r.polling && r.watcher === null) this.watch(r)
    const known = new Map(this.store.sourcesUnder(root.dir).map((s) => [s.path, s]))
    for (const name of names) {
      const file = path.join(root.dir, name)
      if (!classifyFile(root, file)) continue
      const row = known.get(file)
      if (appeared || !row) this.dirty.set(file, r)
      else {
        try {
          const st = await stat(file)
          if (st.size !== row.size) this.dirty.set(file, r)
        } catch {}
      }
    }
  }

  private watch(r: RootState): void {
    try {
      r.watcher = watch(r.root.dir, { recursive: r.root.layout !== 'codex_archive', persistent: false }, (_event, name) => {
        if (this.stopped || !name) return
        const file = path.join(r.root.dir, name.toString())
        if (!classifyFile(r.root, file)) return
        this.dirty.set(file, r)
        this.schedule()
      })
      r.watcher.on('error', (err) => {
        // The folder went away or events stopped; the reconcile timer takes over until it can be watched again.
        r.watcher?.close()
        r.watcher = null
        this.store.setHealth(r.root.agent, r.root.dir, 'degraded', 'watch_failed', { code: errCode(err) })
        this.log(`agent watch failed agent=${r.root.agent} code=${errCode(err)}`)
      })
    } catch (err) {
      r.watcher = null
      r.polling = true
      this.log(`agent watch unavailable agent=${r.root.agent} code=${errCode(err)}`)
    }
  }

  private schedule(): void {
    if (this.timer || this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.drain()
    }, this.coalesceMs)
  }

  private drain(): Promise<void> {
    if (this.draining) return this.draining
    // Cleared after the promise is stored: with nothing to read, the loop finishes before this method returns.
    const p = this.drainLoop().finally(() => {
      if (this.draining === p) this.draining = null
    })
    this.draining = p
    return p
  }

  private async drainLoop(): Promise<void> {
    while (this.dirty.size > 0 && !this.stopped) {
      const batch = [...this.dirty]
      this.dirty.clear()
      for (const [file, r] of batch) {
        if (this.stopped) break
        await this.readFile(r, file)
      }
    }
    for (const r of this.roots) this.recordHealth(r)
  }

  private recordHealth(r: RootState): void {
    const c = r.counts
    if (r.unreadable) {
      this.store.setHealth(r.root.agent, r.root.dir, 'unreadable', 'file_unreadable', null)
      r.unreadable = false
      return
    }
    if (c.lines === 0) return
    r.counts = emptyCounts()
    let state: HealthState = 'ok'
    let reason: string | null = null
    if (c.bad > 0) {
      state = 'degraded'
      reason = 'unreadable_lines'
    } else if (c.recognized === 0) {
      state = 'degraded'
      reason = 'unrecognized_format'
    }
    this.store.setHealth(r.root.agent, r.root.dir, state, reason, state === 'ok' ? null : { lines: c.lines, bad: c.bad, unknown: c.unknown, recognized: c.recognized })
  }

  private async readFile(r: RootState, file: string): Promise<void> {
    const { root } = r
    if (root.available && !root.available()) return
    const info = classifyFile(root, file)
    if (!info) return
    let st
    try {
      st = await stat(file)
    } catch (err) {
      if (errCode(err) !== 'ENOENT') r.unreadable = true
      return
    }
    if (!st.isFile()) return
    const dev = String(st.dev)
    const ino = String(st.ino)
    let row: SourceRow | null = this.store.source(file)
    if (!row) {
      // A rename (Codex archiving a session) keeps the file's identity; the read position moves with it.
      const moved = this.store.sourcesByInode(dev, ino).find((s) => s.path !== file && !existsSync(s.path))
      if (moved) {
        this.store.movedSource(moved.path, file)
        row = { ...moved, path: file }
      } else if (info.compressed) {
        const done = this.store.sourcesForSession(root.agent, info.session).find((s) => s.path !== file && !existsSync(s.path) && s.offset >= s.size)
        if (done) {
          this.store.markRead({ path: file, agent: root.agent, root: root.dir, session: info.session, dev, ino, offset: st.size, size: st.size, state: done.state })
          return
        }
      }
    }
    // A different file at the same path, or one that shrank, was rewritten: read it again; duplicates are ignored.
    if (row && (row.dev !== dev || row.ino !== ino || st.size < row.offset)) row = null
    const from = row?.offset ?? 0
    if (from >= st.size) return
    // A compressed archive is always read from its start, so it never resumes from a saved mid-file state.
    const parser = makeParser(root, info, info.compressed ? null : (row?.state ?? null))
    let records: AgentRecord[] = []
    let flushed = emptyCounts()
    const flush = (offset: number) => {
      const c = parser.counts
      const delta: ParseCounts = { lines: c.lines - flushed.lines, bad: c.bad - flushed.bad, unknown: c.unknown - flushed.unknown, recognized: c.recognized - flushed.recognized }
      flushed = { ...c }
      this.store.apply(root.agent, records, { path: file, agent: root.agent, root: root.dir, session: info.session, dev, ino, offset, size: st.size, state: parser.state(), counts: delta })
      this.stats.records += records.length
      records = []
      r.counts.lines += delta.lines
      r.counts.bad += delta.bad
      r.counts.unknown += delta.unknown
      r.counts.recognized += delta.recognized
    }
    const sink = (text: string | null, head: string, tail: string) => {
      for (const rec of parser.line(text, head, tail)) records.push(rec)
    }
    try {
      if (info.compressed) {
        const bytes = await readCompressed(file, sink, () => {
          if (records.length >= FLUSH_RECORDS) flush(0)
        })
        flush(st.size)
        this.stats.bytesRead += bytes
      } else {
        const res = await readAppended(file, from, st.size, sink, (offset) => {
          if (records.length >= FLUSH_RECORDS) flush(offset)
        })
        flush(res.next)
        this.stats.bytesRead += res.bytes
      }
      this.stats.filesRead++
      this.stats.lines += parser.counts.lines
    } catch (err) {
      const code = errCode(err)
      if (code !== 'ENOENT') r.unreadable = true
      this.log(`agent read failed agent=${root.agent} code=${code}`)
    }
  }
}
