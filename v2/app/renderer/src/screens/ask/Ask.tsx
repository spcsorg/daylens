// Ask: questions about any day, answered from the record like a message thread. Your question sits on the right; each
// statement of the answer arrives on the left as it streams, one at a time.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AskResult, Citation, Statement } from '../../../../shared/ai.ts'
import { act, bridge, query } from '../../lib/api.ts'
import { seenAt } from '../../lib/format.ts'
import { Icon } from '../../ui/Icon.tsx'
import { useToast } from '../../ui/overlays.tsx'
import { errorText } from '../../ui/status.tsx'
import { KeyForm } from '../settings/AiTab.tsx'
import './ask.css'

const TRY = ['What did I do this morning?', 'What did I work on yesterday afternoon?', 'What took most of my time yesterday?']
// A new statement waits this long after the one before, so a burst still arrives one by one.
const PACE_MS = 220

interface Turn {
  id: number
  question: string
  streamed: Statement[]
  result: AskResult | null
  error: string | null
}

// The thread lives outside the screen, so an answer still lands while another screen is open.
let turns: Turn[] = []
let nextId = 1
const subs = new Set<() => void>()
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f))
function update(id: number, f: (t: Turn) => Turn): void {
  turns = turns.map((t) => (t.id === id ? f(t) : t))
  for (const s of subs) s()
}

async function send(question: string): Promise<void> {
  const id = nextId++
  turns = [...turns, { id, question, streamed: [], result: null, error: null }]
  for (const s of subs) s()
  const off = bridge.onReader((e) => {
    if (e.e === 'ask' && e.ask_id === id) update(id, (t) => ({ ...t, streamed: [...t.streamed, e.statement] }))
  })
  try {
    const result = await query({ q: 'ask', ask_id: id, question })
    update(id, (t) => ({ ...t, result }))
  } catch (err) {
    update(id, (t) => ({ ...t, error: failure((err as Error).message) }))
  } finally {
    off()
  }
}

function failure(message: string): string {
  if (/key was refused/.test(message)) return 'Anthropic didn’t accept your key. Check it in Settings › AI.'
  if (/429|rate limit|credit balance|quota/i.test(message)) return 'Your Anthropic account is out of credit or over its limit, so Claude couldn’t answer.'
  if (/timed? ?out|fetch failed|ENOTFOUND|ECONN|network/i.test(message)) return 'Couldn’t reach Anthropic. Check your connection and try again.'
  if (/being deleted|deletion began/.test(message)) return 'Part of your record is being deleted. Ask again in a moment.'
  return 'Claude couldn’t answer that. Try again.'
}

/** How many of `total` items to show: one more every PACE_MS until all are out. */
function usePaced(total: number): number {
  const [shown, setShown] = useState(total)
  const first = useRef(true)
  useEffect(() => {
    // An answer already in the thread when the screen opens shows at once.
    if (first.current) {
      first.current = false
      return
    }
    if (shown >= total) return void (shown > total && setShown(total))
    const t = setTimeout(() => setShown((n) => n + 1), shown === 0 ? 0 : PACE_MS)
    return () => clearTimeout(t)
  }, [shown, total])
  return Math.min(shown, total)
}

