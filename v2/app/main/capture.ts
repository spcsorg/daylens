// Runs the capture service (capture, normalization and storage: the only writer) as an Electron utility process, sends
// it control lines as messages and reads its stdout. Restarts it if it stops on its own. Packaged builds turn off
// Electron's run-as-Node mode, so the service can't be a plain child process.
import { utilityProcess, type UtilityProcess } from 'electron'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { APP_CAPTURE_FLAGS } from '../../capture/appFlags.ts'

export interface CaptureOptions {
  service: string
  helper: string
  dataDir: string
  // Where V1 kept its settings; a new store starts with V1's pause and exclusions from there.
  v1AppData?: string
  log: (line: string) => void
}

export interface HelperStatus {
  running: boolean
  accessibility: string | null
  titles: string | null
}

type Reply = { op: 'reply'; id: string; ok: boolean; result?: unknown; error?: string }

const RESTART_MS = [500, 2000, 5000, 15000, 30000]

export class Capture extends EventEmitter {
  state: 'starting' | 'running' | 'stopped' | 'failed' = 'stopped'
  error: string | null = null
  helper: HelperStatus = { running: false, accessibility: null, titles: null }
  private child: UtilityProcess | null = null
  private readonly o: CaptureOptions
  private nextId = 1
  private readonly pending = new Map<string, { resolve: (r: Reply) => void; timer: ReturnType<typeof setTimeout> }>()
  private readonly deletions = new Map<string, (state: string) => void>()
  private stopping = false
  private failures = 0
  private startedAt = 0

  constructor(o: CaptureOptions) {
    super()
    this.o = o
  }

  start(): void {
    this.stopping = false
    this.state = 'starting'
    this.emit('state')
    this.startedAt = Date.now()
    const child = utilityProcess.fork(this.o.service, ['--helper', this.o.helper, '--data-dir', this.o.dataDir, ...APP_CAPTURE_FLAGS, ...(this.o.v1AppData ? ['--v1-app-data', this.o.v1AppData] : [])], {
      serviceName: 'Daylens Capture',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    createInterface({ input: child.stdout! }).on('line', (line) => this.onLine(line))
    createInterface({ input: child.stderr! }).on('line', (line) => {
      this.o.log(line)
      if (line.includes('another capture service is writing')) this.error = 'another_writer'
      if (line.includes('[capture] started')) {
        this.state = 'running'
        this.failures = 0
        this.emit('state')
      }
    })
    child.on('exit', (code) => this.onExit(child, code))
    child.on('error', (type) => {
      this.o.log(`capture process error type=${type}`)
    })
  }

  private onLine(line: string): void {
    let msg: { op?: string; id?: string; state?: string } & Record<string, unknown>
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.op === 'reply' && typeof msg.id === 'string') {
      const p = this.pending.get(msg.id)
      if (!p) return
      clearTimeout(p.timer)
      this.pending.delete(msg.id)
      p.resolve(msg as Reply)
    } else if (msg.op === 'deletion' && typeof msg.id === 'string') {
      this.deletions.get(msg.id)?.(String(msg.state))
      if (msg.state !== 'done') this.deletions.delete(msg.id)
    } else if (msg.op === 'helper_status') {
      this.helper = { running: Boolean(msg.running), accessibility: (msg.accessibility as string) ?? null, titles: (msg.titles as string) ?? null }
      this.emit('helper')
    } else if (msg.op === 'activity') {
      this.emit('activity')
    } else if (msg.op === 'capture_health') {
      this.emit('health', msg.store)
    }
  }

  private onExit(child: UtilityProcess, code: number): void {
    if (this.child !== child) return
    this.child = null
    this.helper = { running: false, accessibility: null, titles: null }
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.resolve({ op: 'reply', id, ok: false, error: 'capture_stopped' })
    }
    this.pending.clear()
    if (this.stopping) {
      this.state = 'stopped'
      this.emit('state')
      return
    }
    this.o.log(`capture exited code=${code}`)
    this.state = 'failed'
    this.emit('state')
    this.emit('helper')
    if (Date.now() - this.startedAt > 60_000) this.failures = 0
    const wait = RESTART_MS[Math.min(this.failures++, RESTART_MS.length - 1)]!
    setTimeout(() => {
      if (!this.stopping && !this.child) this.start()
    }, wait)
  }

  /** Sends one control op and waits for its reply. */
  request(op: Record<string, unknown>, onDeletion?: (state: string) => void): Promise<Reply> {
    const child = this.child
    if (!child) return Promise.resolve({ op: 'reply', id: '', ok: false, error: 'capture_stopped' })
    const id = String(this.nextId++)
    if (onDeletion) this.deletions.set(id, onDeletion)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ op: 'reply', id, ok: false, error: 'timeout' })
      }, 10_000)
      this.pending.set(id, { resolve, timer })
      child.postMessage(JSON.stringify({ ...op, id }))
    })
  }

  restart(): void {
    if (this.child) {
      void this.stop().then(() => this.start())
    } else this.start()
  }

  /** The stop op stops the service cleanly; it ends its gaps and closes the database. */
  stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    if (!child) return Promise.resolve()
    return new Promise((resolve) => {
      const kill = setTimeout(() => {
        if (child.pid) process.kill(child.pid, 'SIGKILL')
      }, 5000)
      child.once('exit', () => {
        clearTimeout(kill)
        resolve()
      })
      child.postMessage(JSON.stringify({ op: 'stop' }))
    })
  }
}
