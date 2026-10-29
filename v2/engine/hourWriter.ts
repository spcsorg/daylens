// Writes each finished hour with the AI the person chose: a few minutes after the hour ends, its packet goes to the
// writer, the answer is checked in code, and only a valid hour is stored. With no writer nothing is sent and hours stay
// as facts; a rejected or failed hour stays as facts too.
import { HOUR_MS } from '../storage/derive.ts'
import type { Storage } from '../storage/index.ts'
import { ANTHROPIC_RATES, type HourWriter } from './backends.ts'
import { buildPacket, type PacketOptions } from './packet.ts'
import { validateHour } from './validate.ts'

// Chosen on the gold day: most correct hours, fewest unsupported claims (docs/engine.md, Choosing the models).
export const HOUR_MODEL = 'claude-opus-5-5'
// Late lines from capture and agent logs arrive by then.
export const WRITE_DELAY_MS = 5 * 60_000
// Hours further back are left as facts, so turning AI on doesn't send weeks of history.
const LOOKBACK_MS = 24 * HOUR_MS
// The gold day's packet settings.
export const PACKET: PacketOptions = { staleTitleMs: HOUR_MS, nearbyHours: 2, openThreadMs: 3 * HOUR_MS }
// After each failed try of an hour; after the last, the hour stays as facts until the writer changes.
export const RETRY_MS = [5 * 60_000, 30 * 60_000]
const LIMIT_WAIT_MS = HOUR_MS
const TICK_MS = 60_000

/** The local hour starts whose hours are due: ended at least WRITE_DELAY_MS ago, within LOOKBACK_MS. */
export function dueHours(now: number): number[] {
  const out: number[] = []
  const d = new Date(now - LOOKBACK_MS)
  for (let h = 0; ; h++) {
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + h).getTime()
    if (t + HOUR_MS + WRITE_DELAY_MS > now) break
    if (t >= now - LOOKBACK_MS && (out.length === 0 || t > out.at(-1)!)) out.push(t)
  }
  return out
}

export class HourWriting {
  private writer: HourWriter | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<void> | null = null
  private again = false
  private readonly failed = new Map<number, { tries: number; next: number }>()
  private waitUntil = 0
  private readonly storage: Storage
  private readonly o: { log: (line: string) => void; now?: () => number; tz?: string }

  constructor(storage: Storage, o: { log: (line: string) => void; now?: () => number; tz?: string }) {
    this.storage = storage
    this.o = o
  }

  setWriter(writer: HourWriter | null): void {
    this.writer = writer
    this.failed.clear()
    this.waitUntil = 0
    void this.run()
  }

  start(): void {
    this.timer ??= setInterval(() => void this.run(), TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.writer = null
  }

  /** Writes every due hour that has no text yet, oldest first, one at a time. */
  run(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = this.pass().finally(() => {
      this.running = null
      if (this.again) {
        this.again = false
        void this.run()
      }
    })
    return this.running
  }

  private async pass(): Promise<void> {
    const now = (this.o.now ?? Date.now)()
    for (const start of dueHours(now)) {
      const writer = this.writer
      if (!writer || now < this.waitUntil) return
      const f = this.failed.get(start)
      if (f && (f.tries > RETRY_MS.length || now < f.next)) continue
      const h = this.storage.hourAt(start)
      // Written, or corrected by the person: theirs stands. A deletion clears an hour's text and marks it for rewriting.
      if (h && (h.status === 'written' || h.corrected.length > 0)) continue
      let outcome: 'written' | 'empty' | 'failed' | 'limit'
      try {
        outcome = await this.write(start, writer)
      } catch (err) {
        this.o.log(`hour write failed code=${(err as Error).name}`)
        outcome = 'failed'
      }
      if (writer !== this.writer) return
      if (outcome === 'limit') {
        this.waitUntil = now + LIMIT_WAIT_MS
        return
      }
      if (outcome === 'failed') {
        const tries = (f?.tries ?? 0) + 1
        this.failed.set(start, { tries, next: now + (RETRY_MS[tries - 1] ?? 0) })
      } else this.failed.delete(start)
    }
  }

  private async write(start: number, writer: HourWriter): Promise<'written' | 'empty' | 'failed' | 'limit'> {
    const tz = this.o.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    const basis = this.storage.hourBasis(start)
    const { packet, refs } = buildPacket(this.storage, { start_wall_ms: start, tz, tz_offset_min: -new Date(start).getTimezoneOffset() }, PACKET)
    if (packet.windows.length === 0 && packet.pages.length === 0 && packet.agents.length === 0) return 'empty'
    const r = await writer.write(packet)
    if (r.usage) {
      const model = r.model ?? HOUR_MODEL
      const rate = ANTHROPIC_RATES[model] ?? ANTHROPIC_RATES[HOUR_MODEL]!
      this.storage.recordUsage({ kind: 'hour', provider: 'anthropic', model, input_tokens: r.usage.input, output_tokens: r.usage.output, cost_micro_usd: Math.round(r.usage.input * rate.input + r.usage.output * rate.output), ref: `hour:${start}` })
    }
    // The key was removed or changed while this hour was being written: what came back is not stored.
    if (writer !== this.writer) return 'failed'
    if (r.quota) {
      this.o.log('hour write stopped: usage limit')
      return 'limit'
    }
    const v = r.text === null ? null : validateHour(r.text, packet, refs)
    if (!v?.ok || !v.hour) {
      this.o.log(`hour write rejected ${r.error ? 'reason=call_failed' : `codes=${v?.errors.map((e) => e.code).join(',')}`}`)
      return 'failed'
    }
    const observations = v.cited.flatMap((c) => (c.kind === 'observations' ? c.ids : []))
    const sources = v.cited.flatMap((c) => (c.kind === 'agent' ? [{ agent: c.agent, session: c.session }] : []))
    const { title, summary, detail, outcome, suggestion } = v.hour
    this.storage.writeHour({ start_wall_ms: start, tz, status: 'written', title, summary, detail, outcome, suggestion, sources, observations, writer: writer.name }, basis)
    return 'written'
  }
}
