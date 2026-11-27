# Daylens Enterprise admin

The admin dashboard for firms: Overview and People, with each person's day, week and month. Design and decisions: [System design](../../docs/system-design.md#enterprise-admin-dashboard-and-org-database).

## Run it locally

You need Node 24 or later and a stock Postgres 16+ server. Docker is the quickest:

```sh
docker run -d --name daylens-pg -e POSTGRES_USER=daylens -e POSTGRES_PASSWORD=daylens -e POSTGRES_DB=daylens -p 54329:5432 postgres:17
export DATABASE_URL=postgres://daylens:daylens@localhost:54329/daylens
npm ci
npm run db:migrate
npm run db:seed
DAYLENS_DEV_SIGN_IN=1 npm run dev
```

Open http://localhost:3000, pick Paul Mwangi (owner, whole firm) or Diane Ingabire (admin of Audit and Tax). "Active now" counts heartbeats from the last 5 minutes, so run `npm run db:seed` again to bring the invented firm back to the present.

| Variable | What it does |
|---|---|
| `DATABASE_URL` | Postgres connection string. The only database setting. |
| `DAYLENS_DEV_SIGN_IN` | `1` turns on the dev sign-in. Ignored in production builds. |
| `BACKUP_DIR` | Where `db:backup` writes, if no directory is passed. Defaults to `backups/`. |

## Checks

```sh
npm run typecheck && npm run lint && npm test && npm run build
```

`npm test` needs `DATABASE_URL` pointing at a server where it may create and drop databases, and `pg_dump`/`pg_restore` on the `PATH`.

## Backups

```sh
npm run db:backup -- /path/to/dir
npm run db:restore -- /path/to/dir/daylens-2026-01-01T00-00-00-000Z.dump
```
