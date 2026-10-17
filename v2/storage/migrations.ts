// Named, idempotent migrations. Each one is a single logical change, recorded by name once applied, and checks
// the schema before altering it, so branches that add their own migrations merge without number collisions.
import type Database from 'better-sqlite3'

export interface Migration {
  name: string
  up: (db: Database.Database) => void
}

export function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)
}

export function applyMigrations(db: Database.Database, migrations: readonly Migration[], now: () => number = Date.now): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_wall_ms INTEGER NOT NULL)')
  const done = new Set((db.prepare('SELECT name FROM migrations').all() as { name: string }[]).map((r) => r.name))
  const applied: string[] = []
  for (const m of migrations) {
    if (done.has(m.name)) continue
    db.transaction(() => {
      m.up(db)
      db.prepare('INSERT INTO migrations (name, applied_wall_ms) VALUES (?, ?)').run(m.name, now())
    })()
    applied.push(m.name)
  }
  return applied
}
