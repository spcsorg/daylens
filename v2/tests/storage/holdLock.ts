// Holds the writer lock on another connection for a while, then commits.
import Database from 'better-sqlite3'
import { parentPort, workerData } from 'node:worker_threads'

const { file, ms } = workerData as { file: string; ms: number }
const db = new Database(file)
db.prepare('BEGIN IMMEDIATE').run()
parentPort!.postMessage('locked')
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
db.prepare('COMMIT').run()
db.close()
parentPort!.postMessage('released')
