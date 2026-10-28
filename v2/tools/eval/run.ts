// Runs candidate writers on a gold day's frozen packets, grades every hour against its frozen checklist, and
// summarizes the numbers per model. Gold data and results live outside the repository, in the gold-day folder.
// Usage:
//   node tools/eval/run.ts --gold <dir> [--packets <dir>] write <candidate>
//   node tools/eval/run.ts --gold <dir> --packets <dir> pin       (records which packets existing results were made on)
//   node tools/eval/run.ts --gold <dir> grade <grader> <candidate>
//   node tools/eval/run.ts --gold <dir> [--grader <grader>] sample             (hours to check by hand)
//   node tools/eval/run.ts --gold <dir> [--grader <grader>] summary
// Writers and graders call the API with the key in DAYLENS_TEST_ANTHROPIC_API_KEY.
// results/run.json names the packets a run is made on (the current ones by default); summary refuses any write or
// grade from other packets, and any hour without a current grade. A result is kept only while it was made from the same packet, prompt and previous hour;
// anything else is written again.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { ANTHROPIC_RATES, anthropicApi, factsHour, noAi, type ApiOptions, type CallResult, type HourWriter, type TextBackend, textWriter } from '../../engine/backends.ts'
import type { Packet, Ref } from '../../engine/packet.ts'
import { WRITER_PROMPT } from '../../engine/prompt.ts'
import { validateHour, type Validation, type WrittenHour } from '../../engine/validate.ts'
import { parseHours } from '../goldReplay.ts'
import { GRADER_PROMPT, graderMessage, inconsistencies, keySections, parseVerdict, type Checklists, type Grade, type Verdict } from './grade.ts'
import { disagreements, handCheckSample, scoreModel, standings, type HourResult, type ModelScore, type Rate } from './score.ts'

const BASELINE = 'no-ai'
// An hour is written once, and a failed call retried once a minute later; then the hour stays as its facts.
export const WRITER_TRIES = { attempts: 2, waitMs: 60_000 }
const GRADER_TRIES = { attempts: 3, waitMs: 0 }

interface Candidate {
  kind: 'api' | 'none'
  model: string
  effort: ApiOptions['effort'] | null
  rate: Rate | null
}

export const CANDIDATES: Record<string, Candidate> = {
  'haiku-5.5-api': { kind: 'api', model: 'claude-haiku-5-5', effort: null, rate: ANTHROPIC_RATES['claude-haiku-5-5']! },
  'sonnet-5.5-api': { kind: 'api', model: 'claude-sonnet-5-5', effort: null, rate: ANTHROPIC_RATES['claude-sonnet-5-5']! },
  'opus-5.5-api': { kind: 'api', model: 'claude-opus-5-5', effort: null, rate: ANTHROPIC_RATES['claude-opus-5-5']! },
  'no-ai': { kind: 'none', model: 'none', effort: null, rate: null },
}

// Graders think hard: a verdict is worth more than its cost.
export const GRADERS: Record<string, Candidate> = {
  'opus-5.5-api': { ...CANDIDATES['opus-5.5-api']!, effort: 'high' },
  'sonnet-5.5-api': { ...CANDIDATES['sonnet-5.5-api']!, effort: 'high' },
}
const DEFAULT_GRADER = 'opus-5.5-api'

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')
const hh = (h: number) => String(h).padStart(2, '0')
const readJson = <T>(f: string) => JSON.parse(readFileSync(f, 'utf8')) as T
const writeJson = (f: string, v: unknown) => {
  mkdirSync(path.dirname(f), { recursive: true })
  writeFileSync(f, JSON.stringify(v, null, 1) + '\n')
}

export interface Gold {
  dir: string
  packetsDir: string
  hours: number[]
  manifest: Record<string, string>
  packet(h: number): { packet: Packet; refs: Record<string, Ref>; sha256: string }
  checklists: Checklists
  key: Record<string, string>
}

/** A gold day, with the packets of one packet version: the current ones ('.') or a kept older version ('packet-v2'). */
export function openGold(dir: string, packetsDir = '.'): Gold {
  if (!existsSync(path.join(dir, 'gold.json'))) throw new Error(`No gold day at ${dir}`)
  const cfg = readJson<{ hours: string }>(path.join(dir, 'gold.json'))
  const manifest = readJson<Record<string, string>>(path.join(dir, packetsDir, 'MANIFEST.sha256.json'))
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
    packetsDir,
    hours: parseHours(cfg.hours),
    manifest,
    checklists,
    key,
    packet(h) {
      const raw = frozen(path.join(packetsDir, `packets/hour_${hh(h)}.json`), manifest[`packets/hour_${hh(h)}.json`])
      const refs = JSON.parse(frozen(path.join(packetsDir, `refs/hour_${hh(h)}.json`), manifest[`refs/hour_${hh(h)}.json`])) as Record<string, Ref>
      return { packet: JSON.parse(raw) as Packet, refs, sha256: sha(raw) }
    },
  }
}

