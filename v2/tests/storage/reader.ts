// A reader on its own connection that keeps searching, as the interface and the MCP server do.
import Database from 'better-sqlite3'
import { parentPort, workerData } from 'node:worker_threads'

const { file, ms } = workerData as { file: string; ms: number }
const db = new Database(file, { readonly: true })
const q = db.prepare(`SELECT d.title FROM search JOIN search_docs d ON d.id = search.rowid WHERE search MATCH ? LIMIT 50`)
const end = Date.now() + ms
let n = 0
while (Date.now() < end) {
  q.all(['item', 'plan', 'notes', 'canary1'][n++ % 4])
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
}
db.close()
parentPort!.postMessage(n)