export function Ask({ onOpenHour }: { onOpenHour: (start: number) => void }) {
  const thread = useSyncExternalStore(subscribe, () => turns)
  const [text, setText] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const ask = (q: string) => {
    const question = q.trim()
    if (!question) return
    setText('')
    void send(question)
  }

  // Follow the newest message unless the person has scrolled up to read.
  const pinned = useRef(true)
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  })

  return (
    <div className="ask">
      <div
        className="scroll ask-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        }}
      >
        {thread.length === 0 ? (
          <div className="ask-start">
            <p className="ask-start-lede">Ask about any day.</p>
            <div className="ask-try">
              {TRY.map((t) => (
                <button type="button" key={t} className="ask-suggestion" onClick={() => ask(t)}>
                  {t}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="ask-thread">
            {thread.map((t) => (
              <Exchange key={t.id} turn={t} onOpenHour={onOpenHour} onRetry={() => ask(t.question)} />
            ))}
          </div>
        )}
      </div>
      <div className="ask-bottom">
        <form
          className="ask-composer"
          onSubmit={(e) => {
            e.preventDefault()
            ask(text)
            input.current?.focus()
          }}
        >
          <input ref={input} className="ask-field" placeholder="Ask about any day" value={text} autoFocus onChange={(e) => setText(e.target.value)} />
          <button type="submit" className="ask-send" aria-label="Ask" disabled={!text.trim()}>
            <Icon name="arrow-right" />
          </button>
        </form>
      </div>
    </div>
  )
}

function Exchange({ turn, onOpenHour, onRetry }: { turn: Turn; onOpenHour: (start: number) => void; onRetry: () => void }) {
  const r = turn.result
  // The whole answer replaces what streamed: a statement can be withdrawn by a deletion made while Claude answered.
  const statements = r ? (r.kind === 'answer' ? r.statements : []) : turn.streamed
  const shown = usePaced(statements.length)
  const done = r !== null || turn.error !== null
  const settled = done && shown === statements.length
  return (
    <div className="ask-exchange">
      <div className="bubble mine">{turn.question}</div>
      {statements.slice(0, shown).map((s, i) => (
        <div className="bubble theirs" key={i}>
          {s.text}
        </div>
      ))}
      {!settled && <Typing />}
      {settled && turn.error && (
        <div className="bubble theirs problem" role="alert">
          {turn.error}{' '}
          <button type="button" className="link" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
      {settled && r?.kind === 'no_answer' && (
        <div className="bubble theirs">
          Your record doesn’t show that.
          {r.missing && <span className="bubble-aside">{r.missing}</span>}
        </div>
      )}
      {settled && r?.kind === 'withdrawn' && <div className="bubble theirs">What answered this was just deleted, so there’s nothing left to show.</div>}
      {settled && r?.kind === 'search_only' && <NoKey onSaved={onRetry} />}
      {settled && r?.kind === 'answer' && <Sources statements={r.statements} onOpenHour={onOpenHour} />}
    </div>
  )
}

function Typing() {
  return (
    <div className="bubble theirs typing" aria-label="Claude is answering">
      <span />
      <span />
      <span />
    </div>
  )
}

function NoKey({ onSaved }: { onSaved: () => void }) {
  return (
    <div className="bubble theirs ask-nokey">
      <span>Add your Anthropic API key and Claude answers from your record. Only the parts a question needs are sent.</span>
      <KeyForm onSaved={onSaved} />
    </div>
  )
}

/** The hours and pages the answer cites, once each: an hour opens in Today, a page in the browser. */
function Sources({ statements, onOpenHour }: { statements: Statement[]; onOpenHour: (start: number) => void }) {
  const toast = useToast()
  const hours = new Map<number, Extract<Citation, { kind: 'hour' }>>()
  const pages = new Map<string, Exclude<Citation, { kind: 'hour' }>>()
  for (const c of statements.flatMap((s) => s.cites)) {
    if (c.kind === 'hour') hours.set(c.start_wall_ms, c)
    else if (c.kind === 'page' && c.url) pages.set(c.url, c)
  }
  if (hours.size === 0 && pages.size === 0) return null
  return (
    <div className="ask-sources">
      {[...hours.values()]
        .sort((a, b) => a.start_wall_ms - b.start_wall_ms)
        .map((c) => (
          <button type="button" key={c.start_wall_ms} className="ask-chip" onClick={() => onOpenHour(c.start_wall_ms)}>
            <Icon name="today" size={14} />
            <span>{c.title ? `${seenAt(c.start_wall_ms)} · ${c.title}` : seenAt(c.start_wall_ms)}</span>
          </button>
        ))}
      {[...pages.values()].map((c) => (
        <button
          type="button"
          key={c.url}
          className="ask-chip"
          onClick={async () => {
            const r = await act({ a: 'open_url', url: c.url! })
            if (!r.ok) toast({ text: errorText(r.error), error: true })
          }}
        >
          <Icon name="globe" size={14} />
          <span>{c.title ?? c.url}</span>
        </button>
      ))}
    </div>
  )
}
