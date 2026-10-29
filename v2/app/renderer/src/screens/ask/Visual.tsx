// What an answer shows under its words, drawn from data code built from the record: the work of the time asked on one
// timeline, or the page, file or window the answer is about. Each part opens the hour or the thing it came from.
import { useState } from 'react'
import type { Piece, Thing, Visual } from '../../../../shared/ai.ts'
import { act } from '../../lib/api.ts'
import { addDays, dateKey, duration, hourLabel, parseKey, shortDay, span } from '../../lib/format.ts'
import { IconButton } from '../../ui/controls.tsx'
import { useToast } from '../../ui/overlays.tsx'
import { AppIcon } from '../../ui/records.tsx'
import { errorText } from '../../ui/status.tsx'

// Three colours stay apart for every kind of colour vision; the rest of the work shares a grey.
const COLOURS = 3

interface Shown {
  label: string
  minutes: number
  stretches: [number, number][]
  hours: number[]
  colour: string
}

const hourStart = (ms: number) => new Date(ms).setMinutes(0, 0, 0)

/** "Today", "Yesterday", else "Tue 27". */
export function dayWord(ms: number): string {
  const day = dateKey(new Date(ms))
  const today = dateKey(new Date())
  if (day === today) return 'Today'
  if (day === addDays(today, -1)) return 'Yesterday'
  return shortDay(day)
}

function shown(pieces: Piece[]): Shown[] {
  const one = (p: Piece, colour: string): Shown => ({
    label: p.label.charAt(0).toUpperCase() + p.label.slice(1),
    minutes: p.minutes,
    stretches: p.stretches.map((x) => [x.from_wall_ms, x.to_wall_ms]),
    hours: p.hours.flatMap((c) => (c.kind === 'hour' ? [c.start_wall_ms] : [])),
    colour,
  })
  const top = pieces.slice(0, pieces.length > COLOURS + 1 ? COLOURS : COLOURS + 1).map((p, i) => one(p, i < COLOURS ? `var(--work-${i + 1})` : 'var(--work-other)'))
  const rest = pieces.slice(top.length)
  if (rest.length === 0) return top
  return [
    ...top,
    {
      label: 'Other',
      minutes: rest.reduce((n, p) => n + p.minutes, 0),
      stretches: rest.flatMap((p) => one(p, '').stretches),
      hours: [...new Set(rest.flatMap((p) => one(p, '').hours))].sort((a, b) => a - b),
      colour: 'var(--work-other)',
    },
  ]
}

