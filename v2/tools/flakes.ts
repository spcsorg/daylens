// Counts failing tests across the nightly runs' TAP files and files one `flake` issue per failing test.
// Usage: node tools/flakes.ts <dir of <runner>-<n>.tap files> --runs <expected> [--issues]
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

const RESULT = /^( *)not ok \d+ - (.*)$/
const SUBTEST = /^( *)# Subtest: (.*)$/
const UNESCAPE: Record<string, string> = { n: '\n', t: '\t', r: '\r', f: '\f', b: '\b', v: '\v' }
// Suites that failed through a child, and children cancelled by a failed parent, repeat a failure named elsewhere.
const ECHOES = new Set(['subtestsFailed', 'cancelledByParent'])

const unescape = (s: string) => s.replace(/\\(.)/g, (_, c: string) => UNESCAPE[c] ?? c)

// The repo-relative test file of a `location: '<path>:<line>:<col>'` on any OS.
function fileOf(location: string): string {
  const p = location.replace(/''/g, "'").replace(/[\\/]+/g, '/').replace(/:\d+:\d+$/, '')
  const at = p.indexOf('/tests/')
  return at < 0 ? p : p.slice(at + 1)
}

export function failedTests(tap: string): { names: string[]; finished: boolean } {
  const lines = tap.split(/\r?\n/)
  const parents: string[] = []
  const names = new Set<string>()
  let finished = false
  lines.forEach((line, i) => {
    if (/^1\.\.\d+$/.test(line)) finished = true
    const sub = SUBTEST.exec(line)
    if (sub) {
      parents.length = sub[1]!.length / 4
      parents.push(unescape(sub[2]!))
      return
    }
    const res = RESULT.exec(line)
    if (!res) return
    const [, indent, desc] = res as unknown as [string, string, string]
    const m = /^((?:\\.|[^\\#])*?) ?(?:# (TODO|SKIP)\b.*)?$/.exec(desc)
    if (m?.[2]) return
    const name = unescape(m ? m[1]! : desc)
    const fields: Record<string, string> = {}
    const key = new RegExp(`^${indent}  (location|failureType): '(.*)'$`)
    for (let j = i + 1; j < lines.length && lines[j] !== `${indent}  ...`; j++) {
      const k = key.exec(lines[j]!)
      if (k) fields[k[1]!] ??= k[2]!
    }
    if (ECHOES.has(fields.failureType ?? '')) return
    const parts = [...parents.slice(0, indent.length / 4), name]
    const file = fields.location && fileOf(fields.location)
    if (file && !(parts.length === 1 && name.replace(/\\/g, '/') === file)) parts.unshift(file)
    names.add(parts.join(' > '))
  })
  return { names: [...names], finished }
}

export interface Report {
  runs: number
  failed: number
  tests: { name: string; count: number; runners: Record<string, number> }[]
  unfinished: string[]
}

export function report(dir: string, runs: number): Report {
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.tap')).sort() : []
  const tests = new Map<string, Record<string, number>>()
  const unfinished: string[] = []
  let failed = 0
  for (const f of files) {
    const [, runner = f, n = '?'] = /^(.*)-(\d+)\.tap$/.exec(f) ?? []
    const r = failedTests(readFileSync(path.join(dir, f), 'utf8'))
    if (!r.finished) unfinished.push(`${runner} run ${n}`)
    if (!r.finished || r.names.length) failed++
    for (const name of r.names) {
      const by = tests.get(name) ?? {}
      by[runner] = (by[runner] ?? 0) + 1
      tests.set(name, by)
    }
  }
  const missing = runs - files.length
  if (missing > 0) unfinished.push(`${missing} run${missing === 1 ? '' : 's'} left no results`)
  return {
    runs,
    failed: failed + Math.max(missing, 0),
    tests: [...tests]
      .map(([name, runners]) => ({ name, count: Object.values(runners).reduce((a, b) => a + b, 0), runners }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    unfinished,
  }
}

const runnersText = (runners: Record<string, number>) => Object.entries(runners).map(([r, n]) => `${r} (${n})`).join(', ')
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/\n/g, ' ')

export function summary(r: Report): string {
  const runs = `${r.runs} run${r.runs === 1 ? '' : 's'}`
  if (!r.failed) return `## Nightly tests\n\n${runs}, all passed.\n`
  const out = ['## Nightly tests', '', `${runs}, ${r.failed} failed.`, '']
  if (r.tests.length) {
    out.push('| Test | Failed runs | Runners |', '| --- | ---: | --- |')
    for (const t of r.tests) out.push(`| ${cell(t.name)} | ${t.count} | ${runnersText(t.runners)} |`)
    out.push('')
  }
  if (r.unfinished.length) out.push(`Did not finish: ${r.unfinished.join(', ')}.`, '')
  return out.join('\n')
}

export async function fileIssues(r: Report, gh: { repo: string; token: string; runUrl: string }, fetchImpl: typeof fetch = fetch): Promise<void> {
  const call = async (method: string, route: string, body?: unknown, allow404 = false) => {
    const res = await fetchImpl(`https://api.github.com${route}`, {
      method,
      headers: { authorization: `Bearer ${gh.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok && !(allow404 && res.status === 404)) throw new Error(`${method} ${route}: ${res.status}`)
    return res
  }
  const repo = `/repos/${gh.repo}`
  if ((await call('GET', `${repo}/labels/flake`, undefined, true)).status === 404) await call('POST', `${repo}/labels`, { name: 'flake', color: 'd93f0b' })
  const open = new Map<string, number>()
  for (let page = 1; ; page++) {
    const batch = (await (await call('GET', `${repo}/issues?labels=flake&state=open&per_page=100&page=${page}`)).json()) as { number: number; title: string; pull_request?: unknown }[]
    for (const i of batch) if (!i.pull_request) open.set(i.title, i.number)
    if (batch.length < 100) break
  }
  for (const t of r.tests) {
    const body = `Failed in ${t.count} of ${r.runs} nightly runs: ${runnersText(t.runners)}. ${gh.runUrl}`
    const number = open.get(t.name)
    if (number) await call('POST', `${repo}/issues/${number}/comments`, { body })
    else await call('POST', `${repo}/issues`, { title: t.name, body, labels: ['flake'] })
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { runs: { type: 'string' }, issues: { type: 'boolean' } } })
  const runs = Number(values.runs)
  if (positionals.length !== 1 || !Number.isInteger(runs) || runs < 1) throw new Error('usage: node tools/flakes.ts <dir> --runs <n> [--issues]')
  const r = report(positionals[0]!, runs)
  process.stdout.write(summary(r))
  if (values.issues && r.tests.length) {
    const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID } = process.env
    if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) throw new Error('--issues needs GITHUB_TOKEN and GITHUB_REPOSITORY')
    await fileIssues(r, { repo: GITHUB_REPOSITORY, token: GITHUB_TOKEN, runUrl: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` })
  }
  process.exitCode = r.failed ? 1 : 0
}
