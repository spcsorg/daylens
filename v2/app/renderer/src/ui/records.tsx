// The V4 rows that show the record: an hour, a week block, an app, a search result, a window or page.
import { useRef, useState, type ReactNode } from 'react'
import type { AppTime, DeleteWhat, Source } from '../../../shared/types.ts'
import { act } from '../lib/api.ts'
import { addDays, clock, dayMonth, duration, hourLabel, parseKey, span } from '../lib/format.ts'
import { Button, Checkbox, IconButton } from './controls.tsx'
import { Dialog, Popover, useToast } from './overlays.tsx'
import { errorText } from './status.tsx'

export function AppIcon({ id, size = 20 }: { id: string | null; size?: number }) {
  const [failed, setFailed] = useState(false)
  if (!id || failed) return <span className="app-icon blank" style={{ width: size, height: size }} />
  return <img className="app-icon" width={size} height={size} src={`daylens-icon://app/${encodeURIComponent(id)}`} alt="" onError={() => setFailed(true)} />
}

/** Text that writes itself in when it changes after it first appeared, as when an hour goes from facts to written. */
function Written({ text }: { text: string }) {
  const first = useRef(text)
  if (text === first.current) return text
  return (
    <span className="write" key={text}>
      <span className="write-text">{text}</span>
    </span>
  )
}

export type HourKind = 'written' | 'facts' | 'current' | 'gap' | 'filled'

/** One hour of the day: its time, a title, a line under it and the apps it was spent in. A gap is one quiet line, and
 * `time` names the range when it covers several hours. An hour from browser history shows its browser in its note. */
export function Hour({ start, time, kind, title, summary, apps = [], note, open, onToggle }: { start: number; time?: string; kind: HourKind; title: string; summary?: string | null; apps?: AppTime[]; note?: string | null; open?: boolean; onToggle?: () => void }) {
  if (kind === 'gap')
    return (
      <div className="hour gap" data-hour={start}>
        <span className="hour-time">{time ?? hourLabel(start)}</span>
        <span className="hour-title">{title}</span>
      </div>
    )
  return (
    <button type="button" className={`hour ${kind}`} data-hour={start} data-current={kind === 'current'} aria-expanded={open} onClick={onToggle}>
      <span className="hour-time">{hourLabel(start)}</span>
      <span className="hour-body">
        <span className="hour-title">
          <Written text={title} />
        </span>
        {summary && <span className="hour-summary">{summary}</span>}
        {apps.length > 0 && kind !== 'filled' && (
          <span className="hour-apps">
            {apps.map((a) => (
              <span key={a.id} title={`${a.name} · ${duration(a.ms)}`}>
                <AppIcon id={a.id} size={16} />
              </span>
            ))}
          </span>
        )}
        {note && (
          <span className="hour-note">
            {kind === 'filled' && apps.map((a) => <AppIcon key={a.id} id={a.id} size={14} />)}
            {note}
          </span>
        )}
      </span>
    </button>
  )
}

export function WeekBlock({ title, current, onClick }: { title: string; current?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`week-block${current ? ' current' : ''}`} title={title} onClick={onClick}>
      {title}
    </button>
  )
}

export function AppRow({ app, detail, selected, onClick }: { app: AppTime; detail?: string; selected?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="app-row" aria-current={selected} onClick={onClick}>
      <AppIcon id={app.id} size={24} />
      <span className="app-row-text">
        <span className="app-row-name">{app.name}</span>
        {detail && <span className="app-row-detail">{detail}</span>}
      </span>
      <span className="app-row-ms">{duration(app.ms)}</span>
    </button>
  )
}

export function SearchResult({ icon, title, meta, hour, selected, onHover, onClick }: { icon: ReactNode; title: string; meta: string; hour?: string; selected: boolean; onHover: () => void; onClick: () => void }) {
  return (
    <button type="button" className="search-result" aria-selected={selected} onMouseMove={onHover} onClick={onClick}>
      {icon}
      <span className="search-result-text">
        <span className="search-result-title">{title}</span>
        <span className="search-result-meta">{meta}</span>
        {hour && <span className="search-result-hour">{hour}</span>}
      </span>
    </button>
  )
}

export interface RemoveTarget {
  // What the question names: "Cursor", "this site".
  name: string
  // "5 March", "4–10 March".
  when: string
  what: DeleteWhat
  never: { match: 'app_id' | 'site'; value: string; label: string; text: string }
}

