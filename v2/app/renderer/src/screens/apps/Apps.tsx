import { useLayoutEffect, useState } from 'react'
import type { AppDetail, AppsView } from '../../../../shared/apps.ts'
import { useQuery } from '../../lib/api.ts'
import { addDays, dateKey, dayMonth, duration, hoursList, longDay, parseKey, plainDay, rangeTitle, shortDay, span, weekStart } from '../../lib/format.ts'
import { CalendarPicker } from '../../ui/CalendarPicker.tsx'
import { Button, IconButton, Segmented } from '../../ui/controls.tsx'
import { Icon } from '../../ui/Icon.tsx'
import { Popover } from '../../ui/overlays.tsx'
import { AppIcon, AppRow, RemoveDialog, SourceRow, type RemoveTarget } from '../../ui/records.tsx'
import { EmptyState } from '../../ui/status.tsx'
import './apps.css'

export interface AppsNav {
  date: string
  scope: 'day' | 'week'
  app: string | null
}

export function Apps({ nav, setNav, firstDay, onMark }: { nav: AppsNav; setNav: (n: AppsNav) => void; firstDay: string | null; onMark: (name: string) => void }) {
  const [picker, setPicker] = useState(false)
  const today = dateKey(new Date())
  const from = nav.scope === 'day' ? nav.date : weekStart(nav.date)
  const days = nav.scope === 'day' ? 1 : 7
  const { data } = useQuery({ q: 'apps', from, days }, { live: from <= today && addDays(from, days) > today })
  const view: AppsView | null = data && data.from === from && data.days === days ? data : null
  const selected = nav.app && view?.apps.some((a) => a.id === nav.app) ? nav.app : (view?.apps[0]?.id ?? null)
  useLayoutEffect(() => {
    if (view) onMark('apps_painted')
  }, [view, onMark])
  const step = (n: number) => setNav({ ...nav, date: addDays(from, n * days) > today ? today : addDays(from, n * days) })
  const prevDisabled = firstDay === null || from <= firstDay
  const nextDisabled = addDays(from, days) > today
  const live = from <= today && addDays(from, days) > today
  const title = nav.scope === 'day' ? longDay(from) : rangeTitle(from, addDays(from, 6))
  const when = nav.scope === 'day' ? dayMonth(from) : rangeTitle(from, addDays(from, 6))
  return (
    <>
      <div className="header">
        <div className="grow">
          <h1 className="title">{title}</h1>
          <div className="subline">{view ? `${duration(view.total_ms)} recorded${nav.scope === 'week' && live ? ' so far' : ''}` : ' '}</div>
        </div>
        <Segmented
          label="Show"
          value={nav.scope}
          options={[
            { value: 'day', label: 'Day' },
            { value: 'week', label: 'Week' },
          ]}
          onChange={(scope) => setNav({ ...nav, scope })}
        />
        <div className="apps-steps">
          <IconButton icon="chevron-left" label={nav.scope === 'day' ? 'Previous day' : 'Previous week'} disabled={prevDisabled} onClick={() => step(-1)} />
          <IconButton icon="chevron-right" label={nav.scope === 'day' ? 'Next day' : 'Next week'} disabled={nextDisabled} onClick={() => step(1)} />
        </div>
        <div className="apps-picker">
          <IconButton icon="calendar" label="Pick a day" onClick={() => setPicker((p) => !p)} />
          <Popover open={picker} onClose={() => setPicker(false)}>
            <CalendarPicker
              selected={nav.date}
              today={today}
              onPick={(d) => {
                setPicker(false)
                setNav({ ...nav, date: d })
              }}
            />
          </Popover>
        </div>
      </div>
      <div className="scroll">
        {view && nav.scope === 'week' && <WeekBars view={view} />}
        {view && view.apps.length === 0 && <EmptyState>{from === today ? 'Apps appear here as you use them.' : 'Nothing was recorded then.'}</EmptyState>}
        {view && view.apps.length > 0 && (
          <div className="apps-layout">
            <div className="apps-list">
              {view.apps.map((a) => (
                <AppRow key={a.id} app={a} selected={a.id === selected} onClick={() => setNav({ ...nav, app: a.id })} />
              ))}
            </div>
            {selected && <Detail id={selected} from={from} days={days} when={when} live={live} />}
          </div>
        )}
      </div>
    </>
  )
}

