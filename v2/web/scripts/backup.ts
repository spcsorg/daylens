import { backupDb } from "../lib/db/ops";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL to a Postgres connection string.");
  return url;
}

const file = await backupDb(databaseUrl(), process.argv[2] ?? process.env.BACKUP_DIR ?? "backups");
console.log(`Backed up to ${file}`);
