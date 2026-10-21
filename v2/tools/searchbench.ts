// Search latency on a large database (storagebench's year): warm, on a new connection, and with nothing in the system's
// file cache, the last both before and after the reader warms the search index.
// Usage: node tools/searchbench.ts --db <daylens-v2.sqlite> --per-group <n> [--rounds 40] [--cold 8]
// The file-cache-cold runs need macOS: each opens a fresh APFS clone of the file, whose pages nothing has read yet.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { Reader } from '../retrieval/reader.ts'
import { search } from '../retrieval/search.ts'

const { values } = parseArgs({ options: { db: { type: 'string' }, 'per-group': { type: 'string' }, rounds: { type: 'string', default: '40' }, cold: { type: 'string', default: '8' } } })
if (!values.db || !values['per-group']) throw new Error('--db <file> --per-group <n>')
const file = path.resolve(values.db)
const perGroup = Number(values['per-group'])
const ROUNDS = Number(values.rounds)
const COLD = Number(values.cold)

const probe = Reader.open(file)
const pick = (sql: string) => (probe.db.prepare(sql).pluck().get() as string | undefined) ?? 'none'
// A file name and a site that occur often, so the query has many matches.
const queries: Record<string, string> = {
  common_word: 'billing',
  two_words: 'onboarding funnel',
  prefix_3: 'mig',
  person: 'Keza',
  rare_words: 'mortgage dentist',
  file_name: pick(`SELECT files FROM search_docs WHERE files != '' AND instr(files, ' ') = 0 GROUP BY files ORDER BY count(*) DESC LIMIT 1`),
  site: pick(`SELECT site FROM search_docs WHERE site IS NOT NULL GROUP BY site ORDER BY count(*) DESC LIMIT 1`),
  no_match: 'zzzqqq',
  one_letter: 'b',
}
const counts = {
  search_docs: probe.db.prepare('SELECT count(*) FROM search_docs').pluck().get() as number,
  intervals: probe.db.prepare('SELECT count(*) FROM intervals').pluck().get() as number,
  hours: probe.db.prepare('SELECT count(*) FROM hours').pluck().get() as number,
}
probe.close()

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}
const round = (x: number) => Math.round(x * 10) / 10
const stats = (xs: number[]) => ({ n: xs.length, p50_ms: round(pct(xs, 50)), p95_ms: round(pct(xs, 95)), max_ms: round(Math.max(...xs)) })
const timed = (reader: Reader, q: string) => {
  const t = performance.now()
  search(reader, q, { perGroup })
  return performance.now() - t
}

// Warm: one long-lived reader, each query run once untimed, then ROUNDS times.
const warm: Record<string, ReturnType<typeof stats>> = {}
const warmAll: number[] = []
{
  const reader = Reader.open(file)
  for (const [k, q] of Object.entries(queries)) {
    timed(reader, q)
    const xs = Array.from({ length: ROUNDS }, () => timed(reader, q))
    warm[k] = stats(xs)
    if (k !== 'one_letter') warmAll.push(...xs)
  }
  reader.close()
}

// New connection: the file is in the system's cache, SQLite's own cache is empty.
const connAll: number[] = []
for (let i = 0; i < Math.max(1, Math.floor(ROUNDS / 4)); i++) {
  for (const [k, q] of Object.entries(queries)) {
    if (k === 'one_letter') continue
    const reader = Reader.open(file)
    connAll.push(timed(reader, q))
    reader.close()
  }
}

// Nothing cached: each sample a fresh clone, one query, rotating through the list.
function coldRuns(warmFirst: boolean) {
  const xs: number[] = []
  const warmMs: number[] = []
  const list = Object.entries(queries).filter(([k]) => k !== 'one_letter' && k !== 'no_match')
  for (let i = 0; i < COLD; i++) {
    const dir = mkdtempSync(path.join(path.dirname(file), '.searchbench-'))
    try {
      const clone = path.join(dir, path.basename(file))
      execFileSync('cp', ['-c', file, clone])
      if (existsSync(`${file}-wal`)) execFileSync('cp', ['-c', `${file}-wal`, `${clone}-wal`])
      const reader = Reader.open(clone)
      if (warmFirst) {
        const t = performance.now()
        reader.warmSearch()
        warmMs.push(performance.now() - t)
      }
      xs.push(timed(reader, list[i % list.length]![1]))
      reader.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  return { first_query: stats(xs), ...(warmFirst ? { warm_search: stats(warmMs) } : {}) }
}
const fileCold = os.platform() === 'darwin' ? { without_warm: coldRuns(false), after_warm: coldRuns(true) } : 'needs APFS clones (macOS)'

const result = {
  database: { file, size_mb: round(statSync(file).size / 1048576), ...counts },
  per_group: perGroup,
  queries,
  warm,
  warm_typical: stats(warmAll),
  new_connection_typical: stats(connAll),
  file_cache_cold: fileCold,
  load_average: os.loadavg().map(round),
}
process.stdout.write(JSON.stringify(result, null, 2) + '\n')
