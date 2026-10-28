// The interface's reader, an Electron utility process. It opens the database read-only, answers the screens over a
// MessagePort the main process hands it, and follows the change log so screens refresh when shared state changes.
import type Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { MessagePortMain } from 'electron'
import { DB_FILE } from '../../capture/store.ts'
import { openReadOnly, Reader as RetrievalReader } from '../../retrieval/reader.ts'
import { ChangeWatcher } from '../../storage/changes.ts'
import type { Query, ReaderEvent } from '../shared/types.ts'
import { apps } from './apps.ts'
import { Reader, type Handlers, type Sources } from './queries.ts'
import { search } from './search.ts'
import { settings } from './settings.ts'
import { today } from './today.ts'

type Init = { type: 'init'; dataDir: string }
type Parent = Init | { type: 'activity' } | { type: 'port' }

let reader: Reader | null = null
let finder: RetrievalReader | null = null
let db: Database.Database | null = null
let watcher: ChangeWatcher | null = null
const ports = new Set<MessagePortMain>()
const waiting: (() => void)[] = []

function broadcast(e: ReaderEvent): void {
  for (const p of ports) p.postMessage(e)
}

const core: Handlers<Extract<Query, { q: 'day' | 'recorded_days' | 'recording' | 'app_path' }>> = {
  day: ({ record }, q) => record.day(q.date),
  recorded_days: ({ record }, q) => record.recordedDays(q.month),
  recording: ({ record }) => record.recording(),
  app_path: ({ record }, q) => record.appPath(q.id),
}

const handlers: Handlers<Query> = { ...core, ...today, ...apps, ...search, ...settings }

function ready(): Promise<void> {
  return reader ? Promise.resolve() : new Promise((resolve) => waiting.push(resolve))
}

// The capture service creates and migrates the database; until it has, try again, more slowly each time.
function open(dataDir: string, waitMs = 50): void {
  const file = path.join(dataDir, DB_FILE)
  const retry = () => setTimeout(() => open(dataDir, Math.min(waitMs * 2, 2000)), waitMs)
  if (!existsSync(file)) return void retry()
  try {
    db = openReadOnly(file)
    db.pragma('query_only = ON')
  } catch {
    db = null
    return void retry()
  }
  reader = new Reader(db)
  finder = new RetrievalReader(db)
  watcher = new ChangeWatcher(
    db,
    dataDir,
    (c) => {
      reader!.invalidate()
      broadcast({ e: 'changed', kinds: [c.kind] })
    },
    'now',
    {
      onReset: () => {
        reader!.invalidate()
        broadcast({ e: 'changed', kinds: ['reset'] })
      },
    },
  )
  watcher.start()
  for (const w of waiting.splice(0)) w()
}

function attach(port: MessagePortMain): void {
  ports.add(port)
  port.on('message', async ({ data }: { data: { id: number; query: Query } }) => {
    await ready()
    const t0 = performance.now()
    try {
      const run = handlers[data.query.q] as (src: Sources, q: Query) => unknown
      const result = reader!.read(() => run({ record: reader!, finder: finder! }, data.query))
      port.postMessage({ id: data.id, ok: true, result, ms: performance.now() - t0 })
    } catch (err) {
      port.postMessage({ id: data.id, ok: false, error: err instanceof Error ? err.message : 'failed' })
    }
  })
  port.on('close', () => ports.delete(port))
  port.start()
}

process.parentPort.on('message', (e: { data: Parent; ports: MessagePortMain[] }) => {
  const msg = e.data
  if (msg.type === 'init') open(msg.dataDir)
  else if (msg.type === 'activity') broadcast({ e: 'activity' })
  else if (msg.type === 'port') for (const p of e.ports) attach(p)
})

process.on('exit', () => {
  watcher?.stop()
  db?.close()
})
