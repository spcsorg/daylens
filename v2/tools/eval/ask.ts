// Ask's evaluation: questions about the invented seed day, each asked twice through the real pipeline, every answer
// graded for how a person would want to hear it. Ask changes merge only when every question passes.
// Usage: DAYLENS_TEST_ANTHROPIC_API_KEY=… node tools/eval/ask.ts [--seed <dir> --now <ISO time>] [--only <question number>]
//   [--model <id>] [--effort <level>]
// Prints JSON (every answer, what it cites, a pass or fail per rule) and exits non-zero on any failure.
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { DB_FILE } from '../../capture/store.ts'
import { anthropicClient, type ApiOptions } from '../../engine/backends.ts'
import { anthropicApi, ASK_EFFORT, ASK_MODEL } from '../../retrieval/anthropicApi.ts'
import { ask, type AskResult, type Citation, type Visual } from '../../retrieval/ask.ts'
import { openReadOnly, Reader } from '../../retrieval/reader.ts'

const LIMITS = { maxHours: 12, maxSources: 40, perGroup: 8 }
const REPEATS = 2
const GRADER = 'claude-opus-5-5'

type Kind = 'summary' | 'when' | 'whether' | 'amount'

// The seed's day, 8 AM to 6 PM, the same yesterday with lunch away from 12 to 1. What each question's answer must convey.
export const QUESTIONS: { q: string; kind: Kind; expect: string }[] = [
  { q: 'What did I do this morning?', kind: 'summary', expect: 'Weekend cake orders and deliveries, flour and supplier costs (Mill Lane Flour prices, a supplier price change), the autumn menu draft and proof, and the website order form (the brightside-site dev server, order-form notes, an order form checklist).' },
  { q: 'What did I work on yesterday afternoon?', kind: 'summary', expect: 'October invoicing (the Corner Café invoice, invoices to send, the sent invoice), pickups (schedule and reminders), packaging labels and their wording, the wholesale enquiry and follow-ups, and planning tomorrow’s bakes. Lunch was 12 to 1.' },
  { q: 'What did I get done today?', kind: 'summary', expect: 'A day across orders and deliveries, supplier costs, the autumn menu, the website order form and card payments, October invoices (one sent), pickups, packaging labels, the wholesale enquiry, and planning tomorrow. Only the sent October invoice is shown as finished.' },
  { q: 'Give me a summary of yesterday.', kind: 'summary', expect: 'The same kinds of work as today, 8 AM to 6 PM with lunch away from 12 to 1: orders and deliveries, supplier costs, the autumn menu, the website order form, invoices, pickups, packaging labels, the wholesale enquiry, tomorrow’s bakes.' },
  { q: 'What was I doing after lunch today?', kind: 'summary', expect: 'Today had no recorded lunch break; taking the afternoon from about 1 PM: October invoicing (one invoice sent), then pickups, packaging labels, the wholesale enquiry and follow-ups, and planning tomorrow’s bakes. Treating noon as lunch, or including the 12 to 1 card payment work, is fine.' },
  { q: 'When did I last open the order form?', kind: 'when', expect: 'Today around noon (11:50 AM to 12 PM), in Notes (Order form checklist), right after the order-form notes in TextEdit.' },
  { q: 'When did I last look at the autumn menu?', kind: 'when', expect: 'Today between 10 and 11 AM: the draft in TextEdit, then the proof in Preview until about 11. The same happened yesterday at the same time.' },
  { q: 'When did I send the October invoice?', kind: 'when', expect: 'The sent October invoice was on screen around 1:45 to 2 PM both today and yesterday. A right answer gives about 2 PM today and mentions yesterday too, plainly, without hedging.' },
  { q: 'When did I check the Mill Lane flour prices?', kind: 'when', expect: 'Today around 9:20 to 9:35 AM in Chrome; also yesterday at the same time.' },
  { q: 'Did I reply to the wholesale enquiry?', kind: 'whether', expect: 'The record cannot say whether a reply was sent: it shows the Wholesale enquiry email open around 4 PM and a Wholesale follow-ups list in Reminders, nothing sent.' },
  { q: 'Did I work on the packaging labels today?', kind: 'whether', expect: 'Yes, from about 3 to 4 PM: the labels PDF in Preview and the label wording in TextEdit.' },
  { q: 'Did I look at the website yesterday?', kind: 'whether', expect: 'Yes: the brightside-site project (its dev server) in Terminal around 11 AM; the Mill Lane Flour page around 9:20 and the Corner Café page around 4:10 in Chrome count too. The git log at noon was today only, since yesterday 12 to 1 was lunch.' },
  { q: 'How long did I spend on invoices today?', kind: 'amount', expect: 'About an hour, roughly 1 to 2 PM: the Corner Café invoice, the invoices-to-send list and the sent invoice.' },
  { q: 'What took most of my time today?', kind: 'amount', expect: 'Grouped by work, the website and its order form took the most: about 80 minutes (the dev server, the order-form notes and checklist, the git log), or about two hours counting the card payment questions as part of it; the rest took about an hour each. Saying that, or that time was spread fairly evenly, is right; the two answers must agree.' },
  { q: 'Which supplier was I looking at this morning?', kind: 'whether', expect: 'Mill Lane Flour, its wholesale prices, on screen from about 9:20 to 9:35 AM, alongside a supplier price change email.' },
  { q: 'What was I working on before the pickup schedule today?', kind: 'summary', expect: 'October invoicing, from 1 to 2 PM: the Corner Café invoice and sending the October invoice. Calling it just after lunch is fine.' },
  { q: 'What did I do on the order form?', kind: 'summary', expect: 'Late morning today and yesterday: the order-form notes (about 25 minutes) and its checklist (about 10 minutes), about 35 minutes a day and 70 in all, right after opening the website’s dev server. Nothing shows it finished.' },
  { q: 'What did I plan for tomorrow?', kind: 'summary', expect: 'Around 5 PM: Tomorrow’s bakes in Notes and Thursday in Calendar.' },
]