function WeekBars({ view }: { view: AppsView }) {
  const max = Math.max(1, ...view.per_day.map((d) => d.total_ms))
  return (
    <div className="bars" role="img" aria-label="Time recorded each day">
      {view.per_day.map((d) => (
        <div className="bar" key={d.date}>
          {d.total_ms > 0 ? (
            <>
              <span>{duration(d.total_ms)}</span>
              <span className="fill" style={{ height: `${Math.max(4, (d.total_ms / max) * 60)}px` }} />
            </>
          ) : (
            <span className="none" />
          )}
          <span className="day">{shortDay(d.date).split(' ')[0]}</span>
        </div>
      ))}
    </div>
  )
}

function Detail({ id, from, days, when, live }: { id: string; from: string; days: number; when: string; live: boolean }) {
  const { data } = useQuery({ q: 'app', id, from, days }, { live })
  const [filter, setFilter] = useState('')
  const [remove, setRemove] = useState<RemoveTarget | null>(null)
  const d: AppDetail | null = data && data.app.id === id ? data : null
  if (!d) return <div className="app-detail" />
  const line =
    days === 1
      ? `${duration(d.app.ms)} on ${plainDay(from)}, ${d.hours.length > 4 ? `across ${d.hours.length} hours` : `in the ${hoursList(d.hours)} ${d.hours.length === 1 ? 'hour' : 'hours'}`}`
      : `${duration(d.app.ms)} this week: ${d.per_day.map((p) => `${duration(p.ms)} on ${plainDay(p.date)}`).join(', ')}`
  const lo = parseKey(from).getTime()
  const hi = parseKey(addDays(from, days)).getTime()
  const shown = filter ? d.sources.filter((s) => s.title.toLowerCase().includes(filter.toLowerCase()) || (s.url ?? '').toLowerCase().includes(filter.toLowerCase())) : d.sources
  const sub = (s: AppDetail['sources'][number]) =>
    days === 1 ? `${s.kind === 'page' ? 'Page' : `Window in ${d.app.name}`} · ${span(s.first_ms, s.last_ms)}` : `${s.kind === 'page' ? 'Page' : `Window in ${d.app.name}`} · ${[...new Set([dateKey(new Date(s.first_ms)), dateKey(new Date(s.last_ms))])].map((k) => shortDay(k)).join(' and ')}`
  return (
    <div className="app-detail">
      <div className="app-head">
        <AppIcon id={d.app.id} size={28} />
        <div className="grow">
          <h2 className="app-name">{d.app.name}</h2>
          <p className="app-line">{line}</p>
        </div>
        <Button
          onClick={() =>
            setRemove({
              name: d.app.name,
              when,
              what: { kind: 'app', app_id: d.app.id, from_wall_ms: lo, to_wall_ms: hi },
              never: { match: 'app_id', value: d.app.id, label: d.app.name, text: `Never record ${d.app.name} again` },
            })
          }
        >
          Remove from {when}
        </Button>
      </div>
      {d.browser && d.sources.length > 0 && (
        <label className="apps-filter">
          <Icon name="search" />
          <input placeholder={`Search pages in ${d.app.name}`} value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
      )}
      {d.sources.length > 0 ? (
        <div>
          {!d.browser && <h3 className="section-label">Windows</h3>}
          {shown.map((s) => (
            <SourceRow key={`${s.url ?? ''}|${s.title}`} s={s} date={from} sub={sub(s)} range={{ from: lo, to: hi, when }} />
          ))}
        </div>
      ) : (
        <p className="muted">{d.browser ? 'Daylens can’t see pages in this browser yet.' : 'This app had no window titles.'}</p>
      )}
      {remove && <RemoveDialog target={remove} onClose={() => setRemove(null)} />}
    </div>
  )
}
