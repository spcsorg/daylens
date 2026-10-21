// Watches the Claude Code and Codex log folders and reads only what was appended since the last read.
// File events drive reading; a slow check compares file sizes with the stored read positions for events a watcher missed.

import { existsSync, watch, type FSWatcher } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { ClaudeParser } from './claude.ts'
import { CodexParser } from './codex.ts'
import type { HostFinding } from './host.ts'
import { readAppended, CompressedTail, AppendedTail } from './tail.ts'
import type { AgentStore, HealthState, SourceRow } from './store.ts'
import { addCounts, emptyCounts, subCounts, type Agent, type AgentRecord, type LineParser, type ParseCounts } from './types.ts'

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

function makeParser(root: AgentRoot, info: FileInfo, saved: string | null, key: Buffer): LineParser {
  return root.agent === 'claude_code' ? new ClaudeParser(info.session, info.parent, saved, key) : new CodexParser(info.session, saved, key)
}

export interface ReaderOptions {
  // How often folders without working file events (missing, polled, or a watcher that failed) are looked at.
  reconcileMs?: number
  // One check of watched folders this long after start: a file watcher can miss writes made while it is starting.
  followUpMs?: number
  // File events arriving together are read together: a busy log is read at most this often.
  coalesceMs?: number
  log?: (msg: string) => void
  // Folders that can appear later (WSL distributions that start), asked for on the reconcile timer.
  discover?: () => Promise<AgentRoot[]>
  // Reads the whole history of unguarded folders elsewhere and merges it, the first time this database sees agent logs.
  backfill?: (roots: Omit<AgentRoot, 'available'>[]) => Promise<boolean>
  // False when health is decided by the caller from the counts of several readers (the backfill children).
  recordHealth?: boolean
  // The app a running session is in, for logs read live; null when the session's process cannot be found.
  resolveHost?: (agent: Agent, session: string, file: string) => Promise<HostFinding | null>
}

export interface RootCounts {
  agent: Agent
  dir: string
  counts: ParseCounts
  unreadable: boolean
}

// What a batch of reads says about a folder: degraded on unreadable lines, nothing understood, or drift in any of its files.
export function healthFromCounts(c: ParseCounts, turnlessFile = false): { state: HealthState; reason: string | null; detail: Record<string, number> | null } {
  const reason = c.bad > 0 ? 'unreadable_lines' : c.recognized === 0 ? 'unrecognized_format' : turnlessFile ? 'turns_unrecognized' : null
  return reason === null ? { state: 'ok', reason, detail: null } : { state: 'degraded', reason, detail: { ...c } }
}

export interface ReaderStats {
  // Folder listings: once per folder at start, then only for folders without working file events.
  listings: number
  // New folders under a watched root, each listed once when its event arrives.
  dirScans: number
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

async function endsWithNewline(file: string, size: number): Promise<boolean> {
  const fh = await open(file, 'r')
  try {
    const b = Buffer.alloc(1)
    return (await fh.read(b, 0, 1, size - 1)).bytesRead === 1 && b[0] === 0x0a
  } finally {
    await fh.close()
  }
}

function errCode(err: unknown): string {
  const c = (err as { code?: unknown })?.code
  return typeof c === 'string' ? c : 'unknown'
}

export class AgentReader {
  readonly stats: ReaderStats = { listings: 0, dirScans: 0, filesRead: 0, bytesRead: 0, lines: 0, records: 0 }
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
  private followUpTimer: ReturnType<typeof setTimeout> | null = null
  private readonly followUpMs: number
  private draining: Promise<void> | null = null
  private stopped = false

  constructor(store: AgentStore, roots: AgentRoot[], opts: ReaderOptions = {}) {
    this.store = store
    this.roots = roots.map((root) => ({ root, watcher: null, present: false, polling: root.poll === true, counts: emptyCounts(), unreadable: false }))
    this.reconcileMs = opts.reconcileMs ?? 60_000
    this.followUpMs = opts.followUpMs ?? 5_000
    this.coalesceMs = opts.coalesceMs ?? 1000
    this.log = opts.log ?? (() => {})
    this.discover = opts.discover ?? null
    this.backfill = opts.backfill ?? null
    this.healthOn = opts.recordHealth ?? true
    this.resolveHost = opts.resolveHost ?? null
  }