// Stretches a minute or less apart draw as one.
function joined(stretches: [number, number][]): [number, number][] {
  const out: [number, number][] = []
  for (const [a, b] of [...stretches].sort((x, y) => x[0] - y[0])) {
    const last = out.at(-1)
    if (last && a - last[1] <= 60_000) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

/** The hours and pages a visual opens, so the chips under the answer leave out only those. */
export function opened(visual: Visual): Set<number | string> {
  if (visual.kind === 'thing') return new Set([hourStart(visual.thing.to_wall_ms - 1), visual.thing.cite.url ?? ''])
  const rows = shown(visual.pieces)
  const oneDay = new Set(rows.flatMap((r) => r.stretches.map((x) => dateKey(new Date(x[0]))))).size === 1
  return new Set([...(oneDay ? rows.flatMap((r) => joined(r.stretches).map(([a]) => hourStart(a))) : []), ...(rows.length > 1 ? rows.map((r) => r.hours[0]!) : [])])
}

export function AnswerVisual({ visual, onOpenHour }: { visual: Visual; onOpenHour: (start: number) => void }) {
  return visual.kind === 'work' ? <WorkCard pieces={visual.pieces} onOpenHour={onOpenHour} /> : <ThingCard thing={visual.thing} onOpenHour={onOpenHour} />
}

function WorkCard({ pieces, onOpenHour }: { pieces: Piece[]; onOpenHour: (start: number) => void }) {
  const [hot, setHot] = useState<number | null>(null)
  const rows = shown(pieces)
  const all = rows.flatMap((r) => r.stretches)
  const first = Math.min(...all.map((x) => x[0]))
  const last = Math.max(...all.map((x) => x[1]))
  const days = [...new Set(all.map((x) => dateKey(new Date(x[0]))))].sort()
  const from = hourStart(first)
  const to = hourStart(last - 1) + 3_600_000
  // One day's hours are on the timeline already, so its caption is the day alone.
  const when = days.length === 1 ? dayWord(first) : days.length === 2 ? `${dayWord(parseKey(days[0]!).getTime())} and ${dayWord(parseKey(days[1]!).getTime()).toLowerCase()}` : `${shortDay(days[0]!)} – ${shortDay(days.at(-1)!)}`
  const total = rows.reduce((n, r) => n + r.minutes, 0)
  const at = (ms: number) => ((ms - from) / (to - from)) * 100
  const ticks = Array.from({ length: (to - from) / 3_600_000 + 1 }, (_, i) => from + i * 3_600_000)
  const every = ticks.length > 9 ? 2 : 1
  const single = rows.length === 1
  return (
    <figure className="ask-card ask-work" aria-label={`${when}: ${rows.map((r) => `${r.label}, ${duration(r.minutes * 60_000)}`).join('; ')}`}>
      <figcaption className="ask-work-head">
        <span className="ask-work-when">{single ? `${rows[0]!.label} · ${when}` : when}</span>
        <span className="ask-work-total">{duration(total * 60_000)}</span>
      </figcaption>
      {days.length === 1 ? (
        <div className="ask-timeline">
          <div className="ask-track">
            {rows.flatMap((r, i) =>
              joined(r.stretches).map(([a, b]) => (
                <span
                  key={`${i}-${a}`}
                  className={`ask-stretch${hot === null ? '' : hot === i ? ' hot' : ' dim'}`}
                  style={{ left: `${at(a)}%`, width: `max(2px, ${at(b) - at(a)}%)`, background: r.colour, animationDelay: `${Math.round(at(a) * 4)}ms` }}
                  title={`${r.label} · ${span(a, b)}`}
                  onClick={() => onOpenHour(hourStart(a))}
                />
              )),
            )}
          </div>
          <div className="ask-ticks" aria-hidden="true">
            {ticks.map((t, i) => (
              <span key={t} style={{ left: `${at(t)}%` }}>
                {i % every === 0 ? hourLabel(t) : ''}
              </span>
            ))}
          </div>
        </div>
      ) : (
        !single && (
          <div className="ask-share">
            {rows.map((r, i) => (
              <span key={i} className={`ask-stretch${hot === null ? '' : hot === i ? ' hot' : ' dim'}`} style={{ flexGrow: r.minutes, background: r.colour }} onClick={() => onOpenHour(r.hours[0]!)} />
            ))}
          </div>
        )
      )}
      {!single && (
        <div className="ask-pieces">
          {rows.map((r, i) => (
            <button type="button" key={i} className="ask-piece" onMouseEnter={() => setHot(i)} onMouseLeave={() => setHot(null)} onFocus={() => setHot(i)} onBlur={() => setHot(null)} onClick={() => onOpenHour(r.hours[0]!)}>
              <span className="ask-swatch" style={{ background: r.colour }} />
              <span className="ask-piece-label">{r.label}</span>
              <span className="ask-piece-time">{duration(r.minutes * 60_000)}</span>
            </button>
          ))}
        </div>
      )}
    </figure>
  )
}

function ThingCard({ thing: t, onOpenHour }: { thing: Thing; onOpenHour: (start: number) => void }) {
  const toast = useToast()
  const c = t.cite
  const site = c.url ? hostOf(c.url) : null
  const open = async () => {
    const r = c.url ? await act({ a: 'open_url', url: c.url }) : await act({ a: 'open_app', id: t.app_id ?? '' })
    if (!r.ok) toast({ text: errorText(r.error), error: true })
  }
  return (
    <div className="ask-card ask-thing">
      <button type="button" className="source-main" onClick={() => void open()}>
        <AppIcon id={t.app_id} size={20} />
        <span className="source-text">
          <span className="source-title">{c.title ?? c.file ?? c.url}</span>
          <span className="source-where">{`${site ?? c.app_name ?? ''} · ${dayWord(t.to_wall_ms)}, ${span(t.from_wall_ms, t.to_wall_ms)}`}</span>
        </span>
      </button>
      <IconButton icon="today" label="Show this hour" onClick={() => onOpenHour(hourStart(t.to_wall_ms - 1))} />
    </div>
  )
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null
  } catch {
    return null
  }
}
