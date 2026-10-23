// Runs candidate writers on a gold day's frozen packets, grades every hour against its frozen checklist, and
// summarizes the numbers per model. Gold data and results live outside the repository, in the gold-day folder.
// Usage:
//   node tools/eval/run.ts --gold <dir> write <candidate>
//   node tools/eval/run.ts --gold <dir> grade <grader> <candidate>
//   node tools/eval/run.ts --gold <dir> sample             (hours to check by hand)
//   node tools/eval/run.ts --gold <dir> summary
// A result is kept only while it was made from the same packet, prompt and previous hour; anything else is written again.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { CODEX_READS_FLAG, claudeCli, cleanEnv, cliScratch, cliWriter, codexCli, factsHour, noAi, type CallResult, type HourWriter, type TextBackend } from '../../engine/backends.ts'
import type { Packet, Ref } from '../../engine/packet.ts'
import { WRITER_PROMPT } from '../../engine/prompt.ts'
import { validateHour, type Validation, type WrittenHour } from '../../engine/validate.ts'
import { parseHours } from '../goldReplay.ts'
import { GRADER_PROMPT, graderMessage, inconsistencies, keySections, parseVerdict, type Checklists, type Grade, type Verdict } from './grade.ts'
import { disagreements, handCheckSample, scoreModel, standings, type HourResult, type ModelScore, type Rate } from './score.ts'

// Codex's base instructions in the first run; kept so its results stay comparable.
const CODEX_BASE = 'You are a helpful assistant.'
const BASELINE = 'no-ai'
const ATTEMPTS = 3

interface Candidate {
  kind: 'claude' | 'codex' | 'none'
  model: string
  effort: string | null
  rate: Rate | null
}

// US dollars per million tokens, standard tier. Anthropic: model pricing table (docs.claude.com, as of 2026-10-06).
// OpenAI: developers.openai.com/api/docs/pricing, read 2026-10-21, short context (up to 272K input tokens).
export const CANDIDATES: Record<string, Candidate> = {
  'haiku-5.5': { kind: 'claude', model: 'claude-haiku-5-5', effort: null, rate: { input: 0.1, output: 0.5 } },
  'sonnet-5.5': { kind: 'claude', model: 'claude-sonnet-5-5', effort: null, rate: { input: 2, output: 10 } },
  'opus-5.5': { kind: 'claude', model: 'claude-opus-5-5', effort: null, rate: { input: 4, output: 20 } },
  'fable-5.1': { kind: 'claude', model: 'claude-fable-5-1', effort: null, rate: { input: 10, output: 50 } },
  'gpt-6-luna': { kind: 'codex', model: 'gpt-6-luna', effort: null, rate: { input: 0.1, output: 0.5 } },
  'gpt-6.1-sol-low': { kind: 'codex', model: 'gpt-6.1-sol', effort: 'low', rate: { input: 2, output: 10 } },
  'no-ai': { kind: 'none', model: 'none', effort: null, rate: null },
}

export const GRADERS: Record<string, Candidate> = {
  'opus-5.5': CANDIDATES['opus-5.5']!,
  'gpt-6.1-sol': { kind: 'codex', model: 'gpt-6.1-sol', effort: 'low', rate: { input: 2, output: 10 } },
}

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')
const hh = (h: number) => String(h).padStart(2, '0')
const readJson = <T>(f: string) => JSON.parse(readFileSync(f, 'utf8')) as T
const writeJson = (f: string, v: unknown) => {
  mkdirSync(path.dirname(f), { recursive: true })
  writeFileSync(f, JSON.stringify(v, null, 1) + '\n')
}

export interface Gold {
  dir: string
  hours: number[]
  manifest: Record<string, string>
  packet(h: number): { packet: Packet; refs: Record<string, Ref>; sha256: string }
  checklists: Checklists
  key: Record<string, string>
}