  private readonly resolveHost: ReaderOptions['resolveHost'] | null
  // When a session's process was last looked for and not found; looked for again after a reconcile interval.
  private readonly hostMisses = new Map<string, number>()

  private async traceHost(agent: Agent, session: string, file: string, from: number): Promise<void> {
    if (!this.resolveHost) return
    const missed = this.hostMisses.get(file)
    if (missed !== undefined && Date.now() - missed < this.reconcileMs) return
    const found = await this.resolveHost(agent, session, file)
    if (!found) {
      this.hostMisses.set(file, Date.now())
      return
    }
    this.hostMisses.delete(file)
    this.store.recordHost(agent, session, found.app, found.basis, from)
  }

  private readonly healthOn: boolean

  private budget: number | null = null
  private budgetStart = 0
  private readonly tails = new Map<string, CompressedTail | AppendedTail>()
  private leftOver = false
  readonly deferredFiles: string[] = []
  progressed = false

  // Archive decoder and partial-line state stay in this reader between bounded slices.
  async readOnly(files: readonly string[], budget: number): Promise<boolean> {
    this.budget = budget
    this.budgetStart = budget
    this.leftOver = false
    this.deferredFiles.length = 0
    this.progressed = false
    for (const file of files) {
      const r = this.roots.find((x) => classifyFile(x.root, file) !== null)
      if (r) this.dirty.set(file, r)
    }
    await this.drain()
    this.budget = null
    return this.leftOver
  }