/** Removing an app or a site from a day or a week, optionally never recording it again. */
export function RemoveDialog({ target, onClose }: { target: RemoveTarget; onClose: () => void }) {
  const [never, setNever] = useState(false)
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const remove = async () => {
    setBusy(true)
    const r = await act({ a: 'delete', what: target.what, ...(never ? { never: { match: target.never.match, value: target.never.value, label: target.never.label } } : {}) })
    setBusy(false)
    if (!r.ok) return toast({ text: errorText(r.error), error: true })
    onClose()
    toast({ text: `Removed ${target.name} from ${target.when}.` })
  }
  return (
    <Dialog onClose={onClose} label="Remove">
      <p>
        Remove {target.name} from {target.when}? Everything Daylens recorded from {target.name === 'this site' ? 'it' : target.name} {target.when.includes('–') ? 'those days' : 'that day'} is deleted from this computer.
      </p>
      <Checkbox checked={never} onChange={setNever}>
        {target.never.text}
      </Checkbox>
      <div className="dialog-actions">
        <Button kind="danger" onClick={() => void remove()} disabled={busy}>
          Remove
        </Button>
        <Button onClick={onClose} autoFocus>
          Cancel
        </Button>
      </div>
    </Dialog>
  )
}

/** A window or page: opens the thing itself; its menu keeps it out or removes it from the day. */
export function SourceRow({ s, date, sub, range }: { s: Source; date: string; sub?: string; range?: { from: number; to: number; when: string } }) {
  const [menu, setMenu] = useState(false)
  const [remove, setRemove] = useState<RemoveTarget | null>(null)
  const toast = useToast()
  const open = async () => {
    const r = s.url ? await act({ a: 'open_url', url: s.url }) : await act({ a: 'open_app', id: s.app.id })
    if (!r.ok) toast({ text: errorText(r.error), error: true })
  }
  const isPage = s.kind !== 'window' && s.site !== null
  const never = isPage
    ? { match: 'site' as const, value: s.site!, label: s.site!, text: 'Never record this site again' }
    : { match: 'app_id' as const, value: s.app.id, label: s.app.name, text: `Never record ${s.app.name} again` }
  const from = range?.from ?? parseKey(date).getTime()
  const to = range?.to ?? parseKey(addDays(date, 1)).getTime()
  const when = range?.when ?? dayMonth(date)
  const target: RemoveTarget = isPage
    ? { name: 'this site', when, what: { kind: 'site', site: s.site!, from_wall_ms: from, to_wall_ms: to }, never }
    : { name: s.app.name, when, what: { kind: 'app', app_id: s.app.id, from_wall_ms: from, to_wall_ms: to }, never }
  const neverNow = async () => {
    setMenu(false)
    const r = await act({ a: 'exclude', rule: { match: never.match, value: never.value, label: never.label } })
    toast(r.ok ? { text: `Daylens won’t record ${isPage ? s.site : s.app.name} from now on.` } : { text: errorText(r.error), error: true })
  }
  const where = sub ?? (s.kind === 'visit' ? `Opened in ${s.app.name} · ${clock(s.first_ms)}` : `${isPage ? s.site : s.app.name} · ${span(s.first_ms, s.last_ms)}`)
  return (
    <div className={`source-row${menu ? ' menu-open' : ''}`}>
      <button type="button" className="source-main" onClick={() => void open()}>
        <AppIcon id={s.app.id} size={18} />
        <span className="source-text">
          <span className="source-title">{s.title}</span>
          <span className="source-where">{where}</span>
        </span>
        {s.ms > 0 && <span className="source-ms">{duration(s.ms)}</span>}
      </button>
      <div className="source-more">
        <IconButton icon="more" label="More" onClick={() => setMenu((m) => !m)} />
        <Popover open={menu} onClose={() => setMenu(false)}>
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setMenu(false)
              void open()
            }}
          >
            Open in {s.app.name}
          </button>
          <button type="button" className="menu-item" onClick={() => void neverNow()}>
            {isPage ? 'Never record this site' : `Never record ${s.app.name}`}
          </button>
          <div className="menu-sep" />
          <button
            type="button"
            className="menu-item danger"
            onClick={() => {
              setMenu(false)
              setRemove(target)
            }}
          >
            Remove from {when}
          </button>
        </Popover>
      </div>
      {remove && <RemoveDialog target={remove} onClose={() => setRemove(null)} />}
    </div>
  )
}
