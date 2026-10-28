// Settings › Recording & privacy.
import { useState } from 'react'
import type { Exclusion } from '../../../../shared/settings.ts'
import type { DeleteWhat, RecordingView, ShellState } from '../../../../shared/types.ts'
import { act, useQuery } from '../../lib/api.ts'
import { addDays, dateKey, dayMonth, parseKey, plainDay, rangeTitle, span } from '../../lib/format.ts'
import { Button } from '../../ui/controls.tsx'
import { Dialog, Popover, useToast } from '../../ui/overlays.tsx'
import { errorText, pauseText, recordingState } from '../../ui/status.tsx'
import { WHAT_GOES_TO_AI } from './AiTab.tsx'
import { Row } from './Row.tsx'

function names(list: string[]): string {
  return list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

function browsersText(rec: RecordingView | null): string {
  const browsers = rec?.browsers ?? []
  if (browsers.length === 0) return 'No Chrome, Edge, Arc, Dia or Firefox history found on this computer.'
  const read = browsers.filter((b) => b.state === 'ok').map((b) => b.name)
  const failed = browsers.filter((b) => b.state !== 'ok').map((b) => b.name)
  return [read.length > 0 ? `Read from ${names(read)}: the pages you opened, never private windows.` : '', failed.length > 0 ? `${names(failed)} couldn’t be read.` : '']
    .filter(Boolean)
    .join(' ')
}

const KEEP: { days: number | null; label: string }[] = [
  { days: 30, label: '1 month' },
  { days: 90, label: '3 months' },
  { days: 180, label: '6 months' },
  { days: 365, label: '1 year' },
  { days: null, label: 'Keep everything' },
]

export function RecordingTab({ shell, rec, onDeleted }: { shell: ShellState | null; rec: RecordingView | null; onDeleted: (text: string) => void }) {
  const { data: privacy } = useQuery({ q: 'privacy' })
  const [keepOpen, setKeepOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const toast = useToast()
  const state = recordingState(shell, rec)
  const run = async (p: Promise<{ ok: boolean; error?: string }>, success?: string) => {
    const r = await p
    if (!r.ok) toast({ text: errorText(r.error ?? 'failed'), error: true })
    else if (success) toast({ text: success })
  }
  const keep = KEEP.find((k) => k.days === (privacy?.retention_days ?? null))
  const today = dateKey(new Date())
  const deletesNow = (days: number | null): string => {
    const first = rec?.first_day
    if (days === null || !first) return ''
    const lastKept = addDays(today, -days)
    if (first >= lastKept) return ''
    return ` · deletes ${rangeTitle(first, addDays(lastKept, -1))} now`
  }
  return (
    <>
      <div className="settings-group">
        <Row
          label="Window titles"
          detail={
            shell?.helper.running === false && state === 'stopped'
              ? 'Daylens isn’t recording right now.'
              : shell?.helper.accessibility === 'denied'
                ? 'Not allowed, so Daylens sees which app is in front but not its windows.'
                : 'Allowed. Daylens notes the app in front and its window title.'
          }
        >
          {state === 'stopped' ? (
            <Button onClick={() => void act({ a: 'restart_capture' })}>
              Restart recording
            </Button>
          ) : (
            shell?.helper.accessibility === 'denied' && (
              <Button onClick={() => void act({ a: 'open_settings_privacy' })}>
                Allow
              </Button>
            )
          )}
        </Row>
        <Row label="Browser history" detail={browsersText(rec)} />
        <Row label="Keep history for" detail="Older days are deleted for good. Shortening this deletes them right away.">
          <div className="settings-anchor">
            <Button onClick={() => setKeepOpen((o) => !o)}>
              {keep?.label ?? `${privacy?.retention_days} days`}
            </Button>
            <Popover open={keepOpen} onClose={() => setKeepOpen(false)}>
              {KEEP.map((k) => (
                <button
                  key={k.label}
                  className="menu-item"
                  aria-current={k.days === (privacy?.retention_days ?? null)}
                  onClick={() => {
                    setKeepOpen(false)
                    void run(act({ a: 'retention', days: k.days }))
                  }}
                >
                  {k.label}
                  {deletesNow(k.days)}
                </button>
              ))}
            </Popover>
          </div>
        </Row>
        <Row label="What goes to AI" detail={WHAT_GOES_TO_AI} />
        <Row label="Private and incognito windows" detail="Never recorded, in every browser." />
      </div>
      <NeverRecord exclusions={privacy?.exclusions ?? []} seen={privacy?.seen_apps ?? []} platform={shell?.platform ?? ''} />
      <div className="settings-group">
        {rec?.pause ? (
          <Row label="Pause" detail={pauseText(rec.pause)}>
            <Button onClick={() => void run(act({ a: 'resume' }), 'Recording again.')}>
              Resume
            </Button>
          </Row>
        ) : (
          <Row label="Pause" detail="Also in the menu bar.">
            <Button onClick={() => void run(act({ a: 'pause', until: 'hour' }))}>
              Pause for 1 hour
            </Button>
          </Row>
        )}
        <Row label="Delete history" detail="Choose a range: the last 10 minutes up to everything.">
          <Button onClick={() => setDeleting(true)}>
            Delete history…
          </Button>
        </Row>
      </div>
      {deleting && (
        <DeleteHistory
          firstDay={rec?.first_day ?? today}
          onClose={() => setDeleting(false)}
          onDone={(text) => {
            setDeleting(false)
            onDeleted(text)
          }}
        />
      )}
    </>
  )
}

function siteOf(text: string): string | null {
  let t = text.trim().toLowerCase()
  t = t.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '').replace(/\.+$/, '')
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(t) ? t : null
}

function NeverRecord({ exclusions, seen, platform }: { exclusions: Exclusion[]; seen: { id: string; name: string }[]; platform: string }) {
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const toast = useToast()
  const defaults = exclusions.filter((e) => e.is_default && (platform === 'win32' || e.match !== 'exe'))
  const own = exclusions.filter((e) => !e.is_default)
  const defaultNames = [...new Set(defaults.map((e) => e.label))]
  const matches = text.trim() ? seen.filter((a) => a.name.toLowerCase().includes(text.trim().toLowerCase()) && !own.some((e) => e.match === 'app_id' && e.value === a.id)).slice(0, 5) : []
  const add = async (pick?: { id: string; name: string }) => {
    const app = pick ?? seen.find((a) => a.name.toLowerCase() === text.trim().toLowerCase())
    const site = app ? null : siteOf(text)
    if (!app && !site) return setProblem('Pick an app from the list, or type a site like example.com.')
    const rule = app ? { match: 'app_id' as const, value: app.id, label: app.name } : { match: 'site' as const, value: site!, label: site! }
    const r = await act({ a: 'exclude', rule })
    if (!r.ok) return toast({ text: errorText(r.error), error: true })
    setAdding(false)
    setText('')
    setProblem(null)
  }
  const removeAll = async (rules: Exclusion[]) => {
    for (const e of rules) {
      const r = await act({ a: 'unexclude', match: e.match, value: e.value })
      if (!r.ok) return toast({ text: errorText(r.error), error: true })
    }
  }
  return (
    <div>
      <h2 className="settings-heading">Never record</h2>
      <div className="settings-card">
        {defaults.length > 0 && (
          <Row label="Password managers" detail={`${defaultNames.join(', ')} · on from the start`}>
            <Button kind="quiet" onClick={() => void removeAll(defaults)}>
              Remove
            </Button>
          </Row>
        )}
        {own.map((e) => (
          <Row key={`${e.match}:${e.value}`} label={e.label} detail={e.match === 'site' ? 'Site' : 'App'}>
            <Button kind="quiet" onClick={() => void removeAll([e])}>
              Remove
            </Button>
          </Row>
        ))}
        {adding ? (
          <div className="settings-adding">
            <div className="settings-add-field">
              <input
                className="field grow"
                autoFocus
                placeholder="An app or a site"
                value={text}
                onChange={(e) => {
                  setText(e.target.value)
                  setProblem(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void add()
                  if (e.key === 'Escape') setAdding(false)
                }}
              />
              <Button kind="primary" onClick={() => void add()} disabled={!text.trim()}>
                Add
              </Button>
              <Button kind="quiet" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
            {matches.map((a) => (
              <button key={a.id} className="menu-item" onClick={() => void add(a)}>
                {a.name}
              </button>
            ))}
            {problem && <span className="settings-problem">{problem}</span>}
          </div>
        ) : (
          <div className="settings-add">
            <Button kind="quiet" onClick={() => setAdding(true)}>
              Add an app or site
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

type Choice = 'ten' | 'hour' | 'day' | 'range' | 'everything'

function DeleteHistory({ firstDay, onClose, onDone }: { firstDay: string; onClose: () => void; onDone: (text: string) => void }) {
  const today = dateKey(new Date())
  const [choice, setChoice] = useState<Choice>('hour')
  const [day, setDay] = useState(today)
  const [from, setFrom] = useState(addDays(today, -1) < firstDay ? today : addDays(today, -1))
  const [to, setTo] = useState(today)
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const now = Date.now()
  const lines: Record<Choice, string> = {
    ten: `Deletes ${span(now - 10 * 60_000, now)} and everything Daylens made from it.`,
    hour: `Deletes ${span(now - 3_600_000, now)} and everything Daylens made from it.`,
    day: `Deletes ${plainDay(day)} and everything Daylens made from it.`,
    range: from <= to ? `Deletes ${rangeTitle(from, to)} and everything Daylens made from those days.` : 'Choose a start before the end.',
    everything: 'Deletes all your history on this computer.',
  }
  const done: Record<Choice, string> = {
    ten: 'Deleted the last 10 minutes.',
    hour: 'Deleted the last hour.',
    day: `Deleted ${dayMonth(day)}.`,
    range: `Deleted ${rangeTitle(from, to)}.`,
    everything: 'Deleted everything.',
  }
  const what = (): DeleteWhat => {
    switch (choice) {
      case 'ten':
        return { kind: 'last', ms: 10 * 60_000 }
      case 'hour':
        return { kind: 'last', ms: 3_600_000 }
      case 'day':
        return { kind: 'range', from_wall_ms: parseKey(day).getTime(), to_wall_ms: parseKey(addDays(day, 1)).getTime() }
      case 'range':
        return { kind: 'range', from_wall_ms: parseKey(from).getTime(), to_wall_ms: parseKey(addDays(to, 1)).getTime() }
      case 'everything':
        return { kind: 'everything' }
    }
  }
  const remove = async () => {
    setBusy(true)
    const r = await act({ a: 'delete', what: what() })
    setBusy(false)
    if (!r.ok) return toast({ text: errorText(r.error), error: true })
    onDone(done[choice])
  }
  const option = (c: Choice, label: string, extra?: React.ReactNode) => (
    <label className="settings-option">
      <input type="radio" name="delete" checked={choice === c} onChange={() => setChoice(c)} />
      <span className="grow">{label}</span>
      {choice === c && extra}
    </label>
  )
  return (
    <Dialog onClose={onClose} label="Delete history">
      <h2>Delete history</h2>
      <div className="settings-options">
        {option('ten', 'The last 10 minutes')}
        {option('hour', 'The last hour')}
        {option('day', 'A day', <input className="date-input" type="date" min={firstDay} max={today} value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />)}
        {option(
          'range',
          'A range',
          <span className="settings-range">
            <input className="date-input" type="date" min={firstDay} max={today} value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
            <span className="faint">to</span>
            <input className="date-input" type="date" min={firstDay} max={today} value={to} onChange={(e) => e.target.value && setTo(e.target.value)} />
          </span>,
        )}
        {option('everything', 'Everything')}
      </div>
      <div className="settings-delete-line">
        {lines[choice]}
      </div>
      <div className="dialog-actions">
        <Button kind="danger" disabled={busy || (choice === 'range' && from > to)} onClick={() => void remove()}>
          Delete
        </Button>
        <Button onClick={onClose} autoFocus>
          Cancel
        </Button>
      </div>
    </Dialog>
  )
}
