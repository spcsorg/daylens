// C6 — migration ladder round-trip.
//
// Verifies the production install + upgrade paths:
//
//   1. Fresh install: SCHEMA_SQL boots into a working DB, then `runMigrations()`
//      advances `schema_version` to the latest version without throwing.
//   2. Idempotency: a second `runMigrations()` call on the same DB is a no-op.
//   3. Core tables exist after the round-trip (catches a regression where a
//      migration accidentally drops or renames a base table).
//   4. SCHEMA_SQL and the migration ladder converge on the SAME memory_records
//      (see the memory-schema block at the bottom of this file).
//
// Does not assert specific column counts — that would create maintenance noise
// every time a migration adds a column. Asserts the structural invariants only.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { SCHEMA_SQL } from '../src/main/db/schema.ts'
import { setTestDb, clearTestDb } from './support/database-stub.mjs'
import { ensureMemorySearchSchema, runMigrations } from '../src/main/db/migrations.ts'

const REQUIRED_TABLES = [
  'app_sessions',
  'live_app_session_snapshot',
  'focus_sessions',
  'ai_conversations',
  'ai_messages',
  'ai_threads',
  'website_visits',
  'maintenance_runs',
  'schema_version',
]

function tableNames(db: Database.Database): Set<string> {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all() as { name: string }[]
  return new Set(rows.map((r) => r.name))
}

function indexNames(db: Database.Database): Set<string> {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
    .all() as { name: string }[]
  return new Set(rows.map((r) => r.name))
}

function currentSchemaVersion(db: Database.Database): number {
  const row = db
    .prepare('SELECT MAX(version) AS v FROM schema_version')
    .get() as { v: number | null } | undefined
  return row?.v ?? 0
}

test('fresh install: SCHEMA_SQL boots + runMigrations advances schema_version', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)

  setTestDb(db)
  try {
    assert.doesNotThrow(() => runMigrations())

    const version = currentSchemaVersion(db)
    assert.ok(version >= 22, `expected schema_version >= 22, got ${version}`)

    const tables = tableNames(db)
    for (const required of REQUIRED_TABLES) {
      assert.ok(tables.has(required), `missing required table: ${required}`)
    }

    // The migration ladder must be strictly increasing in array order:
    // runMigrations() filters on version > MAX(applied), so a migration added
    // below the current tip would never run on upgraded databases (this is why
    // the twin dedupe was renumbered v57 -> v59 and v57 stays a documented
    // gap). On a fresh install rows land in array order, so rowid order
    // reveals the array order.
    const applied = db
      .prepare('SELECT version FROM schema_version ORDER BY rowid')
      .all() as { version: number }[]
    for (let i = 1; i < applied.length; i++) {
      assert.ok(
        applied[i].version > applied[i - 1].version,
        `migration ladder not strictly increasing: v${applied[i].version} follows v${applied[i - 1].version}`,
      )
    }
  } finally {
    clearTestDb()
    db.close()
  }
})

test('runMigrations is idempotent on an up-to-date database', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)

  setTestDb(db)
  try {
    runMigrations()
    const firstVersion = currentSchemaVersion(db)

    assert.doesNotThrow(() => runMigrations())

    const secondVersion = currentSchemaVersion(db)
    assert.equal(secondVersion, firstVersion, 'second runMigrations() should not advance the version')
  } finally {
    clearTestDb()
    db.close()
  }
})

