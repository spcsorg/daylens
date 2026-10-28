import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { FoundHour, FoundItem, SearchResults } from '../../../../shared/search.ts'
import type { Source } from '../../../../shared/types.ts'
import { act, query, useQuery } from '../../lib/api.ts'
import { clock, hourLabel, seenAt } from '../../lib/format.ts'
import { Button } from '../../ui/controls.tsx'
import { Icon } from '../../ui/Icon.tsx'
import { useToast } from '../../ui/overlays.tsx'
import { AppIcon, SearchResult } from '../../ui/records.tsx'
import { errorText } from '../../ui/status.tsx'
import './search.css'

// Each kind (pages, files, windows, hours) shows this many, as Spotlight and Raycast do; docs/experience.md records them.
const FIRST = 5
const MORE = 25

const KIND = { page: 'Page', file: 'File', window: 'Window' } as const

type Row = { key: string; item: FoundItem } | { key: string; hour: FoundHour } | { key: string; recent: Source }

function rows(r: SearchResults): { things: Row[]; hours: Row[] } {
  const things = [...r.pages, ...r.files, ...r.windows].map((item) => ({ key: `${item.kind}|${item.app_id}|${item.url ?? ''}|${item.file ?? ''}|${item.title}`, item }))
  const hours = r.hours.map((hour) => ({ key: `hour|${hour.hour_id}`, hour }))
  return { things, hours }
}

/** Search across every day: what was seen, grouped as people remember it, each result opening the thing itself. Before
 * anything is typed it offers where you left off, as Raycast and Linear offer recents. */