/** Which packets a results folder was made on. Every write and grade in it must come from them. */
export interface RunInfo {
  // Relative to the gold folder: '.' for the current packets, or a kept older version such as 'packet-v2'.
  packets_dir: string
  packet_version: number
  manifest: Record<string, string>
}

const RUN_FILE = 'results/run.json'

export function packetVersion(goldDir: string, packetsDir: string): number {
  if (packetsDir === '.') {
    const v = readJson<{ packet_version?: number }>(path.join(goldDir, 'gold.json')).packet_version
    if (typeof v !== 'number') throw new Error('gold.json has no packet_version')
    return v
  }
  const m = /(?:^|\/)packet-v(\d+)\/?$/.exec(packetsDir)
  if (!m) throw new Error(`${packetsDir} is not a kept packet version (packet-vN)`)
  return Number(m[1])
}

function readRun(goldDir: string): RunInfo | null {
  const f = path.join(goldDir, RUN_FILE)
  return existsSync(f) ? readJson<RunInfo>(f) : null
}

function newRun(goldDir: string, packetsDir: string): RunInfo {
  return { packets_dir: packetsDir, packet_version: packetVersion(goldDir, packetsDir), manifest: readJson<Record<string, string>>(path.join(goldDir, packetsDir, 'MANIFEST.sha256.json')) }
}

/** The packets on disk must be the ones a results folder was made on. */
export function checkPackets(run: RunInfo, manifest: Record<string, string>): void {
  const key = (m: Record<string, string>) => JSON.stringify(Object.entries(m).sort())
  if (key(manifest) !== key(run.manifest)) throw new Error(`the packets in ${run.packets_dir} are not the ones results/ was made on (packet version ${run.packet_version}); nothing is run`)
}

/**
 * Why results cannot be summarized: everything write and grade would make again. Writes made on other packets than
 * the run's, with another writer prompt, or given another previous hour than the candidate's own hour before it gives
 * today; grades of other writes than the ones stored, of another packet or shown hour, made with another grader prompt,
 * checklist, answer key, grader model or effort, without a verdict, or of a failed call graded wrong instead of as its
 * facts; and hours a grader has not graded for a candidate it graded. Only the grader CLI's version may differ.
 */
export function staleResults(
  run: RunInfo,
  writes: { name: string; hour: string; packet_sha256: string; id: string; prompt_sha256: string; previous_hour: Packet['previous_hour'] | null }[],
  grades: (GradeRecord & { grader: string; name: string; hour: string })[],
  hand: readonly HandCheck[],
  hours: readonly string[],
  want: {
    write: (name: string, hour: string) => { prompt_sha256: string; previous_hour: Packet['previous_hour'] | null }
    grade: (grader: string, name: string, hour: string) => Omit<GradeBasis, 'written'> | null
  },
): string[] {
  const out: string[] = []
  const ids = new Map(writes.map((w) => [`${w.name}/${w.hour}`, w.id]))
  for (const w of writes) {
    const at = `writes/${w.name}/hour_${w.hour}`
    const now = want.write(w.name, w.hour)
    if (w.packet_sha256 !== run.manifest[`packets/hour_${w.hour}.json`]) out.push(`${at}: not made on packet version ${run.packet_version}`)
    else if (w.prompt_sha256 !== now.prompt_sha256) out.push(`${at}: written with another writer prompt`)
    else if (JSON.stringify(w.previous_hour ?? null) !== JSON.stringify(now.previous_hour)) out.push(`${at}: given another previous hour than its candidate's hour before it gives today`)
  }
  for (const g of grades) {
    const at = `grades/${g.grader}/${g.name}/hour_${g.hour}`
    const id = ids.get(`${g.name}/${g.hour}`)
    const basis = id ? want.grade(g.grader, g.name, g.hour) : null
    const off = basis ? SUMMARY_KEYS.filter((k) => g[k] !== basis[k]) : []
    if (!id) out.push(`${at}: no write for it`)
    else if (g.written !== id) out.push(`${at}: grades another write`)
    else if (g.automatic) out.push(`${at}: grades a failed call wrong instead of as its facts`)
    else if (!basis) out.push(`${at}: ${g.grader} is not a grader`)
    else if (off.length) out.push(`${at}: not made with the current ${off.join(', ')}`)
    else if (g.verdict === null) out.push(`${at}: the grader gave no verdict`)
    else if (inconsistencies(g.verdict).length && !hand.some((c) => c.grader === g.grader && c.candidate === g.name && c.hour === g.hour && c.written === g.written && c.shown_sha256 === g.shown_sha256)) {
      out.push(`${at}: the verdict contradicts its own findings and has no hand check`)
    }
  }
  // A hand check of an older write is history; one of today's write that judged another shown hour would override a grade it never saw.
  for (const c of hand) {
    if (ids.get(`${c.candidate}/${c.hour}`) !== c.written) continue
    const basis = want.grade(c.grader, c.candidate, c.hour)
    if (basis && c.shown_sha256 !== basis.shown_sha256) out.push(`hand-checks/${c.grader}/${c.candidate}/hour_${c.hour}: judged another hour than the person would see today`)
  }
  for (const pair of new Set(grades.map((g) => `${g.grader}/${g.name}`))) {
    for (const h of hours) if (!grades.some((g) => `${g.grader}/${g.name}` === pair && g.hour === h)) out.push(`grades/${pair}/hour_${h}: not graded`)
  }
  return out
}