export function openGold(dir: string): Gold {
  if (!existsSync(path.join(dir, 'gold.json'))) throw new Error(`No gold day at ${dir}`)
  const cfg = readJson<{ hours: string }>(path.join(dir, 'gold.json'))
  const manifest = readJson<Record<string, string>>(path.join(dir, 'MANIFEST.sha256.json'))
  const keyManifest = readJson<Record<string, string>>(path.join(dir, 'key/MANIFEST.sha256.json'))
  const frozen = (rel: string, expected: string | undefined) => {
    const buf = readFileSync(path.join(dir, rel))
    if (sha(buf) !== expected) throw new Error(`${rel} does not match its frozen hash`)
    return buf.toString('utf8')
  }
  const checklists = JSON.parse(frozen('key/checklists-v1.json', keyManifest['checklists-v1.json'])) as Checklists
  const key = keySections(frozen(`key/${checklists.key}`, keyManifest[checklists.key]))
  return {
    dir,
    hours: parseHours(cfg.hours),
    manifest,
    checklists,
    key,
    packet(h) {
      const raw = frozen(`packets/hour_${hh(h)}.json`, manifest[`packets/hour_${hh(h)}.json`])
      const refs = JSON.parse(frozen(`refs/hour_${hh(h)}.json`, manifest[`refs/hour_${hh(h)}.json`])) as Record<string, Ref>
      return { packet: JSON.parse(raw) as Packet, refs, sha256: sha(raw) }
    },
  }
}

// Set from the command line: codex exec runs only when the evaluation was started with CODEX_READS_FLAG.
let codexFileReads = false

function backendFor(c: Candidate, scratch: { cwd: string; instructionsFile: string }): TextBackend {
  if (c.kind === 'claude') return claudeCli(c.model, { cwd: scratch.cwd })
  if (c.kind === 'codex') return codexCli(c.model, c.effort, { cwd: scratch.cwd, instructionsFile: scratch.instructionsFile, allowFileReads: codexFileReads })
  throw new Error('no backend for no-ai')
}

async function withAttempts(call: () => Promise<CallResult>, accept: (r: CallResult) => string | null): Promise<{ final: CallResult; attempts: (CallResult & { problem: string | null })[] }> {
  const attempts: (CallResult & { problem: string | null })[] = []
  for (let i = 0; i < ATTEMPTS; i++) {
    const r = await call()
    const problem = r.error ?? accept(r)
    attempts.push({ ...r, problem })
    if (!problem || r.quota) break
  }
  return { final: attempts.at(-1)!, attempts }
}

function versions(): Record<string, string> {
  const v = (cmd: string) => {
    try {
      return execFileSync(cmd, ['--version'], { env: cleanEnv(), encoding: 'utf8' }).trim()
    } catch (e) {
      return `unavailable: ${(e as Error).message}`
    }
  }
  return { claude: v('claude'), codex: v('codex'), node: process.version }
}

export interface WriteRecord {
  packet_sha256: string
  prompt_sha256: string
  previous_hour: Packet['previous_hour'] | null
  final: CallResult
  validation: Validation | null
}

/**
 * The candidate's own previous hour, as the engine passes it: only an hour that was written and passed validation.
 * When there is none, `missing` says why, so a failed or rejected hour is never dropped from the next one unnoticed.
 */
export function previousHour(h: number, hours: readonly number[], recordOf: (h: number) => WriteRecord | null): { previous: Packet['previous_hour'] | null; missing: string | null } {
  const at = h === 0 ? '23 of the day before' : hh(h - 1)
  if (!hours.includes(h - 1)) return { previous: null, missing: `no packet for hour ${at}` }
  const rec = recordOf(h - 1)
  if (!rec) return { previous: null, missing: `hour ${at} not written yet` }
  if (rec.final.error) return { previous: null, missing: `hour ${at} failed: ${rec.final.error.slice(0, 120)}` }
  const v = rec.validation
  if (!v?.ok || !v.hour) return { previous: null, missing: `hour ${at} was rejected: ${v?.errors.map((e) => e.code).join(', ') || 'no output'}` }
  return { previous: { title: v.hour.title, summary: v.hour.summary }, missing: null }
}