test('v36 database boots before the work-memory scope migration runs', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
    INSERT INTO schema_version (version, applied_at) VALUES (36, 0);

    CREATE TABLE work_memory_facts (
      id          TEXT PRIMARY KEY,
      fact_text   TEXT NOT NULL,
      origin      TEXT NOT NULL CHECK(origin IN ('drafted', 'user')),
      status      TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'deleted')),
      topic_key   TEXT,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX idx_work_memory_facts_status
      ON work_memory_facts (status, sort_order);

    CREATE TABLE ai_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL UNIQUE,
      job_type TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      latency_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      cache_hit INTEGER NOT NULL DEFAULT 0
    );
  `)

  assert.doesNotThrow(() => db.exec(SCHEMA_SQL))

  setTestDb(db)
  try {
    assert.doesNotThrow(() => runMigrations())

    const columns = db.prepare(`PRAGMA table_info(work_memory_facts)`).all() as { name: string }[]
    assert.ok(columns.some((column) => column.name === 'source'))
    assert.ok(columns.some((column) => column.name === 'scope'))

    const indexes = indexNames(db)
    assert.ok(indexes.has('idx_work_memory_facts_scope'))
  } finally {
    clearTestDb()
    db.close()
  }
})

test('migration ladder does not drop any required base table', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)

  setTestDb(db)
  try {
    runMigrations()
    const tables = tableNames(db)
    for (const required of REQUIRED_TABLES) {
      assert.ok(tables.has(required), `migration dropped required table: ${required}`)
    }
  } finally {
    clearTestDb()
    db.close()
  }
})

test('migration ladder leaves the database queryable', () => {
  // Sanity: after migrations, a few representative queries should run without
  // syntax errors. Catches the case where a migration adds an index against
  // a non-existent column.
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)

  setTestDb(db)
  try {
    runMigrations()

    assert.doesNotThrow(() => db.prepare('SELECT COUNT(*) FROM app_sessions').get())
    assert.doesNotThrow(() => db.prepare('SELECT COUNT(*) FROM website_visits').get())
    assert.doesNotThrow(() => db.prepare('SELECT COUNT(*) FROM ai_threads').get())
    assert.doesNotThrow(() => db.prepare('SELECT COUNT(*) FROM schema_version').get())
  } finally {
    clearTestDb()
    db.close()
  }
})

test('fresh schema and migrations include hot-path performance indexes', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)

  setTestDb(db)
  try {
    runMigrations()

    const indexes = indexNames(db)
    // idx_focus_sessions_start is the standalone hot-path index. (bundle_id,
    // start_time) is covered by the UNIQUE idx_app_sessions_dedup and
    // timeline_block_members(block_id) by that table's PRIMARY KEY, so we assert
    // those covering indexes exist rather than the removed redundant ones.
    for (const indexName of [
      'idx_focus_sessions_start',
      'idx_app_sessions_dedup',
    ]) {
      assert.ok(indexes.has(indexName), `missing hot-path index: ${indexName}`)
    }
  } finally {
    clearTestDb()
    db.close()
  }
})

// ─── memory_records: SCHEMA_SQL and the ladder must converge ─────────────────
//
// memory_records is the table the ladder rebuilds most often: every migration
// that widens its record_kind CHECK has to drop and recreate it, because
// SQLite cannot alter a CHECK in place. Each of those migrations skips itself
// when the CHECK already admits its kind, so SCHEMA_SQL is expected to carry
// the CURRENT shape and the rebuild is expected to be a no-op on a fresh
// install.
//
// v70 (the 'page' record kind plus domain/url) landed without that SCHEMA_SQL
// update. Nothing broke — a fresh install built the old table and v70 rebuilt
// it a moment later — but schema.ts stopped describing the table the app
// actually runs on, which is how the next reader gets misled. These two tests
// make that class of drift loud instead of invisible.
const MEMORY_OBJECT_PREFIX = 'memory_'

// SQLite rewrites a table's stored DDL when ALTER TABLE ... RENAME lands on
// it, quoting the new name: the ladder's rebuilt table reads
// CREATE TABLE "memory_records" where the fresh one reads CREATE TABLE
// memory_records. Same table, different spelling of the same identifier, so
// quotes and run-lengths of whitespace are normalized away. Nothing else is:
// column order, types, defaults, CHECK bodies and foreign keys all have to
// match character for character.
function normalizeDdl(sql: string): string {
  return sql.replace(/"/g, '').replace(/\s+/g, ' ').trim()
}

/** Every sqlite_master object belonging to the memory tables — the tables
 *  themselves, their indexes, the FTS vtable and its content view, and the
 *  triggers that keep the index in sync. */
function memorySchemaObjects(db: Database.Database): Map<string, string> {
  const rows = db
    .prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master`)
    .all() as { type: string; name: string; tbl_name: string; sql: string | null }[]
  const objects = new Map<string, string>()
  for (const row of rows) {
    if (!row.name.startsWith(MEMORY_OBJECT_PREFIX) && !row.tbl_name.startsWith(MEMORY_OBJECT_PREFIX)) continue
    // Implicit indexes (PRIMARY KEY / UNIQUE) carry no SQL of their own; their
    // presence is still part of the shape, so they are recorded by name.
    objects.set(`${row.type}:${row.name}`, row.sql ? normalizeDdl(row.sql) : '(implicit)')
  }
  return objects
}

function migrate(db: Database.Database): void {
  setTestDb(db)
  const log = console.log
  console.log = () => {}
  try {
    runMigrations()
  } finally {
    console.log = log
    clearTestDb()
  }
}

