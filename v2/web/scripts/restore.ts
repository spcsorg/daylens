import { restoreDb } from "../lib/db/ops";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL to a Postgres connection string.");
  return url;
}

const file = process.argv[2];
if (!file) throw new Error("Usage: npm run db:restore -- <backup file>");
await restoreDb(databaseUrl(), file);
console.log(`Restored ${file}`);
