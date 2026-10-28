// Recall of search on gold queries from real days. The queries and the database are private and live outside the
// repository; this fails loudly when either is missing rather than measuring nothing.
// Usage: npm run eval:search -- --queries <folder> [--db <daylens-v2.sqlite>] [--match all|any]
// Writes results-<date>.json beside queries.json and prints the summary.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { Reader } from '../retrieval/reader.ts'
import { search, type FoundItem, type SearchResults } from '../retrieval/search.ts'

const HOME = os.homedir()
const { values } = parseArgs({
  options: {
    queries: { type: 'string' },
    db: { type: 'string', default: path.join(HOME, 'Library', 'Application Support', 'Daylens V2 Eval', 'daylens-v2.sqlite') },
    match: { type: 'string', default: 'all' },
  },
})
if (values.match !== 'all' && values.match !== 'any') throw new Error('--match all|any')
if (!values.queries) {
  process.stderr.write('eval:search: --queries <folder> is required: the folder holding queries.json, where results are written; nothing was measured.\n')
  process.exit(1)
}
const match = values.match
const folder = path.resolve(values.queries)
const file = path.join(folder, 'queries.json')
const dbFile = path.resolve(values.db)
if (!existsSync(file)) {
  process.stderr.write(`eval:search: no gold queries at ${file}. They are private and kept outside the repository; nothing was measured.\n`)
  process.exit(1)
}
if (!existsSync(dbFile)) {
  process.stderr.write(`eval:search: no evaluation database at ${dbFile}. Build it with tools/importV1.ts; nothing was measured.\n`)
  process.exit(1)
}

type Target = { group: 'pages'; url_contains: string } | { group: 'windows'; title_contains: string } | { group: 'files'; file: string }
interface Query {
  id: string
  style: string
  query: string
  expect: Target[]
}
const { queries } = JSON.parse(readFileSync(file, 'utf8')) as { queries: Query[] }
if (!Array.isArray(queries) || queries.length === 0) throw new Error(`${file} has no queries`)

// Recall is reported at these depths; searching to the deepest one shows where each target ranks.
const DEPTHS = [1, 3, 5, 10, 20]
const deepest = DEPTHS.at(-1)!

function hits(t: Target, item: FoundItem): boolean {
  if (t.group === 'pages') return item.url?.includes(t.url_contains) ?? false
  if (t.group === 'files') return item.file?.toLowerCase() === t.file.toLowerCase()
  return item.title.includes(t.title_contains)
}

function rankOf(q: Query, res: SearchResults): number | null {
  let best: number | null = null
  for (const t of q.expect) {
    const i = (res[t.group] as FoundItem[]).findIndex((item) => hits(t, item))
    if (i >= 0 && (best === null || i + 1 < best)) best = i + 1
  }
  return best
}

const reader = Reader.open(dbFile)
reader.warmSearch()
const rows = queries.map((q) => {
  const t = performance.now()
  const res = search(reader, q.query, { perGroup: deepest, match })
  const ms = performance.now() - t
  return { id: q.id, style: q.style, query: q.query, rank: rankOf(q, res), ms: Math.round(ms * 10) / 10, returned: { pages: res.pages.length, files: res.files.length, windows: res.windows.length, hours: res.hours.length } }
})
reader.close()

const recall = (subset: typeof rows) =>
  Object.fromEntries(DEPTHS.map((k) => [`at_${k}`, subset.length ? Math.round((subset.filter((r) => r.rank !== null && r.rank <= k).length / subset.length) * 100) / 100 : null]))
const styles = [...new Set(rows.map((r) => r.style))]
const summary = {
  database: dbFile,
  match,
  queries: rows.length,
  recall: recall(rows),
  by_style: Object.fromEntries(styles.map((s) => [s, { queries: rows.filter((r) => r.style === s).length, ...recall(rows.filter((r) => r.style === s)) }])),
  missed: rows.filter((r) => r.rank === null).map((r) => `${r.id} ${r.query}`),
  latency_ms: (() => {
    const ms = rows.map((r) => r.ms).sort((a, b) => a - b)
    return { p50: ms[Math.floor(ms.length / 2)], p95: ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))], max: ms.at(-1) }
  })(),
}
const out = path.join(folder, `results-${new Date().toISOString().slice(0, 10)}-${match}.json`)
writeFileSync(out, JSON.stringify({ summary, rows }, null, 2) + '\n')
process.stdout.write(JSON.stringify(summary, null, 2) + `\nwritten to ${out}\n`)
