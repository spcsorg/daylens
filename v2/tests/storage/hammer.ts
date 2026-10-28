// A writer on its own connection that commits several hundred times a second for a while: far more than capture's
// one flush a second, with a 1 ms pause so a waiting connection can get the lock (a tight loop starves any waiter).
import Database from 'better-sqlite3'
import { workerData, parentPort } from 'node:worker_threads'

const { file, ms } = workerData as { file: string; ms: number }
const db = new Database(file)
db.pragma('busy_timeout = 5000')
const write = db.prepare(`INSERT INTO meta (key, value) VALUES ('hammer', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
const end = Date.now() + ms
let n = 0
const pause = new Int32Array(new SharedArrayBuffer(4))
while (Date.now() < end) {
  write.run(String(n++))
  Atomics.wait(pause, 0, 0, 1)
}
db.close()
parentPort!.postMessage(n)
