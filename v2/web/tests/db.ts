import { Client } from "pg";
import { connect } from "@/lib/db/client";
import { migrateDb } from "@/lib/db/ops";
import { replaceAll } from "@/lib/db/store";
import { seedTables } from "@/lib/data/seed";

export const NOW = Date.parse("2026-11-27T08:40:00Z");

function serverUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("The database tests need DATABASE_URL pointing at a Postgres server they can create databases on.");
  return url;
}

/** A new, empty database on the test server, and a way to drop it. */
export async function freshDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `daylens_test_${Math.random().toString(36).slice(2, 10)}`;
  const admin = new Client({ connectionString: serverUrl() });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(serverUrl());
  url.pathname = "/" + name;
  return {
    url: url.toString(),
    drop: async () => {
      const c = new Client({ connectionString: serverUrl() });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
    },
  };
}

export async function seededDatabase() {
  const fresh = await freshDatabase();
  await migrateDb(fresh.url);
  const { db, pool } = connect(fresh.url);
  const tables = seedTables(NOW);
  await replaceAll(db, tables);
  return { ...fresh, db, pool, tables };
}
