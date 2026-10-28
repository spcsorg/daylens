import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MonthView, WeekView } from '../../../../shared/today.ts'
import type { DayView, GapReason, HourRow, RecordingView, ShellState } from '../../../../shared/types.ts'
import { useQuery } from '../../lib/api.ts'
import { addDays, addMonths, clock, dateKey, duration, factsTitle, hourLabel, longDay, monthOf, monthTitle, parseKey, rangeTitle, shortDay, weekStart } from '../../lib/format.ts'
import { CalendarPicker } from '../../ui/CalendarPicker.tsx'
import { Button, IconButton, Segmented } from '../../ui/controls.tsx'
import { Popover } from '../../ui/overlays.tsx'
import { AppIcon, Hour, SourceRow, WeekBlock, type HourKind } from '../../ui/records.tsx'
import { EmptyState, StatusNotice } from '../../ui/status.tsx'
import './today.css'

export type Scope = 'day' | 'week' | 'month'

export interface TodayNav {
  date: string
  scope: Scope
  openHour: number | null
  // Set by each jump from elsewhere (Search), so jumping to the same hour again scrolls to it again.
  jump?: number
}

const GAP_TEXT: Record<GapReason, string> = {
  asleep: 'Your computer was asleep',
  locked: 'Your screen was locked',
  idle: 'Away from the computer',
  paused: 'Paused',
  excluded: 'Only apps you keep out were in use',
  not_running: 'Daylens wasn’t running',
  stopped: 'Daylens stopped recording',
  nothing: 'Nothing recorded',
}

function factsSummary(h: HourRow, rec: RecordingView | null): string {
  if (h.current) return h.recorded_until_ms ? `Recorded until ${clock(h.recorded_until_ms)}.` : rec?.pause ? 'Paused.' : 'Recording now.'
  return h.facts.titles.slice(0, 2).join(', ')
}

export function Today({ nav, setNav, shell, rec, onMark }: { nav: TodayNav; setNav: (n: TodayNav) => void; shell: ShellState | null; rec: RecordingView | null; onMark: (name: string) => void }) {
  const [picker, setPicker] = useState(false)
  const today = dateKey(new Date())
  const { date, scope } = nav
  const first = rec?.first_day ?? null
  const step = (n: number) => {
    const next = scope === 'day' ? addDays(date, n) : scope === 'week' ? addDays(weekStart(date), 7 * n) : `${addMonths(monthOf(date), n)}-01`
    setNav({ date: next > today ? today : next, scope, openHour: null })
  }
  const prevDisabled = first === null || (scope === 'day' ? date <= first : scope === 'week' ? weekStart(date) <= first : monthOf(date) <= monthOf(first))
  const nextDisabled = scope === 'day' ? date >= today : scope === 'week' ? weekStart(date) >= weekStart(today) : monthOf(date) >= monthOf(today)
  const ws = weekStart(date)
  const title = scope === 'day' ? longDay(date) : scope === 'week' ? rangeTitle(ws, addDays(ws, 6)) : monthTitle(monthOf(date))
  const unit = scope === 'day' ? 'day' : scope
  return (
    <>
      <div className="header">
        <h1 className="title grow">{title}</h1>
        <Segmented
          label="Show"
          value={scope}
          options={[
            { value: 'day', label: 'Day' },
            { value: 'week', label: 'Week' },
            { value: 'month', label: 'Month' },
          ]}
          onChange={(s) => setNav({ date, scope: s, openHour: null })}
        />
        <div className="today-steps">
          <IconButton icon="chevron-left" label={`Previous ${unit}`} disabled={prevDisabled} onClick={() => step(-1)} />
          <IconButton icon="chevron-right" label={`Next ${unit}`} disabled={nextDisabled} onClick={() => step(1)} />
        </div>
        <div className="today-picker">
          <IconButton icon="calendar" label="Pick a day" onClick={() => setPicker((p) => !p)} />
          <Popover open={picker} onClose={() => setPicker(false)}>
            <CalendarPicker
              selected={date}
              today={today}
              onPick={(d) => {
                setPicker(false)
                setNav({ date: d, scope, openHour: null })
              }}
            />
          </Popover>
        </div>
      </div>
      <div className="today-notice">
        <StatusNotice shell={shell} rec={rec} />
      </div>
      {scope === 'day' && <DayList nav={nav} setNav={setNav} rec={rec} onMark={onMark} />}
      {scope === 'week' && <WeekGrid start={ws} setNav={setNav} onMark={onMark} />}
      {scope === 'month' && <MonthGrid month={monthOf(date)} setNav={setNav} onMark={onMark} />}
    </>
  )
}