export interface Grade {
  by_clock_hour: boolean
  lists_windows: boolean
  leads_with_answer: boolean
  correct: boolean
  consistent: boolean
  sounds_like_a_person: boolean
  visual_agrees: boolean
  reason: string
}

const GRADE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['by_clock_hour', 'lists_windows', 'leads_with_answer', 'correct', 'consistent', 'sounds_like_a_person', 'visual_agrees', 'reason'],
  properties: {
    by_clock_hour: { type: 'boolean' },
    lists_windows: { type: 'boolean' },
    leads_with_answer: { type: 'boolean' },
    correct: { type: 'boolean' },
    consistent: { type: 'boolean' },
    sounds_like_a_person: { type: 'boolean' },
    visual_agrees: { type: 'boolean' },
    reason: { type: 'string' },
  },
}

export const ASK_GRADER_PROMPT = `You judge answers from Daylens, an app that records what someone did on their computer and answers questions about it. The bar: the answer reads the way the person would describe their day to their boss in the evening. The input has today’s date, the question, its kind, what a right answer conveys (expect), and the same question's answer from two separate runs, each with the visual shown under it: a card of the pieces of work with their minutes, a card of the pages, files or windows the answer is about, or none.

The seed day repeats: yesterday had the same work at the same times, 8 AM to 6 PM, except that yesterday the computer was away for lunch from 12 to 1, while today 12 to 1 was the site's git log and card payment questions. Mentioning yesterday's matching work is correct, not invented.

Judge each field strictly, true or false:
- by_clock_hour: an answer is organised by clock hour: a run of "From 8 to 9 AM…, from 9 to 10…" chunks, or one statement per hour. Times used only where they help ("just after lunch", "around 4") are fine.
- lists_windows: an answer's substance is window titles, file names or tabs ("the Order list for Saturday tab was active") instead of the work they stand for. A title or file name that is itself the answer, or names what to open, is fine.
- leads_with_answer: the first sentence answers the question: for when, the time; for whether, yes, no or that the record can't tell; for how long or how much, the amount; for a summary, the gist of the work, which for a question about what got done is what was finished, then what moved.
- correct: both answers agree with expect and claim nothing it contradicts. Leaving out minor items is fine; inventing or misdating work is not.
- consistent: the two answers say the same thing in substance (the same time, the same yes or no, the same main pieces of work). Wording may differ.
- sounds_like_a_person: plain, warm and brief, like a colleague who saw the day; not a log, a list of apps, or hedging.
- visual_agrees: each visual agrees with its answer and with expect: a work card's pieces are the work the words describe, with the minutes the words give (a piece the words leave out, or a few minutes' difference, is fine; a piece the words contradict, or work outside the time asked, is not); a card of things shows what the answer is about, at the time it gives. The two runs show the same kind of visual with the same main pieces or things. A summary of a stretch of time (a morning, an afternoon, a day) shows a work card; no visual is fine for a when or whether answer.
reason: one or two sentences on any field that failed, quoting the answer. Empty when all pass.`

