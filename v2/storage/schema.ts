// Storage tables beyond capture's, one named migration per logical change.
import { changeLogMigration } from './changes.ts'
import type { Migration } from './migrations.ts'

const intervals: Migration = {
  name: 'intervals',
  // Derived from focus observations; deleting every row and rebuilding gives the same table.
  up: (db) =>
    db.exec(`
      CREATE TABLE intervals (
        id INTEGER PRIMARY KEY,
        obs_id INTEGER NOT NULL UNIQUE,
        start_wall_ms INTEGER NOT NULL,
        end_wall_ms INTEGER NOT NULL,
        tz_offset_min INTEGER NOT NULL,
        app_id TEXT,
        app_name TEXT,
        title TEXT,
        title_state TEXT,
        url TEXT,
        site TEXT,
        files TEXT
      );
      CREATE INDEX intervals_start ON intervals(start_wall_ms);
      CREATE INDEX intervals_app ON intervals(app_id);
      CREATE INDEX intervals_site ON intervals(site);
    `),
}

const hours: Migration = {
  name: 'hours',
  up: (db) =>
    db.exec(`
      CREATE TABLE hours (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        start_wall_ms INTEGER NOT NULL UNIQUE,
        end_wall_ms INTEGER NOT NULL,
        tz TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('facts', 'written')),
        title TEXT,
        summary TEXT,
        detail TEXT,
        outcome TEXT,
        sources TEXT NOT NULL DEFAULT '[]',
        suggestion TEXT,
        writer TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        needs_rewrite INTEGER NOT NULL DEFAULT 0,
        updated_wall_ms INTEGER NOT NULL
      );
    `),
}

const threads: Migration = {
  name: 'threads',
  // AUTOINCREMENT: an id is never handed out again, even after the thread is deleted.
  up: (db) =>
    db.exec(`
      CREATE TABLE threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        created_wall_ms INTEGER NOT NULL,
        updated_wall_ms INTEGER NOT NULL
      );
      CREATE TABLE thread_hours (
        thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        hour_id INTEGER NOT NULL REFERENCES hours(id) ON DELETE CASCADE,
        PRIMARY KEY (thread_id, hour_id)
      );
      CREATE INDEX thread_hours_hour ON thread_hours(hour_id);
    `),
}

const corrections: Migration = {
  name: 'corrections',
  up: (db) =>
    db.exec(`
      CREATE TABLE corrections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hour_id INTEGER NOT NULL REFERENCES hours(id) ON DELETE CASCADE,
        field TEXT NOT NULL CHECK (field IN ('title', 'summary', 'detail', 'outcome', 'suggestion')),
        text TEXT NOT NULL,
        created_wall_ms INTEGER NOT NULL,
        undone_wall_ms INTEGER
      );
      CREATE INDEX corrections_hour ON corrections(hour_id);
    `),
}

const deletions: Migration = {
  name: 'deletions',
  // Tombstones hold what was deleted (a range, an app, a site), never the deleted material.
  up: (db) =>
    db.exec(`
      CREATE TABLE deletions (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('range', 'source', 'site')),
        from_wall_ms INTEGER,
        to_wall_ms INTEGER,
        app_id TEXT,
        site TEXT,
        created_wall_ms INTEGER NOT NULL
      );
    `),
}