function DayList({ nav, setNav, rec, onMark }: { nav: TodayNav; setNav: (n: TodayNav) => void; rec: RecordingView | null; onMark: (name: string) => void }) {
  const { data } = useQuery({ q: 'day', date: nav.date }, { live: true })
  const scroller = useRef<HTMLDivElement>(null)
  const scrolledFor = useRef<string | null>(null)
  const day = data && data.date === nav.date ? data : null
  useLayoutEffect(() => {
    if (!day) return
    onMark('day_painted')
    const target = `${day.date}|${nav.openHour}|${nav.jump ?? ''}`
    if (scrolledFor.current === target) return
    scrolledFor.current = target
    scroller.current?.querySelector<HTMLElement>(nav.openHour !== null ? `[data-hour="${nav.openHour}"]` : '[data-current="true"]')?.scrollIntoView({ block: nav.openHour !== null ? 'nearest' : 'center' })
  }, [day, nav.openHour, nav.jump, onMark])
  return (
    <div className="scroll today-day" ref={scroller}>
      {day && day.hours.length === 0 && <EmptyState>{day.date === day.today ? 'Hours appear here as you work.' : 'Nothing was recorded on this day.'}</EmptyState>}
      {day?.hours.map((h) => (
        <HourItem
          key={h.start_ms}
          h={h}
          day={day}
          rec={rec}
          open={nav.openHour === h.start_ms}
          onToggle={() => setNav({ ...nav, openHour: nav.openHour === h.start_ms ? null : h.start_ms })}
          onMark={onMark}
        />
      ))}
      {day && day.date === day.today && day.hours.length > 0 && <LeftOff date={day.date} />}
    </div>
  )
}

function LeftOff({ date }: { date: string }) {
  const { data } = useQuery({ q: 'left_off' }, { live: true })
  if (!data || data.length === 0) return null
  return (
    <section className="left-off">
      <h2 className="left-off-title">Where you left off</h2>
      {data.map((s) => (
        <SourceRow key={`${s.app.id}|${s.url ?? ''}|${s.title}`} s={s} date={date} sub={`${s.site ?? s.app.name} · ${clock(s.last_ms)}`} />
      ))}
    </section>
  )
}

function kindOf(h: HourRow): HourKind {
  if (h.gap) return 'gap'
  if (h.current) return 'current'
  if (h.from_history) return 'filled'
  return h.title !== null ? 'written' : 'facts'
}

function HourItem({ h, day, rec, open, onToggle, onMark }: { h: HourRow; day: DayView; rec: RecordingView | null; open: boolean; onToggle: () => void; onMark: (name: string) => void }) {
  const kind = kindOf(h)
  if (kind === 'gap') return <Hour start={h.start_ms} kind="gap" title={GAP_TEXT[h.gap!]} />
  const note = h.from_history ? 'From browser history, with less detail' : h.edited ? 'Edited' : null
  return (
    <>
      <Hour start={h.start_ms} kind={kind} title={h.title ?? (factsTitle(h) || 'No apps recorded')} summary={h.summary ?? factsSummary(h, rec)} apps={h.facts.apps} note={note} open={open} onToggle={onToggle} />
      {open && <HourOpen start={h.start_ms} day={day} onMark={onMark} />}
    </>
  )
}

function HourOpen({ start, day, onMark }: { start: number; day: DayView; onMark: (name: string) => void }) {
  const { data } = useQuery({ q: 'hour', start_ms: start }, { live: true })
  const detail = data && data.start_ms === start ? data : null
  useLayoutEffect(() => {
    if (detail) onMark('hour_painted')
  }, [detail, onMark])
  if (!detail) return <div className="hour-open" />
  return (
    <div className="hour-open">
      {detail.detail && <p>{detail.detail}</p>}
      {detail.sources.length > 0 ? (
        <div>
          {detail.sources.map((s) => (
            <SourceRow key={`${s.app.id}|${s.url ?? ''}|${s.title}`} s={s} date={day.date} />
          ))}
        </div>
      ) : (
        <p className="muted">Nothing left in this hour.</p>
      )}
      <div>
        <Button disabled title="Coming soon">
          Fix this hour
        </Button>
      </div>
    </div>
  )
}