function backendFor(c: Candidate): TextBackend {
  if (c.kind === 'none') throw new Error('no backend for no-ai')
  const apiKey = process.env.DAYLENS_TEST_ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('the API needs DAYLENS_TEST_ANTHROPIC_API_KEY')
  return anthropicApi(c.model, { apiKey, timeoutMs: 900_000, ...(c.effort ? { effort: c.effort } : {}) })
}

export async function withAttempts(
  tries: { attempts: number; waitMs: number },
  call: () => Promise<CallResult>,
  accept: (r: CallResult) => string | null,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ final: CallResult; attempts: (CallResult & { problem: string | null })[] }> {
  const attempts: (CallResult & { problem: string | null })[] = []
  for (let i = 0; i < tries.attempts; i++) {
    if (i > 0 && tries.waitMs > 0) await sleep(tries.waitMs)
    const r = await call()
    const problem = r.error ?? accept(r)
    attempts.push({ ...r, problem })
    if (!problem || r.quota) break
  }
  return { final: attempts.at(-1)!, attempts }
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
  const writer: HourWriter = c.kind === 'none' ? noAi : textWriter(backendFor(c))
  const meta = { candidate: name, ...c, prompt_sha256: sha(WRITER_PROMPT), node: process.version }
    const outOf = (h: number) => path.join(gold.dir, 'results/writes', name, `hour_${hh(h)}.json`)
    const recordOf = (h: number) => {
      const rec = existsSync(outOf(h)) ? readJson<WriteRecord>(outOf(h)) : null
      return rec && { ...rec, validation: asShown(gold, h, rec).validation }
    }
    for (const h of [...gold.hours].sort((a, b) => a - b)) {
      const out = outOf(h)
      const { packet: frozen, refs, sha256 } = gold.packet(h)
      const { previous, missing } = previousHour(h, gold.hours, recordOf)
      if (isCurrent(recordOf(h), { packet_sha256: sha256, prompt_sha256: meta.prompt_sha256, previous_hour: previous })) continue
      const packet = writerPacket(frozen, previous)
      const started = new Date().toISOString()
      const { final, attempts } = await withAttempts(WRITER_TRIES, () => writer.write(packet), () => null)
      const validation = final.text === null ? null : validateHour(final.text, packet, refs)
      writeJson(out, { ...meta, hour: hh(h), packet_sha256: sha256, previous_hour: previous, previous_hour_missing: missing, started, final, attempts, validation })
      console.log(name, hh(h), final.error ? `ERROR ${final.error.slice(0, 200)}` : `ok ${final.latency_ms}ms valid=${validation?.ok}`, missing ? `(no previous hour: ${missing})` : '')
      if (final.quota) {
        console.log(name, 'stopped: usage limit reached')
        return
      }
    }
}

/**
 * What the person would see for a written hour, which is what is graded: the writer's hour when it passes today's
 * validator against the packet it was written from, and otherwise the facts-only hour, as the engine shows an hour whose
 * output was rejected or whose call failed. A validation stored with the write may be from an older validator.
 */
