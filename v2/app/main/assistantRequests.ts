// Carries out what assistants ask Daylens to change (storage/assistantRequests.ts). A change that only records less
// runs as soon as it is seen; anything else waits for the person's yes on the card in Daylens's window. Each runs
// through the same action as the app's own buttons, after being claimed, so it runs at most once and never late.
import { runsWithoutAsking, type AssistantRequest, type RequestChange } from '../../storage/assistantRequests.ts'
import type { Action, ActionResult } from '../shared/types.ts'

export interface RequestDeps {
  pending: () => Promise<AssistantRequest[]>
  // A write through the capture service, as the app's actions make.
  control: (op: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string }>
  act: (a: Action) => Promise<ActionResult>
  // Whether recording is paused now: an assistant's pause never replaces one, which would end it sooner.
  paused: () => Promise<boolean>
  // Tells the person a request waits on them, outside the window too.
  notify: (r: AssistantRequest) => void
  log: (line: string) => void
}

/** The app's actions that carry the change out, in order; a correction goes straight to the service. */
function steps(c: RequestChange): (Action | Record<string, unknown>)[] {
  switch (c.kind) {
    case 'pause':
      return [{ a: 'pause', until: c.until }]
    case 'resume':
      return [{ a: 'resume' }]
    case 'exclude':
      return [{ a: 'exclude', rule: { match: c.match, value: c.value, label: c.label } }]
    case 'unexclude':
      return [{ a: 'unexclude', match: c.match, value: c.value }]
    case 'delete': {
      const w = c.what
      return [{ a: 'delete', what: w.kind === 'app' ? { kind: 'app', app_id: w.app_id, from_wall_ms: w.from_wall_ms, to_wall_ms: w.to_wall_ms } : w }]
    }
    case 'retention':
      return [{ a: 'retention', days: c.days }]
    case 'correct':
      return [
        ...(c.title !== undefined ? [{ op: 'correct', hour_id: c.hour_id, field: 'title', text: c.title }] : []),
        ...(c.summary !== undefined ? [{ op: 'correct', hour_id: c.hour_id, field: 'summary', text: c.summary }] : []),
      ]
  }
}

export class AssistantRequests {
  private readonly d: RequestDeps
  // Requests already announced, so a refresh never notifies twice.
  private readonly announced = new Set<number>()
  private readonly running = new Set<number>()

  constructor(d: RequestDeps) {
    this.d = d
  }

  /** Looks at what is pending: runs what needs no yes, announces what does, and lets the rest expire. */
  async refresh(): Promise<void> {
    let pending: AssistantRequest[]
    try {
      pending = await this.d.pending()
    } catch (err) {
      return this.d.log(`assistant requests unreadable ${err instanceof Error ? err.message : String(err)}`)
    }
    for (const r of pending) {
      if (r.state === 'expired') void this.settle(r.id, 'expired')
      else if (runsWithoutAsking(r.change)) void this.run(r)
      else if (!this.announced.has(r.id)) {
        this.announced.add(r.id)
        this.d.notify(r)
      }
    }
  }

  /** The person's answer on the card. */
  async decide(id: number, allow: boolean): Promise<ActionResult> {
    const r = (await this.d.pending()).find((x) => x.id === id)
    if (!r) return { ok: false, error: 'request_gone' }
    if (r.state === 'expired') {
      await this.settle(id, 'expired')
      return { ok: false, error: 'request_expired' }
    }
    if (!allow) return (await this.settle(id, 'declined')) ? { ok: true } : { ok: false, error: 'request_gone' }
    return this.run(r)
  }

  private async settle(id: number, state: string, error?: string): Promise<boolean> {
    const r = await this.d.control({ op: 'assistant_request', request_id: id, state, ...(error ? { error } : {}) })
    return r.ok && (r.result as { settled?: boolean } | undefined)?.settled === true
  }

  private async run(r: AssistantRequest): Promise<ActionResult> {
    if (this.running.has(r.id)) return { ok: false, error: 'request_running' }
    this.running.add(r.id)
    try {
      if (!(await this.settle(r.id, 'running'))) return { ok: false, error: 'request_expired' }
      if (r.change.kind === 'pause' && (await this.d.paused())) {
        await this.settle(r.id, 'failed', 'Daylens is already paused, and an assistant can’t shorten a pause')
        return { ok: false, error: 'already_paused' }
      }
      for (const step of steps(r.change)) {
        const out = 'a' in step ? await this.d.act(step as Action) : await this.d.control(step)
        if (!out.ok) {
          const error = 'error' in out && out.error ? out.error : 'failed'
          await this.settle(r.id, 'failed', error)
          return { ok: false, error }
        }
      }
      await this.settle(r.id, 'done')
      return { ok: true }
    } catch (err) {
      // Once claimed, a request must end: a reader or service that throws would leave it running for good.
      const error = err instanceof Error ? err.message : String(err)
      await this.settle(r.id, 'failed', error).catch(() => {})
      return { ok: false, error }
    } finally {
      this.running.delete(r.id)
    }
  }
}