function ByApp({ apps }: { apps: { id: string; name: string; ms: number }[] }) {
  if (apps.length === 0) return null
  return (
    <div className="totals">
      <h2 className="section-label">Time by app</h2>
      {apps.map((a) => (
        <div className="total-row" key={a.id}>
          <AppIcon id={a.id} size={16} />
          <span className="grow">{a.name}</span>
          <span className="ms">{duration(a.ms)}</span>
        </div>
      ))}
    </div>
  )
}

function WeekGrid({ start, setNav, onMark }: { start: string; setNav: (n: TodayNav) => void; onMark: (name: string) => void }) {
  const { data } = useQuery({ q: 'week', start }, { live: true })
  const week: WeekView | null = data && data.start === start ? data : null
  useLayoutEffect(() => {
    if (week) onMark('week_painted')
  }, [week, onMark])
  if (!week) return <div className="scroll" />
  const hours = week.days.flatMap((d) => d.blocks.map((b) => new Date(b.start_ms).getHours()))
  if (hours.length === 0)
    return (
      <div className="scroll">
        {start <= week.today && <EmptyState>Nothing was recorded this week.</EmptyState>}
      </div>
    )
  const lo = Math.min(...hours)
  const hi = Math.max(...hours)
  const rows = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)
  return (
    <div className="scroll">
      <div className="week">
        <span />
        {week.days.map((d) => (
          <button key={d.date} className={`week-head${d.date === week.today ? ' today' : ''}`} disabled={d.date > week.today} onClick={() => setNav({ date: d.date, scope: 'day', openHour: null })}>
            {shortDay(d.date).split(' ')[0]}
            <span className="n">{parseKey(d.date).getDate()}</span>
            <span className="faint">{d.total_ms ? duration(d.total_ms) : '\u00a0'}</span>
          </button>
        ))}
        {rows.map((h) => (
          <WeekRow key={h} hour={h} week={week} setNav={setNav} />
        ))}
      </div>
      <ByApp apps={week.apps} />
    </div>
  )
}

function WeekRow({ hour, week, setNav }: { hour: number; week: WeekView; setNav: (n: TodayNav) => void }) {
  return (
    <>
      <div className="week-hour">{hourLabel(new Date(2000, 0, 1, hour).getTime())}</div>
      {week.days.map((d) => {
        const b = d.blocks.find((x) => new Date(x.start_ms).getHours() === hour)
        return (
          <div className="week-cell" key={d.date}>
            {b && <WeekBlock title={b.title} current={d.date === week.today && hour === new Date().getHours()} onClick={() => setNav({ date: d.date, scope: 'day', openHour: b.start_ms })} />}
          </div>
        )
      })}
    </>
  )
}

function MonthGrid({ month, setNav, onMark }: { month: string; setNav: (n: TodayNav) => void; onMark: (name: string) => void }) {
  const { data } = useQuery({ q: 'month', month }, { live: true })
  const view: MonthView | null = data && data.month === month ? data : null
  useEffect(() => {
    if (view) onMark('month_painted')
  }, [view, onMark])
  if (!view) return <div className="scroll" />
  const lead = (parseKey(`${month}-01`).getDay() + 6) % 7
  return (
    <div className="scroll">
      <div className="month-head">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <span key={d} className="month-dow">
            {d}
          </span>
        ))}
      </div>
      <div className="month">
        {Array.from({ length: lead }, (_, i) => (
          <div key={`e${i}`} className="month-day outside" />
        ))}
        {view.days.map((d) => (
          <button key={d.date} className={`month-day${d.date === view.today ? ' today' : ''}`} disabled={d.date > view.today} onClick={() => setNav({ date: d.date, scope: 'day', openHour: null })}>
            <span className="n">{parseKey(d.date).getDate()}</span>
            {d.total_ms > 0 && <span className="t">{duration(d.total_ms)}</span>}
            {d.apps.slice(0, 2).map((a) => (
              <span key={a.id} className="w">
                {a.name}
              </span>
            ))}
          </button>
        ))}
      </div>
      <ByApp apps={view.apps} />
    </div>
  )
}