  rootCounts(): RootCounts[] {
    return this.roots.map((r) => ({ agent: r.root.agent, dir: r.root.dir, counts: { ...r.counts }, unreadable: r.unreadable }))
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

  // A stop() while any step here is awaited wins: nothing is listed, watched or scheduled after it.
  async start(): Promise<void> {
    await this.discoverRoots()
    if (this.stopped) return
    if (this.backfill && !this.store.hasSources()) {
      const plain = this.roots.filter((r) => !r.root.available).map(({ root }) => ({ agent: root.agent, dir: root.dir, layout: root.layout, ...(root.poll ? { poll: true } : {}) }))
      let merged = false
      try {
        merged = plain.length > 0 && (await this.backfill(plain))
      } catch (err) {
        this.log(`agent backfill failed code=${errCode(err)}`)
      }
      if (plain.length > 0 && !merged) this.log('agent backfill unavailable; reading history in this process')
    }
    for (const r of this.roots) await this.reconcile(r)
    await this.drain()
    if (this.stopped) return
    this.reconcileTimer = setInterval(() => void this.tick(), this.reconcileMs)
    this.reconcileTimer.unref()
    this.followUpTimer = setTimeout(() => void this.followUp(), this.followUpMs)
    this.followUpTimer.unref()
  }

  private async followUp(): Promise<void> {
    for (const r of this.roots) if (r.present && r.watcher !== null) await this.reconcile(r)
    await this.drain()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    if (this.reconcileTimer) clearInterval(this.reconcileTimer)
    if (this.followUpTimer) clearTimeout(this.followUpTimer)
    for (const r of this.roots) r.watcher?.close()
    await this.draining
    for (const tail of this.tails.values()) tail.close()
    this.tails.clear()
  }

  // Resolves once every file event seen so far has been read and written.
  async settle(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    while (this.dirty.size > 0 || this.draining) await this.drain()
  }

  // Watched folders are never listed again; only folders without working file events are, and only a file that
  // appeared or whose size differs from its stored read position is read.
  private async tick(): Promise<void> {
    await this.discoverRoots()
    for (const r of this.roots) if (!r.present || r.polling || r.watcher === null) await this.reconcile(r)
    await this.drain()
  }

  private async reconcile(r: RootState): Promise<void> {
    const { root } = r
    if (this.stopped || (root.available && !root.available())) return
    // Watching starts before listing, so nothing written in between is missed.
    if (!r.polling && r.watcher === null) this.watch(r)
    let names: string[]
    try {
      names = (await readdir(root.dir, { recursive: root.layout !== 'codex_archive' })) as string[]
      this.stats.listings++
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
        if (!classifyFile(r.root, file)) {
          void this.scanDir(r, file)
          return
        }
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
      // A folder that does not exist yet is looked for on the reconcile timer; one that cannot be watched is polled.
      if (errCode(err) === 'ENOENT') return
      r.polling = true
      this.log(`agent watch unavailable agent=${r.root.agent} code=${errCode(err)}`)
    }
  }

  // A folder that appears under a watched root (a project folder moved or copied in) is listed once, by itself; its logs
  // were written before the watcher could see them.
  private async scanDir(r: RootState, dir: string): Promise<void> {
    if (r.root.layout === 'codex_archive' || this.stopped) return
    let names: string[]
    try {
      if (!(await stat(dir)).isDirectory()) return
      names = (await readdir(dir, { recursive: true })) as string[]
    } catch {
      return
    }
    this.stats.dirScans++
    let found = false
    for (const name of names) {
      const file = path.join(dir, name)
      if (!classifyFile(r.root, file)) continue
      this.dirty.set(file, r)
      found = true
    }
    if (found) this.schedule()
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
    if (!this.healthOn) return
    const c = r.counts
    if (r.unreadable) {
      this.store.setHealth(r.root.agent, r.root.dir, 'unreadable', 'file_unreadable', null)
      r.unreadable = false
      return
    }
    if (c.lines === 0) return
    r.counts = emptyCounts()
    const h = healthFromCounts(c, this.store.hasTurnlessSource(r.root.dir))
    this.store.setHealth(r.root.agent, r.root.dir, h.state, h.reason, h.detail)
  }

  private async readFile(r: RootState, file: string): Promise<void> {
    const { root } = r
    if (root.available && !root.available()) return
    const info = classifyFile(root, file)
    if (!info) return
    // Nothing of a deleted session is read again, nor its log's position kept.
    if (this.store.isDeletedSession(root.agent, info.session)) return
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
      // A rename (Codex archiving a session) keeps inode and session, so the read position moves; inodes alone get reused.
      const moved = this.store.sourcesByInode(dev, ino).find((s) => s.path !== file && s.session_id === info.session && !existsSync(s.path))
      if (moved) {
        this.store.movedSource(moved.path, file)
        row = { ...moved, path: file }
      } else if (info.compressed) {
        const done = this.store.sourcesForSession(root.agent, info.session).find((s) => s.path !== file && !existsSync(s.path) && s.offset >= s.size)
        if (done) {
          this.store.markRead({ path: file, agent: root.agent, root: root.dir, session: info.session, dev, ino, offset: st.size, size: st.size, state: done.state, turnless: done.turnless === 1 })
          return
        }
      }
    }
    // A different file at the same path, or one that shrank, was rewritten: read it again; duplicates are ignored.
    if (row && (row.dev !== dev || row.ino !== ino || st.size < row.size || (info.compressed && st.size !== row.size))) {
      row = null
      this.tails.get(file)?.close()
      this.tails.delete(file)
    }
    const from = row?.offset ?? 0
    if (from >= st.size) return
    if (this.budget !== null && this.budget <= 0) {
      this.leftOver = true
      return
    }
    // A log read as it is written belongs to a running session: the app it runs in covers what was appended since
    // the last read, or the whole log the first time it is seen.
    if (this.budget === null && !info.compressed) await this.traceHost(root.agent, info.session, file, row ? (this.store.sourceUpdatedAt(file) ?? st.mtimeMs) : 0)
    const saved = info.compressed && !this.tails.has(file) ? null : (row?.state ?? null)
    const parser = makeParser(root, info, saved, this.store.fingerprintKey())
    const prior = row?.state ? (JSON.parse(row.state) as { _readCounts?: ParseCounts; _drift?: number }) : null
    const priorCounts: ParseCounts = prior?._readCounts ?? emptyCounts()
    // Agent output since the file's last recognized turn start; rows written before this was kept fall back to lifetime counts.
    let drift = saved === null ? 0 : (prior?._drift ?? (priorCounts.orphan > 0 && priorCounts.turns === 0 ? priorCounts.orphan : 0))
    let records: AgentRecord[] = []
    let flushed = emptyCounts()
    const flush = (offset: number) => {
      const c = parser.counts
      const delta = subCounts(c, flushed)
      flushed = { ...c }
      this.store.apply(root.agent, records, { path: file, agent: root.agent, root: root.dir, session: info.session, dev, ino, offset, size: st.size, state: JSON.stringify({ ...JSON.parse(parser.state()), _readCounts: addCounts(priorCounts, c), _drift: drift }), turnless: drift > 0, counts: delta })
      this.stats.records += records.length
      records = []
      r.counts = addCounts(r.counts, delta)
    }
    const sink = (text: (() => string | null) | null, head: string, tail: string) => {
      const turns = parser.counts.turns
      const orphan = parser.counts.orphan
      for (const rec of parser.line(text, head, tail)) records.push(rec)
      drift = parser.counts.turns > turns ? 0 : drift + parser.counts.orphan - orphan
    }
    try {
      if (info.compressed) {
        let archive = this.tails.get(file)
        if (!archive) {
          archive = new CompressedTail(file)
          this.tails.set(file, archive)
        }
        const res = await archive.read(sink, () => {
          if (records.length >= FLUSH_RECORDS) flush(0)
        }, this.budget ?? Infinity)
        flush(res.done ? st.size : 0)
        if (res.bytes > 0 || res.done) this.progressed = true
        this.stats.bytesRead += res.bytes
        if (res.done) this.tails.delete(file)
        if (this.budget !== null) {
          this.budget -= res.bytes
          if (!res.done) this.leftOver = true
        }
      } else {
        const hadTail = this.tails.has(file)
        let res
        const checkpoint = (offset: number) => { if (records.length >= FLUSH_RECORDS) flush(offset) }
        if (this.budget === null) {
          res = await readAppended(file, from, st.size, sink, checkpoint)
        } else {
          let tail = this.tails.get(file)
          if (!tail) {
            tail = new AppendedTail(file, from, st.size)
            this.tails.set(file, tail)
          }
          res = await tail.read(sink, checkpoint, this.budget)
          if (res.done) this.tails.delete(file)
          if (!hadTail && !res.done && res.next === from && this.budget === this.budgetStart) {
            // A file ending in a newline has no unfinished line, so this one is complete and keeps being read in slices.
            if (await endsWithNewline(file, st.size)) this.progressed = true
            else this.deferredFiles.push(file)
          }
        }
        flush(res.next)
        if (res.next > from || (hadTail && res.bytes > 0)) this.progressed = true
        this.stats.bytesRead += res.bytes
        if (this.budget !== null) {
          this.budget -= res.bytes
          // An unfinished EOF line waits for its writer, not another backfill slice.
          if (('done' in res ? res.done : res.bytes >= st.size - from) && res.next < st.size) this.deferredFiles.push(file)
          if (('done' in res ? !res.done : res.bytes < st.size - from) && res.next < st.size) this.leftOver = true
        }
      }
      this.stats.filesRead++
      this.stats.lines += parser.counts.lines
    } catch (err) {
      this.tails.get(file)?.close()
      this.tails.delete(file)
      const code = errCode(err)
      if (code !== 'ENOENT') r.unreadable = true
      this.log(`agent read failed agent=${root.agent} code=${code}`)
    }
  }
}