export function shownHour(rec: { final: CallResult }, packet: Packet, refs: Record<string, Ref>): { hour: WrittenHour; fallback: boolean; validation: Validation | null } {
  const validation = rec.final.text === null ? null : validateHour(rec.final.text, packet, refs)
  if (validation?.ok && validation.hour) return { hour: validation.hour, fallback: false, validation }
  return { hour: factsHour(packet), fallback: true, validation }
}

/** A stored write as it stands today: the packet it was written from, and what the person would see for it. */
function asShown(gold: Gold, h: number, rec: WriteRecord) {
  const { packet: frozen, refs, sha256 } = gold.packet(h)
  const packet = writerPacket(frozen, rec.previous_hour ?? null)
  return { packet, packet_sha256: sha256, ...shownHour(rec, packet, refs) }
}

export interface GradeBasis {
  // The write graded (writeId), the frozen packet and the hour the grader was given, and everything else that decides a verdict.
  written: string
  packet_sha256: string
  shown_sha256: string
  grader_prompt_sha256: string
  checklists_sha256: string
  key_sha256: string
  model: string
  effort: string | null
}

export interface GradeRecord extends Partial<GradeBasis> {
  verdict: Verdict | null
  // A failed call graded wrong without a grader: stale, since a failed call is graded as its facts.
  automatic?: boolean
}

const SUMMARY_KEYS = ['packet_sha256', 'shown_sha256', 'grader_prompt_sha256', 'checklists_sha256', 'key_sha256', 'model', 'effort'] as const
const BASIS_KEYS = ['written', ...SUMMARY_KEYS] as const

/** What a grade of this write must be made with, apart from the write itself. */
function gradeWant(gold: Gold, g: Candidate, h: number, shown: { packet_sha256: string; hour: WrittenHour }): Omit<GradeBasis, 'written'> {
  return {
    packet_sha256: shown.packet_sha256,
    shown_sha256: sha(JSON.stringify(shown.hour)),
    grader_prompt_sha256: sha(GRADER_PROMPT),
    checklists_sha256: sha(JSON.stringify(gold.checklists)),
    key_sha256: sha(gold.key[hh(h)] ?? ''),
    model: g.model,
    effort: g.effort ?? null,
  }
}

/** Which write a grade is of: a rewritten hour needs a new grade. */
export function writeId(rec: { started: string; final: CallResult }): string {
  return sha(`${rec.started}\u0000${rec.final.text ?? rec.final.error ?? ''}`)
}

/** A stored grade is reused only when it graded this write with the same grader, prompt, checklist and answer key. */
export function gradeIsCurrent(g: GradeRecord | null, want: GradeBasis): boolean {
  return g !== null && g.verdict !== null && !g.automatic && BASIS_KEYS.every((k) => g[k] === want[k])
}

async function grade(gold: Gold, graderName: string, name: string): Promise<void> {
  const g = GRADERS[graderName]
  if (!g) throw new Error(`unknown grader ${graderName}; one of ${Object.keys(GRADERS).join(', ')}`)
  const backend = backendFor(g)
  const meta = { grader: graderName, ...g, candidate: name, node: process.version }
    for (const h of gold.hours) {
      const out = path.join(gold.dir, 'results/grades', graderName, name, `hour_${hh(h)}.json`)
      const rec = readJson<WriteRecord & { started: string }>(path.join(gold.dir, 'results/writes', name, `hour_${hh(h)}.json`))
      const shown = asShown(gold, h, rec)
      if (rec.packet_sha256 !== shown.packet_sha256) throw new Error(`writes/${name}/hour_${hh(h)} was made on other packets than ${gold.packetsDir}; write it again first`)
      const basis: GradeBasis = { written: writeId(rec), ...gradeWant(gold, g, h, shown) }
      if (existsSync(out) && gradeIsCurrent(readJson<GradeRecord>(out), basis)) continue
      const checklist = gold.checklists.hours[hh(h)]
      if (!checklist) throw new Error(`no checklist for hour ${hh(h)}`)
      const onlyUser = checklist.only_user === true
      const packet = shown.packet
      const message = graderMessage(gold.checklists.rules, checklist, gold.key[hh(h)] ?? '', packet, shown.hour)
      let verdict: Verdict | null = null
      const { final, attempts } = await withAttempts(
        GRADER_TRIES,
        () => backend.call(message),
        (r) => {
          const p = parseVerdict(r.text ?? '', onlyUser)
          verdict = p.verdict
          return p.error
        },
      )
      writeJson(out, { ...meta, ...basis, hour: hh(h), facts_fallback: shown.fallback, final, attempts: attempts.length, verdict, inconsistencies: verdict ? inconsistencies(verdict) : [] })
      console.log(graderName, name, hh(h), verdict ? (verdict as Verdict).grade : `ERROR ${final.error ?? attempts.at(-1)?.problem}`)
      if (final.quota) {
        console.log(graderName, 'stopped: usage limit reached')
        return
      }
    }
}