/**
 * The packet the writer gets: the frozen packet with the previous hour added where `buildPacket` adds it. Frozen
 * packets come from a day with no stored hours, so they carry no previous hour, open threads or corrections.
 */
export function writerPacket(frozen: Packet, previous: Packet['previous_hour'] | null): Packet {
  if (frozen.previous_hour || frozen.open_threads || frozen.corrections) throw new Error(`packet ${frozen.hour} already carries context from stored hours`)
  return previous ? { ...frozen, previous_hour: previous } : frozen
}

export function isCurrent(rec: WriteRecord | null, want: { packet_sha256: string; prompt_sha256: string; previous_hour: Packet['previous_hour'] | null }): boolean {
  return (
    rec !== null &&
    !rec.final.error &&
    rec.packet_sha256 === want.packet_sha256 &&
    rec.prompt_sha256 === want.prompt_sha256 &&
    JSON.stringify(rec.previous_hour ?? null) === JSON.stringify(want.previous_hour)
  )
}

async function write(gold: Gold, name: string): Promise<void> {
  const c = CANDIDATES[name]
  if (!c) throw new Error(`unknown candidate ${name}; one of ${Object.keys(CANDIDATES).join(', ')}`)
  const scratch = cliScratch(CODEX_BASE)
  try {
    const writer: HourWriter = c.kind === 'none' ? noAi : cliWriter(backendFor(c, scratch))
    const meta = { candidate: name, ...c, prompt_sha256: sha(WRITER_PROMPT), codex_file_reads: c.kind === 'codex', versions: versions() }
    const outOf = (h: number) => path.join(gold.dir, 'results/writes', name, `hour_${hh(h)}.json`)
    const recordOf = (h: number) => (existsSync(outOf(h)) ? readJson<WriteRecord>(outOf(h)) : null)
    for (const h of [...gold.hours].sort((a, b) => a - b)) {
      const out = outOf(h)
      const { packet: frozen, refs, sha256 } = gold.packet(h)
      const { previous, missing } = previousHour(h, gold.hours, recordOf)
      if (isCurrent(recordOf(h), { packet_sha256: sha256, prompt_sha256: meta.prompt_sha256, previous_hour: previous })) continue
      const packet = writerPacket(frozen, previous)
      const started = new Date().toISOString()
      const { final, attempts } = await withAttempts(() => writer.write(packet), () => null)
      const validation = final.text === null ? null : validateHour(final.text, packet, refs)
      writeJson(out, { ...meta, hour: hh(h), packet_sha256: sha256, previous_hour: previous, previous_hour_missing: missing, started, final, attempts: attempts.map(({ raw: _raw, ...a }) => a), validation })
      console.log(name, hh(h), final.error ? `ERROR ${final.error.slice(0, 200)}` : `ok ${final.latency_ms}ms valid=${validation?.ok}`, missing ? `(no previous hour: ${missing})` : '')
      if (final.quota) {
        console.log(name, 'stopped: usage limit reached')
        return
      }
    }
  } finally {
    scratch.dispose()
  }
}

/**
 * What the person would see for a written hour, which is what is graded: the writer's hour when it passed validation,
 * the facts-only hour when it was rejected (as the engine shows it), and nothing when no output came back.
 */
export function shownHour(rec: { final: CallResult; validation: Validation | null }, packet: Packet): { hour: WrittenHour; fallback: boolean } | null {
  if (rec.final.text === null) return null
  if (rec.validation?.ok && rec.validation.hour) return { hour: rec.validation.hour, fallback: false }
  return { hour: factsHour(packet), fallback: true }
}

interface GradeRecord {
  written?: string
  verdict: Verdict | null
}

/** Which write a grade is of: a rewritten hour needs a new grade. */
export function writeId(rec: { started: string; final: CallResult }): string {
  return sha(`${rec.started}\u0000${rec.final.text ?? rec.final.error ?? ''}`)
}

