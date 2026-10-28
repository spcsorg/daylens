import { useEffect, useRef, useState } from 'react'
import type { FoundHour, FoundItem, SearchResults } from '../../../../shared/search.ts'
import { act, query, useQuery } from '../../lib/api.ts'
import { hourLabel, seenAt } from '../../lib/format.ts'
import { Button } from '../../ui/controls.tsx'
import { Icon, Mark } from '../../ui/Icon.tsx'
import { useToast } from '../../ui/overlays.tsx'
import { AppIcon, SearchResult } from '../../ui/records.tsx'
import { errorText } from '../../ui/status.tsx'
import './search.css'

// Each kind (pages, files, windows, hours) shows this many, as Spotlight and Raycast do; docs/experience.md records them.
const FIRST = 5
const MORE = 25

const KIND = { page: 'Page', file: 'File', window: 'Window' } as const

type Row = { key: string; item: FoundItem } | { key: string; hour: FoundHour }

function rows(r: SearchResults): { things: Row[]; hours: Row[] } {
  const things = [...r.pages, ...r.files, ...r.windows].map((item) => ({ key: `${item.kind}|${item.app_id}|${item.url ?? ''}|${item.file ?? ''}|${item.title}`, item }))
  const hours = r.hours.map((hour) => ({ key: `hour|${hour.hour_id}`, hour }))
  return { things, hours }
}

/** Search across every day: what was seen, grouped as people remember it, each result opening the thing itself. */
export function SearchOverlay({ onClose, onOpenHour }: { onClose: () => void; onOpenHour: (startMs: number) => void }) {
  const [text, setText] = useState('')
  const [perGroup, setPerGroup] = useState(FIRST)
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const toast = useToast()
  const typed = text.trim()
  const { data, error, current } = useQuery(typed ? { q: 'search', text: typed, per_group: perGroup } : null, { live: true })
  // Only results for what is typed now can be opened: an earlier search's never stands in while this one loads.
  const results = typed && data && current ? data : null
  const { things, hours } = results ? rows(results) : { things: [], hours: [] }
  const all = [...things, ...hours]

  useEffect(() => {
    input.current?.focus()
    void query({ q: 'search_warm' }).catch(() => {})
  }, [])
  useEffect(() => {
    setActive(0)
    setPerGroup(FIRST)
  }, [typed])

  const open = async (row: Row) => {
    if ('hour' in row) {
      onClose()
      return onOpenHour(row.hour.start_wall_ms)
    }
    const o = row.item.open
    const r = o.kind === 'url' ? await act({ a: 'open_url', url: o.url }) : o.kind === 'app' ? await act({ a: 'open_app', id: o.app_id }) : (onOpenHour(o.hour_start_wall_ms), { ok: true as const })
    if (!r.ok) return toast({ text: errorText(r.error), error: true })
    onClose()
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

  const moreThings = results?.more.some((g) => g !== 'hours') && perGroup === FIRST
  const moreHours = results?.more.includes('hours') && perGroup === FIRST
  const row = (r: Row, i: number) => {
    const name = 'hour' in r ? `${hourLabel(r.hour.start_wall_ms)} · ${r.hour.title ?? r.hour.summary ?? 'Hour'}` : r.item.title
    const sub = 'hour' in r ? `Hour · ${seenAt(r.hour.start_wall_ms).split(',')[0]}` : `${KIND[r.item.kind]} in ${r.item.app_name ?? r.item.app_id} · ${seenAt(Math.max(r.item.last_wall_ms, ...r.item.seen_in.map((h) => h.hour_start_wall_ms)))}`
    return <SearchResult key={r.key} icon={'hour' in r ? <Mark size={20} /> : <AppIcon id={r.item.app_id} size={20} />} title={name} meta={sub} selected={i === active} onHover={() => setActive(i)} onClick={() => void open(r)} />
  }

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="search-panel" role="dialog" aria-label="Search" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="search-field">
          <Icon name="search" />
          <input ref={input} placeholder="Search everything you saw" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} aria-label="Search everything you saw" />
        </div>
        {typed && (error || results) && (
          <div className="search-results">
            {error && <p className="search-note">Search isn’t available right now. Try again in a moment.</p>}
            {results && all.length === 0 && <p className="search-note">Nothing you saw matches “{typed}”.</p>}
            {results?.looser && all.length > 0 && <p className="search-note">Nothing had every word, so these have some of them.</p>}
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
        )}
      </div>
    </div>
  )
}
