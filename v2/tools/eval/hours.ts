// The hour writer's voice evaluation: today's hours of the invented seed day written through the app's own path, and
// hand-built hours of what went wrong on real days, each checked in code and graded for how a person would want to read it. Writer prompt changes merge only when every hour passes.
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
import { buildPacket, type Packet, type Ref } from '../../engine/packet.ts'
import { validateHour } from '../../engine/validate.ts'
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

export const HOURS_GRADER_PROMPT = `You judge one hour that Daylens wrote for a person's day, from what their computer recorded. The bar: it reads the way the person would tell a colleague what they got done, about the work, not the windows. The input has the packet (all the writer saw) and the hour as written: its title, summary and detail. When it has watch, that names claims the packet can't support for this hour; any of them makes supported false.

Judge each field strictly, true or false:
- title_names_work: the title names the work in a few words, the way the person would put it in their calendar ("Weekend orders and Saturday's list"), not an app, a window title or a list of them.
- lists_windows: the summary or detail is mostly window titles, file names, tabs or apps ("'Packaging labels.pdf' in Preview") instead of the work they stand for ("the labels"). Naming each piece of work with how long it took is fine, since the packet often shows no more than that; so is quoting one title that is the thing to open.
- minute_by_minute: the detail walks through the hour by clock time ("At 9:05 you…, at 9:20 you…, at 9:40 you…") instead of grouping by the work. One or two times where they help are fine.
- supported: nothing is claimed that the packet doesn't show (a Mail window titled "Sent: …" does show that email had gone out by then): something called finished without a commit, a purpose read into a page title ("reading about X" when only a page called X was open), what someone else did, "most of the hour" or "much of the hour" about something the packet shows for under 30 minutes.
- sounds_like_a_person: plain, warm and brief, speaking to the person as "you"; not a log, an inventory, or hedging.
reason: one or two sentences on any field that failed, quoting the hour. Empty when all pass.`

// Hours built by hand for what the seed day never shows, each a way writers went wrong on a real day.
const item = (id: string, app: string, title: string, min: number, from: string, to: string, times = 1) => ({ id, app, title, min, from, to, times })
const empty = { away: [], unknown: [], windows: [], pages: [], agents: [], commits: [], scheduled_events: [] }
export const CASES: { name: string; packet: Packet; watch: string }[] = [
  {
    name: 'settings panes beside a new app',
    watch: 'that permissions were given or granted, that Voicely was set up, installed or configured, or that anything was added to release-plan.md',
    packet: { ...empty, hour: '2026-10-27 15:00-16:00', tz: 'Example/Town', windows: [item('i1', 'TextEdit', 'release-plan.md', 30, '15:00', '15:30'), item('i2', 'Voicely', 'Voicely', 12, '15:30', '15:42'), item('i3', 'System Settings', 'Privacy & Security', 6, '15:42', '15:48'), item('i4', 'System Settings', 'Accessibility', 4, '15:48', '15:52'), item('i5', 'System Settings', 'Screen Recording', 4, '15:52', '15:56'), item('i6', 'Voicely', 'Voicely', 4, '15:56', '16:00')] },
  },
  {
    name: 'pages whose titles suggest a reason',
    watch: 'that the person read about, researched or learned about the firm, applied or prepared for anything, or any reason the pages were open',
    packet: { ...empty, hour: '2026-10-27 18:00-19:00', tz: 'Example/Town', pages: [item('p1', 'Chrome', 'Northwind Capital – Careers', 12, '18:00', '18:12'), item('p2', 'Chrome', 'Northwind Capital – How we trade', 9, '18:12', '18:21'), item('p3', 'Chrome', 'How market makers price options - YouTube', 24, '18:21', '18:45')], windows: [item('i1', 'Notes', 'Questions', 15, '18:45', '19:00')] },
  },
  {
    name: 'an email opened three times in an afternoon hour',
    watch: 'that a reply was sent',
    packet: { ...empty, hour: '2026-10-27 16:00-17:00', tz: 'Example/Town', windows: [item('i1', 'Figma', 'Booth layout v3', 42, '16:00', '17:00', 4), item('i2', 'Mail', 'Re: Booth layout', 6, '16:21', '16:41', 3), item('i3', 'Slack', 'events-team', 12, '16:41', '16:53')] },
  },
  {
    name: 'locked for the rest of the hour',
    watch: 'any work after 10:18 PM, or that the person finished the chapter',
    packet: { ...empty, hour: '2026-10-27 22:00-23:00', tz: 'Example/Town', away: [{ id: 'w1', from: '22:18', to: '23:00', why: 'screen locked' }], windows: [item('i1', 'TextEdit', 'chapter-4.md', 18, '22:00', '22:18')] },
  },
]

