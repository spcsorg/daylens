// Holds the writer lock on another connection, then commits: after `ms`, or, given `release`, `ms` after the test sets it.
import Database from 'better-sqlite3'
import { parentPort, workerData } from 'node:worker_threads'

const { file, ms, locked, release } = workerData as { file: string; ms: number; locked?: Int32Array; release?: Int32Array }
const db = new Database(file)
db.prepare('BEGIN IMMEDIATE').run()
if (locked) { Atomics.store(locked, 0, 1); Atomics.notify(locked, 0) }
parentPort!.postMessage('locked')
if (release) Atomics.wait(release, 0, 0, 60_000)
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
db.prepare('COMMIT').run()
db.close()
parentPort!.postMessage('released')
