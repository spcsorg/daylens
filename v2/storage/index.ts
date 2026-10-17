// Step 2 storage: the single source of truth around the capture store. One process (the capture service)
// writes; every other reader opens the database read-only and follows the change log.
import type Database from 'better-sqlite3'
import type { Store } from '../capture/store.ts'
import { ChangeBus, changeLogMigration } from './changes.ts'
import { applyMigrations, type Migration } from './migrations.ts'

export const STORAGE_MIGRATIONS: Migration[] = [changeLogMigration]

export class Storage {
  readonly store: Store
  readonly db: Database.Database
  readonly bus: ChangeBus
  readonly now: () => number

  constructor(store: Store, dir: string, opts: { now?: () => number } = {}) {
    this.store = store
    this.db = store.database
    this.now = opts.now ?? Date.now
    applyMigrations(this.db, STORAGE_MIGRATIONS, this.now)
    this.bus = new ChangeBus(this.db, dir, this.now)
  }
}
