import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function connect(url: string): { db: Db; pool: Pool } {
  const pool = new Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 5_000, query_timeout: 15_000 });
  return { db: drizzle(pool, { schema, casing: "snake_case" }), pool };
}

let shared: Db | undefined;

/** The app's connection, from DATABASE_URL and nothing else, so any stock Postgres host works. */
export function appDb(): Db {
  if (shared) return shared;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  shared = connect(url).db;
  return shared;
}

/** Runs fn as the daylens_app role with the admin set, so row-level security checks every read again. */
export function asAdmin<T>(db: Db, adminId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role daylens_app`);
    await tx.execute(sql`select set_config('app.admin_id', ${adminId}, true)`);
    return fn(tx);
  });
}
