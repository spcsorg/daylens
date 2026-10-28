// The ways an hour can be written, behind one interface: the Anthropic API on the person's own key, or no AI.
import Anthropic from '@anthropic-ai/sdk'
import type { Packet } from './packet.ts'
import { writerMessage } from './prompt.ts'
import type { WrittenHour } from './validate.ts'

export interface Usage {
  // All input tokens, including any read from or written to a cache.
  input: number
  cached_input: number
  cache_write: number
  output: number
  reasoning: number | null
}

export interface CallResult {
  text: string | null
  error: string | null
  // The call stopped on a usage or quota limit; retrying will not help until it resets.
  quota: boolean
  latency_ms: number
  // When the first words of the answer arrived, for a backend that streams.
  first_token_ms: number | null
  usage: Usage | null
  // The exact model the provider says answered.
  model: string | null
  // Tool calls the run made. A writer must make none.
  tool_calls: string[]
}

export interface TextBackend {
  readonly name: string
  call(message: string): Promise<CallResult>
}

export interface HourWriter {
  readonly name: string
  write(packet: Packet): Promise<CallResult>
}

const QUOTA = /rate limit|quota|credit balance/i

// US dollars per million tokens, standard tier, from the Anthropic model pricing table (as of 2026-10-06).
export const ANTHROPIC_RATES: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-fable-5-1': { input: 10, output: 50 },
}

export interface ApiOptions {
  apiKey: string
  // A local server stands in for the API in tests.
  baseURL?: string
  timeoutMs: number
  // How much the model thinks before it answers; the model's own default when left out.
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

export interface ApiRequest {
  system?: string
  message: string
  // The answer must be JSON matching it.
  schema?: Record<string, unknown>
  // Each piece of the answer as it arrives.
  onText?: (text: string) => void
  signal?: AbortSignal
}

// Thinking counts against it; an hour or an answer is far shorter.
const API_MAX_TOKENS = 16_000

// The person's key and nothing from the environment: the SDK would otherwise read ANTHROPIC_BASE_URL and
// ANTHROPIC_AUTH_TOKEN, which belong to the person's own tools, and it merges ANTHROPIC_CUSTOM_HEADERS after the key, so
// each header named there is removed, and the key and Authorization are set last.
function apiClient(opts: ApiOptions): Anthropic {
  const inherited = Object.fromEntries(
    (process.env.ANTHROPIC_CUSTOM_HEADERS ?? '').split('\n').flatMap((l) => (l.includes(':') ? [[l.slice(0, l.indexOf(':')).trim(), null]] : [])),
  )
  const defaultHeaders = { ...inherited, 'X-Api-Key': opts.apiKey, Authorization: null }
  return new Anthropic({ apiKey: opts.apiKey, authToken: null, baseURL: opts.baseURL ?? null, timeout: opts.timeoutMs, defaultHeaders })
}

function apiError(e: unknown): { error: string; quota: boolean } {
  if (e instanceof Anthropic.AuthenticationError) return { error: 'the API key was refused', quota: false }
  if (e instanceof Anthropic.APIError) return { error: `${e.status ?? 'no status'}: ${e.message}`, quota: e.status === 429 || QUOTA.test(e.message) }
  return { error: (e as Error).message, quota: false }
}

/** Whether the API accepts the key, without a billed call: null when it does, else why not. */
export async function checkKey(opts: ApiOptions): Promise<string | null> {
  try {
    await apiClient(opts).models.list({ limit: 1 })
    return null
  } catch (e) {
    return apiError(e).error
  }
}

/** The Anthropic Messages API, streamed, with no tools. Never throws: a failure is a CallResult with its error. */
export function anthropicClient(model: string, opts: ApiOptions): (req: ApiRequest) => Promise<CallResult> {
  if (!ANTHROPIC_RATES[model]) throw new Error(`no price for ${model}`)
  if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs < 1) throw new RangeError('timeoutMs must be a positive whole number')
  const client = apiClient(opts)
  return async (req) => {
    const t0 = performance.now()
    const out: CallResult = { text: null, error: null, quota: false, latency_ms: 0, first_token_ms: null, usage: null, model: null, tool_calls: [] }
    try {
      const stream = client.messages.stream(
        {
          model,
          max_tokens: API_MAX_TOKENS,
          ...(req.system ? { system: req.system } : {}),
          messages: [{ role: 'user', content: req.message }],
          ...(req.schema || opts.effort ? { output_config: { ...(opts.effort ? { effort: opts.effort } : {}), ...(req.schema ? { format: { type: 'json_schema' as const, schema: req.schema } } : {}) } } : {}),
        },
        { signal: req.signal },
      )
      stream.on('text', (t) => {
        out.first_token_ms ??= Math.round(performance.now() - t0)
        req.onText?.(t)
      })
      const m = await stream.finalMessage()
      const u = m.usage
      const cacheWrite = u.cache_creation_input_tokens ?? 0
      const cacheRead = u.cache_read_input_tokens ?? 0
      out.usage = { input: u.input_tokens + cacheWrite + cacheRead, cached_input: cacheRead, cache_write: cacheWrite, output: u.output_tokens, reasoning: null }
      out.model = m.model
      out.tool_calls = m.content.filter((b) => b.type !== 'text' && b.type !== 'thinking' && b.type !== 'redacted_thinking').map((b) => b.type)
      if (m.stop_reason === 'refusal') out.error = `${model} declined to answer${m.stop_details?.category ? ` (${m.stop_details.category})` : ''}`
      else if (m.stop_reason === 'max_tokens') out.error = `the answer was cut off at ${API_MAX_TOKENS} tokens`
      else out.text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
    } catch (e) {
      Object.assign(out, apiError(e))
    }
    out.latency_ms = Math.round(performance.now() - t0)
    return out
  }
}

