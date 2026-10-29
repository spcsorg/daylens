// The hour writer's voice evaluation: today's hours of the invented seed day written through the app's own path, each
// checked in code and graded for how a person would want to read it. Writer prompt changes merge only when every hour passes.
// Usage: DAYLENS_TEST_ANTHROPIC_API_KEY=… node tools/eval/hours.ts [--now <ISO time>]
// Prints JSON (every hour as written, a pass or fail per rule) and exits non-zero on any failure.
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { Store } from '../../capture/store.ts'
import { anthropicApi, anthropicClient, textWriter } from '../../engine/backends.ts'
import { HOUR_MODEL, HourWriting, PACKET, RETRY_MS, WRITE_DELAY_MS } from '../../engine/hourWriter.ts'
import { buildPacket } from '../../engine/packet.ts'
import { Storage } from '../../storage/index.ts'

const GRADER = 'claude-opus-5-5'

export interface Grade {
  title_names_work: boolean
  lists_windows: boolean
  minute_by_minute: boolean
  supported: boolean
  sounds_like_a_person: boolean
  reason: string
}

const GRADE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title_names_work', 'lists_windows', 'minute_by_minute', 'supported', 'sounds_like_a_person', 'reason'],
  properties: {
    title_names_work: { type: 'boolean' },
    lists_windows: { type: 'boolean' },
    minute_by_minute: { type: 'boolean' },
    supported: { type: 'boolean' },
    sounds_like_a_person: { type: 'boolean' },
    reason: { type: 'string' },
  },
}

export const HOURS_GRADER_PROMPT = `You judge one hour that Daylens wrote for a person's day, from what their computer recorded. The bar: it reads the way the person would tell a colleague what they got done, about the work, not the windows. The input has the packet (all the writer saw) and the hour as written: its title, summary and detail.

Judge each field strictly, true or false:
- title_names_work: the title names the work in a few words, the way the person would put it in their calendar ("Weekend orders and Saturday's list"), not an app, a window title or a list of them.
- lists_windows: the summary or detail is mostly window titles, file names, tabs or apps ("'Packaging labels.pdf' in Preview") instead of the work they stand for ("the labels"). Naming each piece of work with how long it took is fine, since the packet often shows no more than that; so is quoting one title that is the thing to open.
- minute_by_minute: the detail walks through the hour by clock time ("At 9:05 you…, at 9:20 you…, at 9:40 you…") instead of grouping by the work. One or two times where they help are fine.
- supported: nothing is claimed that the packet doesn't show (a Mail window titled "Sent: …" does show that email had gone out by then): something called finished without a commit, a purpose read into a page title ("reading about X" when only a page called X was open), what someone else did, "most of the hour" or "much of the hour" about something the packet shows for under 30 minutes.
- sounds_like_a_person: plain, warm and brief, speaking to the person as "you"; not a log, an inventory, or hedging.
reason: one or two sentences on any field that failed, quoting the hour. Empty when all pass.`

// A clock time written without AM or PM, or as 24-hour time: the app writes 12-hour times.
const NOT_12_HOUR = /\b(?:[01]?\d|2[0-3]):[0-5]\d\b(?!\s*(?:am|pm|a\.m\.|p\.m\.))/i

// A past 6 PM, so the seeded today runs 8 AM to 6 PM in full.
function evalNow(): number {
  const d = new Date()
  d.setHours(18, 0, 0, 0)
  if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1)
  return d.getTime()
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { now: { type: 'string' } } })
  const apiKey = process.env.DAYLENS_TEST_ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('set DAYLENS_TEST_ANTHROPIC_API_KEY')
  const now = values.now !== undefined ? Date.parse(values.now) : evalNow()
  if (!Number.isFinite(now)) throw new Error('--now must be a time')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'daylens-hours-eval-'))
  execFileSync(process.execPath, [path.join(import.meta.dirname, '../../app/tools/seed.ts'), '--data-dir', dir, '--now', new Date(now).toISOString()], { stdio: 'ignore' })
  const store = new Store(dir)
  const storage = new Storage(store, dir, { deletionStallMs: Infinity })
  const rejected: string[] = []
  // Hours are written as the app writes them: a few minutes after the last one ends, and a rejected hour again later.
  let at = now + WRITE_DELAY_MS
  const hours = new HourWriting(storage, { now: () => at, log: (line) => void (line.includes('rejected') && rejected.push(line)) })
  hours.setWriter(textWriter(anthropicApi(HOUR_MODEL, { apiKey, timeoutMs: 120_000 })))
  for (const wait of [0, ...RETRY_MS]) {
    at += wait
    await hours.run()
  }
  hours.stop()

  const grader = anthropicClient(GRADER, { apiKey, timeoutMs: 120_000, effort: 'high' })
  const day = new Date(now)
  const starts = Array.from({ length: 10 }, (_, i) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 8 + i).getTime())
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const results = await Promise.all(
    starts.map(async (start) => {
      const h = storage.hourAt(start)
      const label = new Date(start).toLocaleTimeString('en-US', { hour: 'numeric' })
      if (h?.status !== 'written') return { hour: label, written: null, pass: false, rules: null, problem: 'not written: every try failed or was rejected' }
      const written = { title: h.title, summary: h.summary, detail: h.detail, outcome: h.outcome }
      const { packet } = buildPacket(storage, { start_wall_ms: start, tz, tz_offset_min: -new Date(start).getTimezoneOffset() }, PACKET)
      const r = await grader({ system: HOURS_GRADER_PROMPT, message: JSON.stringify({ packet, written }), schema: GRADE_SCHEMA })
      const g = JSON.parse(r.text ?? '{}') as Grade
      const twelveHour = !Object.values(written).some((t) => t && NOT_12_HOUR.test(t))
      const pass = r.error === null && twelveHour && g.title_names_work && !g.lists_windows && !g.minute_by_minute && g.supported && g.sounds_like_a_person
      return { hour: label, written, pass, rules: { ...g, twelve_hour: twelveHour }, problem: r.error }
    }),
  )
  storage.stop()
  store.close()
  const passed = results.filter((r) => r.pass).length
  for (const r of results) process.stderr.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.hour} ${r.written?.title ?? ''}${r.pass ? '' : `\n    ${r.rules?.twelve_hour === false ? 'a time not in 12-hour form. ' : ''}${r.rules?.reason || r.problem || ''}`}\n`)
  process.stderr.write(`${passed}/${results.length} pass (${HOUR_MODEL}, graded by ${GRADER}); ${rejected.length} writes rejected by the checks\n`)
  process.stdout.write(JSON.stringify({ now: new Date(now).toISOString(), writer: HOUR_MODEL, grader: GRADER, passed, total: results.length, rejected, results }, null, 1) + '\n')
  process.exitCode = passed === results.length ? 0 : 1
}

if (import.meta.main) await main()