export interface HandCheck {
  grader: string
  candidate: string
  hour: string
  // The write it was made on (writeId) and the hour it judged (shown_sha256), both copied from the grade it checks; it
  // says nothing about any other write, nor about this one once today's validator shows another hour for it.
  written: string
  shown_sha256: string
  grader_grade: Grade
  my_grade: Grade
  note: string
}

/** The grade a hand check of this write and shown hour gives; it decides the hour whatever a later grade says. */
export function handGradeFor(hand: readonly HandCheck[], grader: string, candidate: string, hour: string, written: string, shown: string): HourResult['hand'] {
  const hc = hand.find((x) => x.grader === grader && x.candidate === candidate && x.hour === hour && x.written === written && x.shown_sha256 === shown)
  return hc ? { grade: hc.my_grade, note: hc.note } : null
}

function readHandChecks(gold: Gold): HandCheck[] {
  const f = path.join(gold.dir, 'results/hand-checks.json')
  return existsSync(f) ? readJson<HandCheck[]>(f) : []
}

function loadResults(gold: Gold, grader: string, name: string): HourResult[] {
  const hand = readHandChecks(gold)
  return gold.hours.map((h) => {
    const w = readJson<WriteRecord & { started: string; attempts: HourResult['attempts'] }>(path.join(gold.dir, 'results/writes', name, `hour_${hh(h)}.json`))
    const gf = path.join(gold.dir, 'results/grades', grader, name, `hour_${hh(h)}.json`)
    const verdict = existsSync(gf) ? readJson<{ verdict: Verdict | null }>(gf).verdict : null
    const shown = asShown(gold, h, w)
    return {
      hour: hh(h),
      call: w.final,
      attempts: w.attempts,
      validation: shown.validation,
      verdict,
      hand: handGradeFor(hand, grader, name, hh(h), writeId(w), sha(JSON.stringify(shown.hour))),
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

function sample(gold: Gold, grader: string): void {
  const out: Record<string, string[]> = {}
  for (const name of Object.keys(CANDIDATES)) {
    if (!existsSync(path.join(gold.dir, 'results/grades', grader, name))) continue
    out[name] = handCheckSample(name, verdictsOf(gold, grader, name), sha)
  }
  console.log(JSON.stringify(out, null, 1))
}

function checkRun(gold: Gold, run: RunInfo): void {
  checkPackets(run, gold.manifest)
  const writes: Parameters<typeof staleResults>[1] = []
  const grades: Parameters<typeof staleResults>[2] = []
  const dir = (rel: string) => (existsSync(path.join(gold.dir, rel)) ? readdirSync(path.join(gold.dir, rel)) : [])
  const records = new Map<string, WriteRecord & { started: string }>()
  const recordOf = (name: string, h: number) => {
    const rec = records.get(`${name}/${hh(h)}`)
    return rec ? { ...rec, validation: asShown(gold, h, rec).validation } : null
  }
  for (const name of dir('results/writes')) {
    for (const f of dir(`results/writes/${name}`)) {
      const w = readJson<WriteRecord & { started: string }>(path.join(gold.dir, 'results/writes', name, f))
      records.set(`${name}/${f.slice(5, 7)}`, w)
      writes.push({ name, hour: f.slice(5, 7), packet_sha256: w.packet_sha256, id: writeId(w), prompt_sha256: w.prompt_sha256, previous_hour: w.previous_hour })
    }
  }
  for (const grader of dir('results/grades')) {
    for (const name of dir(`results/grades/${grader}`)) {
      for (const f of dir(`results/grades/${grader}/${name}`)) {
        grades.push({ ...readJson<GradeRecord>(path.join(gold.dir, 'results/grades', grader, name, f)), grader, name, hour: f.slice(5, 7) })
      }
    }
  }
  const stale = staleResults(run, writes, grades, readHandChecks(gold), gold.hours.map(hh), {
    write: (name, hour) => ({ prompt_sha256: sha(WRITER_PROMPT), previous_hour: previousHour(Number(hour), gold.hours, (h) => recordOf(name, h)).previous }),
    grade: (grader, name, hour) => {
      const g = GRADERS[grader]
      const rec = records.get(`${name}/${hour}`)
      return g && rec ? gradeWant(gold, g, Number(hour), asShown(gold, Number(hour), rec)) : null
    },
  })
  if (stale.length) throw new Error(`results/ holds results that write or grade would make again; nothing is summarized:\n${stale.join('\n')}`)
}

function summary(gold: Gold, run: RunInfo, grader: string): void {
  checkRun(gold, run)
  const names = Object.keys(CANDIDATES).filter((n) => existsSync(path.join(gold.dir, 'results/grades', grader, n)))
  const scores = names.map((n) => scoreModel(n, loadResults(gold, grader, n), CANDIDATES[n]!.rate))
  const { baseline, ranked } = standings(scores, BASELINE)
  const perHour: Record<string, Record<string, Grade | null>> = {}
  for (const n of names) for (const r of loadResults(gold, grader, n)) (perHour[r.hour] ??= {})[n] = r.hand?.grade ?? r.verdict?.grade ?? null
  // The other grader's verdicts on the default writer, where it graded it too.
  const other = Object.keys(GRADERS).find((g) => g !== grader && existsSync(path.join(gold.dir, 'results/grades', g, 'opus-5.5-api')))
  const second = other ? disagreements(verdictsOf(gold, grader, 'opus-5.5-api'), verdictsOf(gold, other, 'opus-5.5-api')) : null
  writeJson(path.join(gold.dir, 'results/summary.json'), { run: { packets_dir: run.packets_dir, packet_version: run.packet_version }, grader, baseline, ranked, per_hour: perHour, grader_disagreements_on_opus: second })
  const money = (x: number | null) => (x === null ? 'n/a' : `$${x.toFixed(4)}`)
  const row = (s: ModelScore, label: string) =>
    `| ${label} | ${s.grades.right} | ${s.grades.partly} | ${s.grades.wrong} | ${s.grades.only_you} | ${s.unsupported_claims} | ${s.invented_ids} | ${s.wrong_attribution} | ${s.must_missed}/${s.should_missed} | ${s.rejected} | ${money(s.cost_per_call_usd)} | ${s.latency_mean_ms === null ? 'n/a' : (s.latency_mean_ms / 1000).toFixed(1) + ' s'} |`
  console.log('| Model | Right | Partly | Wrong | Only you | Unsupported | Invented IDs | Wrong attribution | Missed (must/should) | Rejected | Cost/call | Mean latency |')
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|')
  ranked.forEach((s, i) => console.log(row(s, `${i + 1}. ${s.model}`)))
  if (baseline) console.log(row(baseline, `${baseline.model} (baseline)`))
  if (second) console.log(`\nGrader disagreements (${grader} vs ${other}) on opus-5.5-api:`, JSON.stringify(second))
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ options: { gold: { type: 'string' }, packets: { type: 'string' }, grader: { type: 'string', default: DEFAULT_GRADER } }, allowPositionals: true })
  if (!values.gold) throw new Error('--gold <dir> is required')
  if (!GRADERS[values.grader]) throw new Error(`unknown grader ${values.grader}; one of ${Object.keys(GRADERS).join(', ')}`)
  const [cmd, a, b] = positionals
  let run = readRun(values.gold)
  if (run && values.packets && values.packets !== run.packets_dir) throw new Error(`results/ was made on ${run.packets_dir}; move it aside to run on ${values.packets}`)
  if (!run && cmd !== 'write' && cmd !== 'pin') throw new Error(`results/ has no ${path.basename(RUN_FILE)}: pin it to the packets it was made on with pin --packets <dir>`)
  if (!run) {
    run = newRun(values.gold, values.packets ?? '.')
    const gold = openGold(values.gold, run.packets_dir)
    if (cmd === 'pin') checkRun(gold, run)
    writeJson(path.join(values.gold, RUN_FILE), run)
  }
  const gold = openGold(values.gold, run.packets_dir)
  checkPackets(run, gold.manifest)
  if (cmd === 'write' && a) await write(gold, a)
  else if (cmd === 'pin') console.log(`results/ is on ${run.packets_dir}, packet version ${run.packet_version}`)
  else if (cmd === 'grade' && a && b) await grade(gold, a, b)
  else if (cmd === 'sample') sample(gold, values.grader)
  else if (cmd === 'summary') summary(gold, run, values.grader)
  else throw new Error('usage: write <candidate> | pin | grade <grader> <candidate> | sample | summary')
}