// As the app does, a rejected hour is written again, twice; after that it stays as its facts.
async function writeCase(packet: Packet, write: (p: Packet) => Promise<{ text: string | null }>): Promise<{ hour: ReturnType<typeof validateHour>['hour']; rejected: string[] }> {
  const refs = Object.fromEntries([...packet.windows, ...packet.pages, ...packet.away].map((x, i): [string, Ref] => [x.id, 'why' in x ? { kind: 'away' } : { kind: 'observations', ids: [i + 1] }]))
  const rejected: string[] = []
  for (let i = 0; i < 1 + RETRY_MS.length; i++) {
    const r = await write(packet)
    const v = r.text === null ? null : validateHour(r.text, packet, refs)
    if (v?.ok) return { hour: v.hour, rejected }
    rejected.push(`codes=${v?.errors.map((e) => e.code).join(',') ?? 'call_failed'}`)
  }
  return { hour: null, rejected }
}

// A clock time written without AM or PM, or as 24-hour time: the app writes 12-hour times. A list may share one AM or
// PM at its end ("4:21, 4:30 and 4:39 PM").
const twelveHour = (text: string) =>
  [...text.matchAll(/\b(\d{1,2}):[0-5]\d\b(\s*(?:am|pm|a\.m\.|p\.m\.))?/gi)].every(
    (m) => Number(m[1]) >= 1 && Number(m[1]) <= 12 && !m[1]!.startsWith('0') && (!!m[2] || /^[^.!?;]*?\d\s*(?:am|pm|a\.m\.|p\.m\.)/i.test(text.slice(m.index! + m[0].length))),
  )

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
  const grade = async (label: string, packet: Packet, written: Record<string, string | null>, watch?: string) => {
    const r = await grader({ system: HOURS_GRADER_PROMPT, message: JSON.stringify({ packet, written, ...(watch ? { watch } : {}) }), schema: GRADE_SCHEMA })
    const g = JSON.parse(r.text ?? '{}') as Grade
    const twelve = Object.values(written).every((t) => !t || twelveHour(t))
    const pass = r.error === null && twelve && g.title_names_work && !g.lists_windows && !g.minute_by_minute && g.supported && g.sounds_like_a_person
    return { hour: label, written, pass, rules: { ...g, twelve_hour: twelve }, problem: r.error }
  }
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
      return grade(label, packet, written)
    }),
  )
  storage.stop()
  store.close()
  const writer = textWriter(anthropicApi(HOUR_MODEL, { apiKey, timeoutMs: 120_000 }))
  results.push(
    ...(await Promise.all(
      CASES.map(async (c) => {
        const w = await writeCase(c.packet, (p) => writer.write(p))
        rejected.push(...w.rejected.map((x) => `${c.name}: ${x}`))
        if (!w.hour) return { hour: c.name, written: null, pass: false, rules: null, problem: 'not written: every try was rejected' }
        return grade(c.name, c.packet, { title: w.hour.title, summary: w.hour.summary, detail: w.hour.detail, outcome: w.hour.outcome }, c.watch)
      }),
    )),
  )
  const passed = results.filter((r) => r.pass).length
  for (const r of results) process.stderr.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.hour} ${r.written?.title ?? ''}${r.pass ? '' : `\n    ${r.rules?.twelve_hour === false ? 'a time not in 12-hour form. ' : ''}${r.rules?.reason || r.problem || ''}`}\n`)
  process.stderr.write(`${passed}/${results.length} pass (${HOUR_MODEL}, graded by ${GRADER}); ${rejected.length} writes rejected by the checks\n`)
  process.stdout.write(JSON.stringify({ now: new Date(now).toISOString(), writer: HOUR_MODEL, grader: GRADER, passed, total: results.length, rejected, results }, null, 1) + '\n')
  process.exitCode = passed === results.length ? 0 : 1
}

if (import.meta.main) await main()