// One run of a question as the eval reports it: what the person would read, what each sentence cites, and how many
// sentences the checks left out.
function run(r: AskResult): { text: string; sources: string[][]; visual: string; visual_kind: Visual['kind'] | null; dropped?: number } {
  const cite = (c: Citation) => (c.kind === 'hour' ? `hour ${new Date(c.start_wall_ms).toLocaleString('en-US', { weekday: 'short', hour: 'numeric' })}` : `${c.kind} ${c.title ?? c.file ?? c.url}`)
  const at = (ms: number) => new Date(ms).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })
  const shown = (v: Visual | null) =>
    !v ? 'none'
    : v.kind === 'work' ? `work card: ${v.pieces.map((p) => `${p.label}, ${p.minutes} min, ${at(p.stretches[0]!.from_wall_ms)} to ${at(p.stretches.at(-1)!.to_wall_ms)}`).join('; ')}`
    : `card of things: ${v.things.map((t) => `${t.cite.title ?? t.cite.file ?? t.cite.url} (${t.cite.app_name}), ${at(t.from_wall_ms)} to ${at(t.to_wall_ms)}`).join('; ')}`
  if (r.kind === 'answer') return { text: r.statements.map((s) => s.text).join(' '), sources: r.statements.map((s) => s.cites.map(cite)), visual: shown(r.visual), visual_kind: r.visual?.kind ?? null, dropped: r.dropped }
  if (r.kind === 'no_answer') return { text: r.missing ?? 'Your record doesn’t show that.', sources: [], visual: 'none', visual_kind: null }
  return { text: `(${r.kind})`, sources: [], visual: 'none', visual_kind: null }
}

// An amount shows its work; a summary shows its work or what it is about; a when or whether answer never shows work.
const visualFits = (kind: Kind, runs: { visual_kind: Visual['kind'] | null }[]) =>
  runs.every((x) => (kind === 'amount' ? x.visual_kind === 'work' : kind === 'summary' ? x.visual_kind !== null : x.visual_kind !== 'work'))

// A past 6 PM, so the seeded today runs 8 AM to 6 PM in full and nothing is in the future.
function evalNow(): number {
  const d = new Date()
  d.setHours(18, 0, 0, 0)
  if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1)
  return d.getTime()
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { seed: { type: 'string' }, now: { type: 'string' }, only: { type: 'string' }, effort: { type: 'string', default: ASK_EFFORT }, model: { type: 'string', default: ASK_MODEL } },
  })
  const apiKey = process.env.DAYLENS_TEST_ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('set DAYLENS_TEST_ANTHROPIC_API_KEY')
  if (values.seed && values.now === undefined) throw new Error('--seed needs --now, the time it was seeded as')
  const now = values.now !== undefined ? Date.parse(values.now) : evalNow()
  if (!Number.isFinite(now)) throw new Error('--now must be a time')
  const dir = values.seed ?? mkdtempSync(path.join(os.tmpdir(), 'daylens-ask-eval-'))
  if (!values.seed) execFileSync(process.execPath, [path.join(import.meta.dirname, '../../app/tools/seed.ts'), '--data-dir', dir, '--now', new Date(now).toISOString()], { stdio: 'ignore' })
  const reader = new Reader(openReadOnly(path.join(dir, DB_FILE)))
  const effort = values.effort as ApiOptions['effort']
  const model = anthropicApi(values.model, { apiKey, timeoutMs: 60_000, effort })
  const grader = anthropicClient(GRADER, { apiKey, timeoutMs: 120_000, effort: 'high' })
  const log = { recordRead: () => 1, recordUsage: () => 1 }
  const picked = values.only ? [QUESTIONS[Number(values.only) - 1]!] : QUESTIONS

  const results = await Promise.all(
    picked.map(async (item) => {
      const runs: ReturnType<typeof run>[] = []
      for (let i = 0; i < REPEATS; i++) runs.push(await ask(item.q, { reader, model, log, now: () => now }, LIMITS).then(run, (e: Error) => ({ text: `(error: ${e.message})`, sources: [], visual: 'none', visual_kind: null })))
      const r = await grader({ system: ASK_GRADER_PROMPT, message: JSON.stringify({ today: new Date(now).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }), question: item.q, kind: item.kind, expect: item.expect, answers: runs.map((x) => ({ text: x.text, visual: x.visual })) }), schema: GRADE_SCHEMA })
      const g = JSON.parse(r.text ?? '{}') as Grade
      const fits = visualFits(item.kind, runs)
      const pass = r.error === null && !g.by_clock_hour && !g.lists_windows && g.leads_with_answer && g.correct && g.consistent && g.sounds_like_a_person && g.visual_agrees && fits
      return { question: item.q, kind: item.kind, runs, pass, rules: { ...g, visual_fits: fits }, grader_error: r.error }
    }),
  )
  const passed = results.filter((r) => r.pass).length
  for (const r of results) process.stderr.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.question}${r.pass ? '' : `\n    ${r.rules.visual_fits ? '' : 'visual: wrong kind for the question. '}${r.rules.reason || r.grader_error || ''}`}\n`)
  process.stderr.write(`${passed}/${results.length} pass (${values.model} at ${effort} effort, graded by ${GRADER})\n`)
  process.stdout.write(JSON.stringify({ now: new Date(now).toISOString(), model: values.model, effort, grader: GRADER, passed, total: results.length, results }, null, 1) + '\n')
  process.exitCode = passed === results.length ? 0 : 1
}

if (import.meta.main) await main()
