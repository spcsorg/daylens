// A separate process that opens the database read-only and prints each announced change.
import Database from 'better-sqlite3'
import { ChangeWatcher } from '../../storage/changes.ts'

const [dir, file] = process.argv.slice(2) as [string, string]
const db = new Database(file, { readonly: true })
new ChangeWatcher(db, dir, (c) => process.stdout.write(`${c.seq} ${c.kind}\n`)).start()