export function gradeIsCurrent(g: GradeRecord | null, written: string): boolean {
  return g !== null && g.verdict !== null && g.written === written
}

async function grade(gold: Gold, graderName: string, name: string): Promise<void> {
  const g = GRADERS[graderName]
  if (!g) throw new Error(`unknown grader ${graderName}; one of ${Object.keys(GRADERS).join(', ')}`)
  const scratch = cliScratch(CODEX_BASE)
  try {
    const backend = backendFor(g, scratch)
    const meta = { grader: graderName, ...g, codex_file_reads: g.kind === 'codex', candidate: name, grader_prompt_sha256: sha(GRADER_PROMPT), checklists_sha256: sha(JSON.stringify(gold.checklists)), versions: versions() }
    for (const h of gold.hours) {
      const out = path.join(gold.dir, 'results/grades', graderName, name, `hour_${hh(h)}.json`)
      const rec = readJson<WriteRecord & { started: string }>(path.join(gold.dir, 'results/writes', name, `hour_${hh(h)}.json`))
      const written = writeId(rec)
      if (existsSync(out) && gradeIsCurrent(readJson<GradeRecord>(out), written)) continue
      const checklist = gold.checklists.hours[hh(h)]
      if (!checklist) throw new Error(`no checklist for hour ${hh(h)}`)
      const onlyUser = checklist.only_user === true
      const packet = writerPacket(gold.packet(h).packet, rec.previous_hour ?? null)
      const shown = shownHour(rec, packet)
      if (!shown) {
        const verdict: Verdict = { grade: 'wrong', reason: `no hour was written: ${(rec.final.error ?? 'no output').slice(0, 120)}`, must_missed: checklist.must, should_missed: checklist.should, must_not_said: [], unsupported_claims: [], wrong_attribution: [], only_you_stated: [] }
        writeJson(out, { ...meta, hour: hh(h), written, automatic: true, verdict, inconsistencies: [] })
        continue
      }
      const message = graderMessage(gold.checklists.rules, checklist, gold.key[hh(h)] ?? '', packet, shown.hour)
      let verdict: Verdict | null = null
      const { final, attempts } = await withAttempts(
        () => backend.call(message),
        (r) => {
          const p = parseVerdict(r.text ?? '', onlyUser)
          verdict = p.verdict
          return p.error
        },
      )
      writeJson(out, { ...meta, hour: hh(h), written, facts_fallback: shown.fallback, final: { ...final, raw: undefined }, attempts: attempts.length, verdict, inconsistencies: verdict ? inconsistencies(verdict) : [] })
      console.log(graderName, name, hh(h), verdict ? (verdict as Verdict).grade : `ERROR ${final.error ?? attempts.at(-1)?.problem}`)
      if (final.quota) {
        console.log(graderName, 'stopped: usage limit reached')
        return
      }
    }
  } finally {
    scratch.dispose()
  }
}

interface HandCheck {
  grader: string
  candidate: string
  hour: string
  grader_grade: Grade
  my_grade: Grade
  note: string
}

function loadResults(gold: Gold, grader: string, name: string): HourResult[] {
  const hand = existsSync(path.join(gold.dir, 'results/hand-checks.json')) ? readJson<HandCheck[]>(path.join(gold.dir, 'results/hand-checks.json')) : []
  return gold.hours.map((h) => {
    const w = readJson<{ final: CallResult; attempts: unknown[]; validation: Validation | null }>(path.join(gold.dir, 'results/writes', name, `hour_${hh(h)}.json`))
    const gf = path.join(gold.dir, 'results/grades', grader, name, `hour_${hh(h)}.json`)
    const verdict = existsSync(gf) ? readJson<{ verdict: Verdict | null }>(gf).verdict : null
    const hc = hand.find((x) => x.grader === grader && x.candidate === name && x.hour === hh(h))
    return {
      hour: hh(h),
      call: w.final,
      attempts: w.attempts.length,
      validation: w.validation,
      verdict,
      hand: hc && hc.my_grade !== hc.grader_grade ? { grade: hc.my_grade, note: hc.note } : null,
    }
  })
}