export function anthropicApi(model: string, opts: ApiOptions): TextBackend {
  const call = anthropicClient(model, opts)
  return { name: `api:${model}`, call: (message) => call({ message }) }
}

export function textWriter(backend: TextBackend): HourWriter {
  return { name: backend.name, write: (packet) => backend.call(writerMessage(packet)) }
}

// With no AI, the hour is its facts: apps by time, what was open, agent work, commits, and when the person was away.
// It never says the person made anything, since the facts cannot tell who did.
export const noAi: HourWriter = {
  name: 'no-ai',
  async write(packet) {
    const t0 = performance.now()
    const hour = factsHour(packet)
    return { text: JSON.stringify(hour), error: null, quota: false, latency_ms: Math.round(performance.now() - t0), first_token_ms: null, usage: null, model: null, tool_calls: [] }
  },
}

export function factsHour(packet: Packet): WrittenHour {
  const byApp = new Map<string, { min: number; ids: string[] }>()
  for (const i of [...packet.windows, ...packet.pages]) {
    if (!i.app) continue
    const e = byApp.get(i.app) ?? { min: 0, ids: [] }
    e.min += i.min
    e.ids.push(i.id)
    byApp.set(i.app, e)
  }
  const apps = [...byApp.entries()].filter(([, e]) => e.min > 0).sort((a, b) => b[1].min - a[1].min)
  const mins = (m: number) => (Math.round(m) > 0 ? `${Math.round(m)} min` : 'under 1 min')
  const sources: string[] = []
  const lines: string[] = []
  const said = (ids: string[]) => sources.push(...ids)

  // Every recorded item is listed, so the detail never shows less than the summary; items under a minute are counted per app.
  const recorded = [...packet.windows, ...packet.pages].filter((i) => i.min > 0).sort((a, b) => b.min - a.min)
  const brief = new Map<string, { n: number; min: number }>()
  for (const i of recorded) {
    said([i.id])
    if (Math.round(i.min) === 0) {
      const b = brief.get(i.app ?? 'Unknown app') ?? { n: 0, min: 0 }
      brief.set(i.app ?? 'Unknown app', { n: b.n + 1, min: b.min + i.min })
      continue
    }
    const what = i.title && !i.stale ? `“${i.title}”` : i.stale ? 'title may not describe the work' : i.site ? `${i.site}, page title not recorded` : (i.title_note ?? 'title not recorded')
    lines.push(`${i.app ?? 'Unknown app'}: ${what} (${Math.round(i.min)} min, ${i.from}–${i.to})`)
  }
  for (const [app, b] of brief) lines.push(b.n === 1 ? `${app}: 1 window or page under a minute` : `${app}: ${b.n} windows or pages under a minute each (${mins(b.min)})`)
  for (const a of packet.agents) {
    const unknown = a.unknown_min ? `, ${Math.round(a.unknown_min)} min working with presence not recorded` : ''
    const waiting = a.waiting_min ? `, ${Math.round(a.waiting_min)} min waiting` : ''
    lines.push(`${a.agent} in ${a.project ?? 'an unknown folder'}: ${Math.round(a.with_you_min)} min working while present, ${Math.round(a.while_away_min)} min while away${unknown}${waiting}`)
    said([a.id])
  }
  for (const c of packet.commits) {
    lines.push(`Commit at ${c.at} in ${c.repos.join(', ')}: ${c.subject}${c.while_away ? ` (made while away: ${c.while_away})` : ''}`)
    said([c.id])
  }
  for (const w of packet.away) if (w.from !== w.to) lines.push(`Away ${w.from}–${w.to} (${w.why})`)
  for (const g of packet.unknown) if (g.from !== g.to) lines.push(`Not recorded ${g.from}–${g.to} (${g.why})`)
  for (const k of packet.scheduled_events) lines.push(`On the calendar: “${k.title}”, ${k.from}–${k.to} (scheduled)`)

  for (const [, e] of apps) said(e.ids)
  const top = apps[0]
  const working = [...new Set(packet.agents.filter((a) => Math.round(a.with_you_min + a.while_away_min + (a.unknown_min ?? 0)) > 0).map((a) => a.agent))]
  const title = top ? `Mostly ${top[0]}` : working.length ? `${working.join(' and ')} working` : packet.away.length ? 'Away' : 'Nothing recorded'
  const summary = apps.length ? apps.map(([app, e]) => `${app} ${mins(e.min)}`).join(', ') + '.' : 'No app time recorded.'
  return {
    title,
    summary,
    apps: apps.map(([app]) => app).concat(packet.agents.map((a) => a.agent).filter((a, i, all) => all.indexOf(a) === i && !byApp.has(a))),
    detail: lines.join('\n') || 'Nothing was recorded in this hour.',
    outcome: packet.commits.length ? packet.commits.map((c) => `Commit at ${c.at}: ${c.subject}`).join('; ') : null,
    sources: [...new Set(sources)],
    suggestion: null,
  }
}
