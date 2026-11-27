import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { connect } from "./client";

const run = promisify(execFile);

export async function migrateDb(url: string) {
  const { db, pool } = connect(url);
  try {
    await migrate(db, { migrationsFolder: resolve(import.meta.dirname, "../../drizzle") });
  } finally {
    await pool.end();
  }
}

/** pg_dump in custom format to a timestamped file in dir. Returns the file. */
export async function backupDb(url: string, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, `daylens-${new Date().toISOString().replace(/[:.]/g, "-")}.dump`);
  await run("pg_dump", ["--format=custom", "--file", file, "--dbname", url]);
  return file;
}

/** Restores a backup into the database at url. Creates the app role first, since roles live outside a dump. */
export async function restoreDb(url: string, file: string) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daylens_app') THEN CREATE ROLE daylens_app NOLOGIN; END IF;
    END $$`);
    await client.query("GRANT daylens_app TO CURRENT_USER");
  } finally {
    await client.end();
  }
  await run("pg_restore", ["--clean", "--if-exists", "--no-owner", "--exit-on-error", "--dbname", url, file]);
}
