import { migrateDb } from "../lib/db/ops";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL to a Postgres connection string.");
  return url;
}

await migrateDb(databaseUrl());
console.log("Migrations applied.");