const settings: Migration = {
  name: 'settings',
  up: (db) => db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_wall_ms INTEGER NOT NULL)`),
}

const usageLedger: Migration = {
  name: 'usage_ledger',
  up: (db) =>
    db.exec(`
      CREATE TABLE usage_ledger (
        id INTEGER PRIMARY KEY,
        at_wall_ms INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('answer', 'hour')),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost_micro_usd INTEGER NOT NULL,
        ref TEXT
      );
      CREATE INDEX usage_ledger_at ON usage_ledger(at_wall_ms);
    `),
}

const planCache: Migration = {
  name: 'plan_cache',
  up: (db) =>
    db.exec(`
      CREATE TABLE plan_cache (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        plan TEXT NOT NULL,
        status TEXT NOT NULL,
        confirmed_wall_ms INTEGER NOT NULL,
        expires_wall_ms INTEGER,
        payload TEXT NOT NULL DEFAULT '{}'
      );
    `),
}

const assistantReads: Migration = {
  name: 'assistant_reads',
  up: (db) =>
    db.exec(`
      CREATE TABLE assistant_reads (
        id INTEGER PRIMARY KEY,
        assistant TEXT NOT NULL,
        at_wall_ms INTEGER NOT NULL,
        tool TEXT NOT NULL,
        from_wall_ms INTEGER NOT NULL,
        to_wall_ms INTEGER NOT NULL,
        query TEXT
      );
      CREATE INDEX assistant_reads_range ON assistant_reads(from_wall_ms);
    `),
}

const searchIndex: Migration = {
  name: 'search_index',
  // One document per distinct (hour, app, title, address), and one per hour's text. secure-delete makes FTS5
  // remove a deleted document's terms from the index instead of only masking them.
  up: (db) =>
    db.exec(`
      CREATE TABLE search_docs (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('activity', 'hour')),
        hour_start_wall_ms INTEGER NOT NULL,
        app_id TEXT NOT NULL DEFAULT '',
        app_name TEXT,
        title TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '',
        site TEXT,
        files TEXT NOT NULL DEFAULT '',
        hour_id INTEGER,
        hour_text TEXT NOT NULL DEFAULT '',
        first_wall_ms INTEGER NOT NULL,
        last_wall_ms INTEGER NOT NULL,
        UNIQUE (kind, hour_start_wall_ms, app_id, title, url)
      );
      CREATE INDEX search_docs_hour ON search_docs(hour_id);
      CREATE INDEX search_docs_app ON search_docs(app_id);
      CREATE INDEX search_docs_site ON search_docs(site);
      CREATE VIRTUAL TABLE search USING fts5(
        title, address, files, hour_text,
        content = 'search_docs', content_rowid = 'id',
        tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3'
      );
      INSERT INTO search (search, rank) VALUES ('secure-delete', 1);
      CREATE TRIGGER search_docs_ai AFTER INSERT ON search_docs BEGIN
        INSERT INTO search (rowid, title, address, files, hour_text) VALUES (new.id, new.title, new.url, new.files, new.hour_text);
      END;
      CREATE TRIGGER search_docs_ad AFTER DELETE ON search_docs BEGIN
        INSERT INTO search (search, rowid, title, address, files, hour_text) VALUES ('delete', old.id, old.title, old.url, old.files, old.hour_text);
      END;
      CREATE TRIGGER search_docs_au AFTER UPDATE OF title, url, files, hour_text ON search_docs BEGIN
        INSERT INTO search (search, rowid, title, address, files, hour_text) VALUES ('delete', old.id, old.title, old.url, old.files, old.hour_text);
        INSERT INTO search (rowid, title, address, files, hour_text) VALUES (new.id, new.title, new.url, new.files, new.hour_text);
      END;
    `),
}

const searchPlainDeletes: Migration = {
  name: 'search_plain_deletes',
  // FTS5 secure-delete costs 0.26 ms per document (11 s to delete one app from 40 days). Deletions instead merge
  // the index in short steps before they are purged (Deleter.mergeSearchIfPending), which drops the deleted terms.
  up: (db) => db.exec(`INSERT INTO search (search, rank) VALUES ('secure-delete', 0)`),
}

const searchDocsByHour: Migration = {
  name: 'search_docs_by_hour',
  // Retention prunes documents by hour; without this every batch scans the whole table (856 ms cold at a year).
  up: (db) => db.exec('CREATE INDEX search_docs_hour_start ON search_docs(hour_start_wall_ms)'),
}

const pauses: Migration = {
  name: 'pauses',
  // Every pause, finished ones included: a line stamped inside a pause but delivered later is still refused.
  up: (db) => {
    db.exec(`
      CREATE TABLE pauses (
        id INTEGER PRIMARY KEY,
        since_wall_ms INTEGER NOT NULL,
        until_wall_ms INTEGER,
        ended_wall_ms INTEGER,
        gap_id INTEGER
      );
    `)
    const old = db.prepare(`SELECT value FROM settings WHERE key = 'pause'`).get() as { value: string } | undefined
    if (old) {
      const p = JSON.parse(old.value) as { from_wall_ms: number; until_wall_ms: number | null; gap_id: number }
      db.prepare('INSERT INTO pauses (since_wall_ms, until_wall_ms, gap_id) VALUES (?, ?, ?)').run(p.from_wall_ms, p.until_wall_ms, p.gap_id)
      db.exec(`DELETE FROM settings WHERE key = 'pause'`)
    }
  },
}

const threadsNeedRewrite: Migration = {
  name: 'threads_needs_rewrite',
  // A thread that outlives a deletion keeps its id but loses a title that may describe the deleted material.
  up: (db) => db.exec('ALTER TABLE threads ADD COLUMN needs_rewrite INTEGER NOT NULL DEFAULT 0'),
}

const assistantReadItems: Migration = {
  name: 'assistant_read_items',
  // What each read touched (hours, apps, sites), so a deletion removes exactly the reads that saw the material.
  up: (db) =>
    db.exec(`
      CREATE TABLE assistant_read_items (
        read_id INTEGER NOT NULL REFERENCES assistant_reads(id) ON DELETE CASCADE,
        hour_id INTEGER,
        app_id TEXT,
        site TEXT
      );
      CREATE INDEX assistant_read_items_read ON assistant_read_items(read_id);
      CREATE INDEX assistant_read_items_hour ON assistant_read_items(hour_id);
      CREATE INDEX assistant_read_items_app ON assistant_read_items(app_id);
      CREATE INDEX assistant_read_items_site ON assistant_read_items(site);
    `),
}

const deriveBackfill: Migration = {
  name: 'derive_backfill',
  // History captured before storage existed is derived in resumable steps from its first observation.
  up: (db) =>
    db.exec(`INSERT INTO meta (key, value) SELECT 'derive_backfill_from', CAST(min(event_wall_ms) AS TEXT) FROM observations HAVING count(*) > 0
             ON CONFLICT (key) DO UPDATE SET value = excluded.value`),
}

const deletionState: Migration = {
  name: 'deletion_state',
  // pending: in force, material still being removed in the background; done: removed; purged: also gone from disk.
  up: (db) => db.exec(`ALTER TABLE deletions ADD COLUMN state TEXT NOT NULL DEFAULT 'done' CHECK (state IN ('pending', 'done', 'purged'))`),
}

const deletionWork: Migration = {
  name: 'deletion_work',
  // What a deletion must still do, written with its tombstone, so a restart resumes from the list and not from
  // tables the deletion has already changed. Each item goes in the same transaction as its work.
  up: (db) =>
    db.exec(`
      CREATE TABLE deletion_work (
        tombstone_id INTEGER NOT NULL REFERENCES deletions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('doc_hour', 'hour', 'thread', 'read')),
        ref INTEGER NOT NULL,
        PRIMARY KEY (tombstone_id, kind, ref)
      ) WITHOUT ROWID;
    `),
}

const deletionFence: Migration = {
  name: 'deletion_fence',
  // What a pending deletion covers, as planned: readers and writers check this, not the hours' current contents,
  // which the deletion itself clears. Kept until the deletion is done, apart from the work list it ticks off.
  up: (db) =>
    db.exec(`
      CREATE TABLE deletion_fence (
        tombstone_id INTEGER NOT NULL REFERENCES deletions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('hour', 'thread', 'read')),
        ref INTEGER NOT NULL,
        PRIMARY KEY (tombstone_id, kind, ref)
      ) WITHOUT ROWID;
      CREATE INDEX deletion_fence_ref ON deletion_fence(kind, ref);
    `),
}

const pausesByApp: Migration = {
  name: 'pauses_by_app',
  // A pause scoped to one app (a browser paused from the Daylens extension); null pauses everything.
  up: (db) => db.exec('ALTER TABLE pauses ADD COLUMN app_id TEXT'),
}

const deletionAnnounced: Migration = {
  name: 'deletion_announced',
  // The last terminal state announced, written with its announcement: a restart announces what a crash left unsaid.
  // Deletions from before this column are taken as announced.
  up: (db) =>
    db.exec(`
      ALTER TABLE deletions ADD COLUMN announced TEXT CHECK (announced IN ('done', 'purged'));
      UPDATE deletions SET announced = state WHERE state != 'pending';
    `),
}

// The rows presence is read from (agent attribution: when the person was away), by kind and time; focus rows, nearly all
// of the table, stay out of it. Queries name the same kinds so the planner can use it.
export const PRESENCE_KINDS = `kind IN ('session', 'power', 'input', 'presence')`
const observationsByPresenceKind: Migration = {
  name: 'observations_by_presence_kind',
  up: (db) => db.exec(`CREATE INDEX IF NOT EXISTS observations_presence ON observations(kind, event_wall_ms) WHERE ${PRESENCE_KINDS}`),
}

const exclusionPeriods: Migration = {
  name: 'exclusion_periods',
  // When each exclusion was in force: a log read later (an agent session's) is judged by the rules of its own time, so
  // what an app did while it was excluded stays out after the exclusion is removed. An open period is a rule in force.
  up: (db) =>
    db.exec(`
      CREATE TABLE exclusion_periods (
        id INTEGER PRIMARY KEY,
        match TEXT NOT NULL,
        value TEXT NOT NULL,
        from_wall_ms INTEGER NOT NULL,
        to_wall_ms INTEGER
      );
      CREATE INDEX exclusion_periods_rule ON exclusion_periods(match, value) WHERE to_wall_ms IS NULL;
    `),
}

export const STORAGE_MIGRATIONS: readonly Migration[] = [
  changeLogMigration,
  intervals,
  hours,
  threads,
  corrections,
  deletions,
  settings,
  usageLedger,
  planCache,
  assistantReads,
  searchIndex,
  searchPlainDeletes,
  searchDocsByHour,
  pauses,
  threadsNeedRewrite,
  assistantReadItems,
  deriveBackfill,
  deletionState,
  deletionWork,
  deletionFence,
  pausesByApp,
  deletionAnnounced,
  observationsByPresenceKind,
  exclusionPeriods,
]
