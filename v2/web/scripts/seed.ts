import { connect } from "../lib/db/client";
import { replaceAll } from "../lib/db/store";
import { seedTables } from "../lib/data/seed";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL to a Postgres connection string.");
  return url;
}

if (process.env.NODE_ENV === "production") throw new Error("The seed replaces every org's data; it never runs in production.");
const { db, pool } = connect(databaseUrl());
const t = seedTables(Date.now());
await replaceAll(db, t);
await pool.end();
console.log(`Seeded ${t.members.length} people, ${t.blocks.length} blocks and ${t.dailyRollups.length} rollup rows.`);
