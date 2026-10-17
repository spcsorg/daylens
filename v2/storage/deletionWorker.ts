// Runs deletions off the capture thread, on its own connection to the same database.
import Database from 'better-sqlite3'
import { parentPort, workerData } from 'node:worker_threads'
import { Deleter } from './deletion.ts'

const db = new Database((workerData as { file: string }).file)
// Capture's flushes are short; waiting for one is fine, failing because of one is not.
db.pragma('busy_timeout = 5000')
db.pragma('foreign_keys = ON')
db.pragma('secure_delete = ON')
db.pragma('journal_size_limit = 16777216')
const deleter = new Deleter(db)

parentPort!.on('message', (job: { id: number; tombstone: number; now: number }) => {
  try {
    const result = deleter.run(job.tombstone, job.now)
    deleter.purge()
    parentPort!.postMessage({ id: job.id, result })
  } catch (err) {
    parentPort!.postMessage({ id: job.id, error: `${(err as { code?: string }).code ?? 'error'}: ${(err as Error).message}` })
  }
})