// The memory schema as a v69 install carried it: no 'page' record kind, no
// domain/url columns, no domain index. This is the shape v70 upgrades FROM,
// and it is deliberately a literal rather than a reference to any live
// constant — a fixture that moved with the code would prove nothing.
const PRE_V70_MEMORY_SCHEMA = `
  DROP TABLE IF EXISTS memory_records_fts;
  DROP VIEW IF EXISTS memory_records_fts_content;
  DROP TABLE IF EXISTS memory_record_vectors;
  DROP TABLE IF EXISTS memory_record_entities;
  DROP TABLE IF EXISTS memory_records;

  CREATE TABLE memory_records (
    id                TEXT PRIMARY KEY,
    record_kind       TEXT NOT NULL CHECK(record_kind IN ('session', 'meeting', 'artifact', 'supplied_fact', 'connected_activity')),
    memory_type       TEXT NOT NULL CHECK(memory_type IN ('observed', 'connected', 'supplied', 'inferred')),
    statement         TEXT NOT NULL,
    exact_text        TEXT NOT NULL DEFAULT '',
    semantic_text     TEXT,
    date              TEXT NOT NULL,
    start_ms          INTEGER NOT NULL,
    end_ms            INTEGER NOT NULL,
    app_bundle_id     TEXT,
    app_name          TEXT,
    title             TEXT,
    primary_entity_id TEXT,
    source_refs_json  TEXT NOT NULL DEFAULT '[]',
    confidence        TEXT NOT NULL DEFAULT 'observed',
    provenance        TEXT NOT NULL DEFAULT 'capture',
    sensitivity       TEXT NOT NULL DEFAULT 'standard' CHECK(sensitivity IN ('standard', 'personal', 'high')),
    embedding_model   TEXT,
    embedding_version INTEGER,
    created_at        INTEGER NOT NULL,
    deleted_at        INTEGER
  );
  CREATE INDEX idx_memory_records_date ON memory_records (date);
  CREATE INDEX idx_memory_records_kind_start ON memory_records (record_kind, start_ms DESC);

  CREATE TABLE memory_record_entities (
    record_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
    entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    PRIMARY KEY (record_id, entity_id)
  );
  CREATE INDEX idx_memory_record_entities_entity ON memory_record_entities (entity_id);

  CREATE TABLE memory_record_vectors (
    vec_rowid     INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id     TEXT NOT NULL UNIQUE REFERENCES memory_records(id) ON DELETE CASCADE,
    date          TEXT NOT NULL,
    model         TEXT NOT NULL,
    model_version INTEGER NOT NULL,
    dims          INTEGER NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX idx_memory_record_vectors_date ON memory_record_vectors (date);
`

test('SCHEMA_SQL never declares a memory object the ladder then changes', () => {
  // The fresh-install path in production is SCHEMA_SQL then the ladder
  // (services/database.ts). If a rebuild migration fires on that path, the
  // table SCHEMA_SQL declared is not the table the app ends up running on —
  // schema.ts is documenting a shape that exists for milliseconds.
  const declared = new Database(':memory:')
  declared.pragma('foreign_keys = ON')
  declared.exec(SCHEMA_SQL)

  const installed = new Database(':memory:')
  installed.pragma('foreign_keys = ON')
  installed.exec(SCHEMA_SQL)

  try {
    migrate(installed)

    const before = memorySchemaObjects(declared)
    const after = memorySchemaObjects(installed)
    for (const [key, sql] of before) {
      const live = after.get(key)
      assert.ok(live !== undefined, `SCHEMA_SQL declares ${key} but the migration ladder removes it`)
      assert.equal(
        live,
        sql,
        `${key} differs between what SCHEMA_SQL declares and what a fresh install ends up with. `
        + 'A rebuild migration is firing on the fresh-install path; bring SCHEMA_SQL up to the '
        + 'current shape so the rebuild no-ops and schema.ts describes the real table.',
      )
    }
  } finally {
    declared.close()
    installed.close()
  }
})

test('fresh install and a pre-v70 upgrade converge on the same memory schema', () => {
  // (a) Fresh install: SCHEMA_SQL + the ladder.
  const fresh = new Database(':memory:')
  fresh.pragma('foreign_keys = ON')
  fresh.exec(SCHEMA_SQL)

  // (b) Upgrade: the v69 memory shape, carrying the FTS index a real v69
  // install had, then the ladder from v70 to HEAD.
  const upgraded = new Database(':memory:')
  upgraded.pragma('foreign_keys = ON')
  upgraded.exec(SCHEMA_SQL)
  upgraded.exec(PRE_V70_MEMORY_SCHEMA)
  ensureMemorySearchSchema(upgraded)
  upgraded.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `)
  upgraded.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(69, 0)

  try {
    migrate(fresh)
    migrate(upgraded)

    // The upgrade really did run v70 — otherwise this test would pass by
    // never exercising the migration it exists to cover.
    const upgradedRecords = upgraded
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_records'`)
      .get() as { sql: string }
    assert.match(upgradedRecords.sql, /'page'/, 'v70 did not run on the upgrade path')

    const freshObjects = memorySchemaObjects(fresh)
    const upgradedObjects = memorySchemaObjects(upgraded)
    const keys = [...new Set([...freshObjects.keys(), ...upgradedObjects.keys()])].sort()
    for (const key of keys) {
      assert.equal(
        freshObjects.get(key) ?? '(absent)',
        upgradedObjects.get(key) ?? '(absent)',
        `${key} differs between the fresh-install and upgrade paths. Both must land on one table: `
        + 'a person who installed today and a person who upgraded must be running the same schema.',
      )
    }
  } finally {
    fresh.close()
    upgraded.close()
  }
})
