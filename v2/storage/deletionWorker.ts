// Runs deletions off the capture thread, on its own connection to the same database.
import Database from 'better-sqlite3'
import { parentPort, workerData } from 'node:worker_threads'
import { Deleter } from './deletion.ts'
import { ScrubUnavailableError } from './scrub.ts'
import { setBeforeWrite } from './tx.ts'

const { file, want } = workerData as { file: string; want: Int32Array }
const db = new Database(file)
// Capture sets this while it flushes; each write transaction here waits until it is clear, so capture gets the lock next.
setBeforeWrite(() => {
  while (Atomics.load(want, 0) !== 0) Atomics.wait(want, 0, Atomics.load(want, 0), 50)
})
// Capture's flushes are short; waiting for one is fine, failing because of one is not.
db.pragma('busy_timeout = 5000')
db.pragma('foreign_keys = ON')
db.pragma('secure_delete = ON')
db.pragma('journal_size_limit = 16777216')
const deleter = new Deleter(db)

parentPort!.on('message', (job: { id: number; op: 'delete' | 'purge' | 'prune' | 'checkpoint' | 'purge_file'; tombstone: number; now: number; cutoff: number | null; logKeepFrom: number }) => {
  try {
    if (job.op === 'purge_file') {
      parentPort!.postMessage({ id: job.id, result: deleter.purgeFile() })
      return
    }
    if (job.op === 'checkpoint') {
      parentPort!.postMessage({ id: job.id, result: deleter.checkpointRetention() })
      return
    }
    if (job.op === 'prune') {
      parentPort!.postMessage({ id: job.id, result: deleter.prune(job.cutoff, job.logKeepFrom) })
      return
    }
    if (job.op === 'purge') {
      parentPort!.postMessage({ id: job.id, result: deleter.purge(job.tombstone) })
      return
    }
    const result = deleter.run(job.tombstone, job.now)
    // The removal is done either way; without a scrub it stays unpurged, and storage's retries report why.
    try {
      result.purged = deleter.purge(job.tombstone)
    } catch (err) {
      if (!(err instanceof ScrubUnavailableError)) throw err
    }
    parentPort!.postMessage({ id: job.id, result })
  } catch (err) {
    parentPort!.postMessage({ id: job.id, error: `${(err as { code?: string }).code ?? 'error'}: ${(err as Error).message}` })
  }
})