function verdictsOf(gold: Gold, grader: string, name: string): Record<string, Verdict | null> {
  const out: Record<string, Verdict | null> = {}
  for (const h of gold.hours) {
    const f = path.join(gold.dir, 'results/grades', grader, name, `hour_${hh(h)}.json`)
    out[hh(h)] = existsSync(f) ? readJson<{ verdict: Verdict | null }>(f).verdict : null
  }
  return out
}

function sample(gold: Gold): void {
  const out: Record<string, string[]> = {}
  for (const name of Object.keys(CANDIDATES)) {
    if (!existsSync(path.join(gold.dir, 'results/grades/opus-5.5', name))) continue
    out[name] = handCheckSample(name, verdictsOf(gold, 'opus-5.5', name), sha)
  }
  console.log(JSON.stringify(out, null, 1))
}

function summary(gold: Gold): void {
  const names = Object.keys(CANDIDATES).filter((n) => existsSync(path.join(gold.dir, 'results/grades/opus-5.5', n)))
  const scores = names.map((n) => scoreModel(n, loadResults(gold, 'opus-5.5', n), CANDIDATES[n]!.rate))
  const { baseline, ranked } = standings(scores, BASELINE)
  const perHour: Record<string, Record<string, Grade | null>> = {}
  for (const n of names) for (const r of loadResults(gold, 'opus-5.5', n)) (perHour[r.hour] ??= {})[n] = r.hand?.grade ?? r.verdict?.grade ?? null
  const second = existsSync(path.join(gold.dir, 'results/grades/gpt-6.1-sol/opus-5.5'))
    ? disagreements(verdictsOf(gold, 'opus-5.5', 'opus-5.5'), verdictsOf(gold, 'gpt-6.1-sol', 'opus-5.5'))
    : null
  writeJson(path.join(gold.dir, 'results/summary.json'), { baseline, ranked, per_hour: perHour, grader_disagreements_on_opus: second })
  const money = (x: number | null) => (x === null ? 'n/a' : `$${x.toFixed(4)}`)
  const row = (s: ModelScore, label: string) =>
    `| ${label} | ${s.grades.right} | ${s.grades.partly} | ${s.grades.wrong} | ${s.grades.only_you} | ${s.unsupported_claims} | ${s.invented_ids} | ${s.wrong_attribution} | ${s.must_missed}/${s.should_missed} | ${s.rejected} | ${money(s.cost_per_call_usd)} | ${s.latency_mean_ms === null ? 'n/a' : (s.latency_mean_ms / 1000).toFixed(1) + ' s'} |`
  console.log('| Model | Right | Partly | Wrong | Only you | Unsupported | Invented IDs | Wrong attribution | Missed (must/should) | Rejected | Cost/call | Mean latency |')
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|')
  ranked.forEach((s, i) => console.log(row(s, `${i + 1}. ${s.model}`)))
  if (baseline) console.log(row(baseline, `${baseline.model} (baseline)`))
  if (second) console.log('\nGrader disagreements on opus-5.5:', JSON.stringify(second))
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ options: { gold: { type: 'string' }, [CODEX_READS_FLAG.slice(2)]: { type: 'boolean' } }, allowPositionals: true })
  if (!values.gold) throw new Error('--gold <dir> is required')
  codexFileReads = values[CODEX_READS_FLAG.slice(2)] === true
  const gold = openGold(values.gold)
  const [cmd, a, b] = positionals
  if (cmd === 'write' && a) await write(gold, a)
  else if (cmd === 'grade' && a && b) await grade(gold, a, b)
  else if (cmd === 'sample') sample(gold)
  else if (cmd === 'summary') summary(gold)
  else throw new Error('usage: write <candidate> | grade <grader> <candidate> | sample | summary')
}