export function SearchOverlay({ onClose, onOpenHour }: { onClose: () => void; onOpenHour: (startMs: number) => void }) {
  const [text, setText] = useState('')
  const [perGroup, setPerGroup] = useState(FIRST)
  const [active, setActive] = useState(0)
  const [closing, setClosing] = useState(false)
  const [shown, setShown] = useState<SearchResults | null>(null)
  const [highlight, setHighlight] = useState<{ top: number; height: number } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const toast = useToast()
  const typed = text.trim()
  const { data, error, current } = useQuery(typed ? { q: 'search', text: typed, per_group: perGroup } : null, { live: true })
  const { data: leftOff } = useQuery(typed ? null : { q: 'left_off' })
  // Only results for what is typed now can be opened. While the next ones load, the last stay in place, dimmed, so the
  // panel never blanks and jumps on a keystroke.
  const results = typed && data && current ? data : null
  const display = results ?? (typed ? shown : null)
  const stale = display !== null && results === null
  const { things, hours } = display ? rows(display) : { things: [], hours: [] }
  const recents: Row[] = typed ? [] : (leftOff ?? []).map((s) => ({ key: `recent|${s.app.id}|${s.url ?? ''}|${s.title}`, recent: s }))
  const all = typed ? [...things, ...hours] : recents

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    input.current?.focus()
    void query({ q: 'search_warm' }).catch(() => {})
    return () => before?.focus()
  }, [])
  useEffect(() => {
    setActive(0)
    setPerGroup(FIRST)
  }, [typed])
  useEffect(() => {
    if (results || !typed) setShown(results)
  }, [results, typed])
  // One highlight slides between rows instead of each row lighting up on its own.
  useLayoutEffect(() => {
    const el = list.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    setHighlight(el ? { top: el.offsetTop, height: el.offsetHeight } : null)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active, display, leftOff, perGroup])

  const close = () => {
    setClosing(true)
    setTimeout(onClose, 140)
  }

  const open = async (row: Row) => {
    if (stale) return
    if ('hour' in row) {
      close()
      return onOpenHour(row.hour.start_wall_ms)
    }
    if ('recent' in row) {
      const s = row.recent
      const r = s.url ? await act({ a: 'open_url', url: s.url }) : await act({ a: 'open_app', id: s.app.id })
      if (!r.ok) return toast({ text: errorText(r.error), error: true })
      return close()
    }
    const o = row.item.open
    const r = o.kind === 'url' ? await act({ a: 'open_url', url: o.url }) : o.kind === 'app' ? await act({ a: 'open_app', id: o.app_id }) : (onOpenHour(o.hour_start_wall_ms), { ok: true as const })
    if (!r.ok) return toast({ text: errorText(r.error), error: true })
    close()
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' && all.length) {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, all.length - 1))
    } else if (e.key === 'ArrowUp' && all.length) {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter' && all[active]) {
      e.preventDefault()
      void open(all[active]!)
    }
  }

  const moreThings = display?.more.some((g) => g !== 'hours') && perGroup === FIRST
  const moreHours = display?.more.includes('hours') && perGroup === FIRST
  const tile = (icon: ReactNode) => <span className="search-tile">{icon}</span>
  const row = (r: Row, i: number) => {
    const [icon, name, sub] =
      'hour' in r
        ? [tile(<Icon name="today" />), `${hourLabel(r.hour.start_wall_ms)} · ${r.hour.title ?? r.hour.summary ?? 'Hour'}`, `Hour · ${seenAt(r.hour.start_wall_ms).split(',')[0]}`]
        : 'recent' in r
          ? [tile(<AppIcon id={r.recent.app.id} size={20} />), r.recent.title, `${r.recent.site ?? r.recent.app.name} · ${clock(r.recent.last_ms)}`]
          : [tile(<AppIcon id={r.item.app_id} size={20} />), r.item.title, `${KIND[r.item.kind]} in ${r.item.app_name ?? r.item.app_id} · ${seenAt(Math.max(r.item.last_wall_ms, ...r.item.seen_in.map((h) => h.hour_start_wall_ms)))}`]
    return <SearchResult key={r.key} icon={icon} title={name} meta={sub} selected={i === active} onHover={() => setActive(i)} onClick={() => void open(r)} />
  }

  return (
    <div className={`search-scrim${closing ? ' closing' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="search-panel" role="dialog" aria-modal="true" aria-label="Search" onKeyDown={(e) => e.key === 'Escape' && close()}>
        <div className="search-field">
          <Icon name="search" size={20} />
          <input ref={input} placeholder="Search everything you saw" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} aria-label="Search everything you saw" />
        </div>
        <div className={`search-results${stale ? ' stale' : ''}`} ref={list}>
          {highlight && <span className="search-highlight" style={{ transform: `translateY(${highlight.top}px)`, height: highlight.height }} />}
          {!typed && recents.length > 0 && (
            <div className="search-group">
              <h2 className="section-label">Where you left off</h2>
              {recents.map((r, i) => row(r, i))}
            </div>
          )}
          {!typed && leftOff && recents.length === 0 && <p className="search-note">Find any page, file, window or hour from every day Daylens has recorded.</p>}
          {typed && error && <p className="search-note">Search isn’t available right now. Try again in a moment.</p>}
          {results && all.length === 0 && (
            <div className="search-none">
              <p>Nothing you saw matches “{typed}”.</p>
              <p className="search-note">Try fewer words, or the name of a site or app.</p>
            </div>
          )}
          {display?.looser && all.length > 0 && <p className="search-note">Nothing had every word, so these have some of them.</p>}
          {things.length > 0 && (
            <div className="search-group">
              <h2 className="section-label">Pages, files and windows</h2>
              {things.map((r, i) => row(r, i))}
              {moreThings && (
                <Button kind="quiet" className="search-more" onClick={() => setPerGroup(MORE)}>
                  Show more
                </Button>
              )}
            </div>
          )}
          {hours.length > 0 && (
            <div className="search-group">
              <h2 className="section-label">Hours</h2>
              {hours.map((r, i) => row(r, things.length + i))}
              {moreHours && (
                <Button kind="quiet" className="search-more" onClick={() => setPerGroup(MORE)}>
                  Show more
                </Button>
              )}
            </div>
          )}
        </div>
        <div className="search-foot" aria-hidden="true">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>↵</kbd> to open
          </span>
          <span>
            <kbd>esc</kbd> to close
          </span>
        </div>
      </div>
    </div>
  )
}
