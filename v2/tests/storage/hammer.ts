// A writer on its own connection that commits as fast as it can for a while, as live capture does under load.
import Database from 'better-sqlite3'
import { workerData, parentPort } from 'node:worker_threads'

const { file, ms } = workerData as { file: string; ms: number }
const db = new Database(file)
db.pragma('busy_timeout = 5000')
const write = db.prepare(`INSERT INTO meta (key, value) VALUES ('hammer', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
const end = Date.now() + ms
let n = 0
while (Date.now() < end) {
  write.run(String(n++))
}
db.close()
parentPort!.postMessage(n)
