// Ask: questions about any day, answered from the record like a message thread. Your question sits on the right; the
// answer arrives on the left as one message, a sentence at a time as it streams.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AskResult, Citation, Statement, Visual } from '../../../../shared/ai.ts'
import { act, bridge, query } from '../../lib/api.ts'
import { hourLabel, seenAt } from '../../lib/format.ts'
import { IconButton } from '../../ui/controls.tsx'
import { Icon } from '../../ui/Icon.tsx'
import { useToast } from '../../ui/overlays.tsx'
import { errorText } from '../../ui/status.tsx'
import { KeyForm } from '../settings/AiTab.tsx'
import { AnswerVisual, dayWord, FoundCard, opened } from './Visual.tsx'
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
// An answer can show what was then deleted, so a deletion clears the thread, and an answer still on its way lands nowhere.
const ERASING = new Set(['deletion', 'retention', 'reset'])
bridge.onReader((e) => {
  if (e.e !== 'changed' || !e.kinds.some((k) => ERASING.has(k))) return
  turns = []
  for (const s of subs) s()
})
function update(id: number, f: (t: Turn) => Turn): void {
  turns = turns.map((t) => (t.id === id ? f(t) : t))
  for (const s of subs) s()
}

// Asked again (after a failure, or once a key is saved): the new answer takes the old one's place.
function again(t: Turn): void {
  turns = turns.filter((x) => x.id !== t.id)
  void send(t.question)
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
    pinned.current = true
    void send(question)
  }

  // Follow the newest message as it grows, unless the person has scrolled up to read.
  const pinned = useRef(true)
  const lastTop = useRef(0)
  const started = thread.length > 0
  // One key form, after the thread and always at the same place, so what is typed in it survives another question.
  const lastNoKey = thread.findLast((t) => t.result?.kind === 'search_only')
  useEffect(() => {
    const el = scroller.current
    const content = el?.firstElementChild
    if (!el || !content) return
    const follow = new ResizeObserver(() => pinned.current && el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }))
    follow.observe(content)
    return () => follow.disconnect()
  }, [started])

  return (
    <div className="ask">
      <div
        className="scroll ask-scroll"
        ref={scroller}
        onScroll={(e) => {
          // Following only ever scrolls down, so a move up is the person reading back, by wheel, keys or scrollbar.
          const el = e.currentTarget
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) pinned.current = true
          else if (el.scrollTop < lastTop.current) pinned.current = false
          lastTop.current = el.scrollTop
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
              <Exchange key={t.id} turn={t} onOpenHour={onOpenHour} onRetry={() => ((pinned.current = true), again(t))} />
            ))}
            {lastNoKey && <NoKey onSaved={() => ((pinned.current = true), again(lastNoKey))} />}
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
      {shown > 0 && (
        <div className="bubble theirs">
          {statements.slice(0, shown).map((s, i) => (
            <span className="ask-sentence" key={i}>
              {s.text}{' '}
            </span>
          ))}
        </div>
      )}
      {shown === 0 && !settled && <Typing />}
      {settled && turn.error && (
        <div className="bubble theirs problem" role="alert">
          {turn.error}{' '}
          <button type="button" className="link" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
      {settled && r?.kind === 'no_answer' && <div className="bubble theirs">{r.missing ?? 'Your record doesn’t show that.'}</div>}
      {settled && r?.kind === 'withdrawn' && <div className="bubble theirs">What answered this was just deleted, so there’s nothing left to show.</div>}
      {settled && r?.kind === 'search_only' && <FoundCard results={r.results} onOpenHour={onOpenHour} />}
      {settled && r?.kind === 'answer' && (
        <>
          {r.visual && <AnswerVisual visual={r.visual} onOpenHour={onOpenHour} />}
          <Sources statements={r.statements} visual={r.visual} onOpenHour={onOpenHour} />
          <Copy text={r.statements.map((s) => s.text).join(' ')} />
        </>
      )}
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
      <span>Add your Anthropic API key and Claude writes the answer from your record. Only the parts a question needs are sent.</span>
      <KeyForm onSaved={onSaved} />
    </div>
  )
}

/** An hour as a chip names it: "9 AM" today, "Yesterday 4 PM", else its day. */
function when(ms: number): string {
  const day = dayWord(ms)
  return day === 'Today' ? hourLabel(ms) : day === 'Yesterday' ? `Yesterday ${hourLabel(ms)}` : seenAt(ms)
}

function Copy({ text }: { text: string }) {
  const toast = useToast()
  return (
    <div className="ask-actions">
      <IconButton
        icon="copy"
        label="Copy"
        onClick={() =>
          void navigator.clipboard.writeText(text).then(
            () => toast({ text: 'Copied' }),
            () => toast({ text: 'Couldn’t copy the answer.', error: true }),
          )
        }
      />
    </div>
  )
}

/**
 * The hours and pages the answer cites, once each, in the order it cites them: an hour opens in Today, a page in the
 * browser. What the visual already opens is left out.
 */
function Sources({ statements, visual, onOpenHour }: { statements: Statement[]; visual: Visual | null; onOpenHour: (start: number) => void }) {
  const toast = useToast()
  const hours = new Map<number, Extract<Citation, { kind: 'hour' }>>()
  const pages = new Map<string, Exclude<Citation, { kind: 'hour' }>>()
  const shown = visual ? opened(visual) : new Set()
  for (const c of statements.flatMap((s) => s.cites)) {
    if (c.kind === 'hour' && !shown.has(c.start_wall_ms)) hours.set(c.start_wall_ms, c)
    else if (c.kind === 'page' && c.url && !shown.has(c.url)) pages.set(c.url, c)
  }
  if (hours.size === 0 && pages.size === 0) return null
  return (
    <div className="ask-sources">
      {[...hours.values()].map((c) => (
        <button type="button" key={c.start_wall_ms} className="ask-chip" title={c.title ?? undefined} onClick={() => onOpenHour(c.start_wall_ms)}>
          <Icon name="today" size={14} />
          <span>{when(c.start_wall_ms)}</span>
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
