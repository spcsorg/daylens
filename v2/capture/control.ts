// Writes the app asks for over the service's stdin, one JSON object per line. The service is the only writer, so the
// interface's pause, deletions, exclusions and retention all arrive here. Each op with an id gets one reply line.
import type { ExclusionRule } from './defaults.ts'
import { settleRequest } from '../storage/assistantRequests.ts'
import type { HourField } from '../storage/hours.ts'
import type { DeletionHandle, PauseFor, Storage } from '../storage/index.ts'

export type DeleteWhat =
  | { kind: 'last'; ms: number }
  | { kind: 'range'; from_wall_ms: number; to_wall_ms: number }
  | { kind: 'app'; app_id: string; from_wall_ms?: number; to_wall_ms?: number }
  | { kind: 'site'; site: string; from_wall_ms?: number; to_wall_ms?: number }
  | { kind: 'everything' }

export type ControlMsg =
  | { op: 'pause'; id: string; until: PauseFor }
  | { op: 'resume'; id: string }
  | { op: 'delete'; id: string; what: DeleteWhat }
  | { op: 'exclude'; id: string; rule: ExclusionRule }
  | { op: 'unexclude'; id: string; match: ExclusionRule['match']; value: string }
  | { op: 'retention'; id: string; days: number | null }
  | { op: 'setting'; id: string; key: string; value: unknown }
  | { op: 'correct'; id: string; hour_id: number; field: HourField; text: string }
  | { op: 'assistant_request'; id: string; request_id: number; state: 'running' | 'done' | 'declined' | 'failed' | 'expired'; error?: string }

export type ControlReply =
  | { op: 'reply'; id: string; ok: true; result?: unknown }
  | { op: 'reply'; id: string; ok: false; error: string }
  | { op: 'deletion'; id: string; state: 'done' | 'purged' | 'failed' }

const PAUSE_FOR: readonly PauseFor[] = ['hour', 'tomorrow', 'until_resumed']
const MATCHES: readonly ExclusionRule['match'][] = ['app_id', 'exe', 'site']
// Settings the app may write; everything else in the settings table belongs to the engine.
const APP_SETTING = /^app\.[a-z_]+$/

const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512

// A deletion also refuses capture inside its range, so "today" or "this week" ends now: the rest of the day still records.
function span(o: { from_wall_ms?: unknown; to_wall_ms?: unknown }, now: number): { from_wall_ms: number; to_wall_ms: number } | undefined | null {
  if (o.from_wall_ms === undefined && o.to_wall_ms === undefined) return undefined
  if (!isTime(o.from_wall_ms) || !isTime(o.to_wall_ms)) return null
  const to = Math.min(o.to_wall_ms, now)
  return o.from_wall_ms < to ? { from_wall_ms: o.from_wall_ms, to_wall_ms: to } : null
}

function startDeletion(storage: Storage, what: DeleteWhat, now: number): DeletionHandle {
  switch (what.kind) {
    case 'last':
      if (!isTime(what.ms) || what.ms === 0) throw new Error('bad_duration')
      return storage.deleteLast(what.ms)
    case 'range': {
      const range = span(what, now)
      if (!range) throw new Error('bad_range')
      return storage.deleteRange(range.from_wall_ms, range.to_wall_ms)
    }
    case 'app': {
      const range = span(what, now)
      if (!isText(what.app_id) || range === null) throw new Error('bad_app')
      return storage.deleteSource(what.app_id, range)
    }
    case 'site': {
      const range = span(what, now)
      if (!isText(what.site) || range === null) throw new Error('bad_site')
      return storage.deleteSite(what.site, range)
    }
    case 'everything':
      return storage.deleteEverything()
    default:
      throw new Error('bad_deletion')
  }
}

/** Returns false for a message that is not a control op, so the caller can route it elsewhere. */
export function handleControl(storage: Storage, raw: Record<string, unknown>, send: (reply: ControlReply) => void, now: () => number = Date.now): boolean {
  const msg = raw as ControlMsg
  if (!['pause', 'resume', 'delete', 'exclude', 'unexclude', 'retention', 'setting', 'correct', 'assistant_request'].includes(msg.op)) return false
  const id = typeof msg.id === 'string' && msg.id.length <= 64 ? msg.id : null
  if (id === null) return true
  const fail = (err: unknown) => send({ op: 'reply', id, ok: false, error: err instanceof Error ? err.message : 'failed' })
  try {
    switch (msg.op) {
      case 'pause':
        if (!PAUSE_FOR.includes(msg.until)) throw new Error('bad_pause')
        send({ op: 'reply', id, ok: true, result: storage.pause(msg.until) })
        break
      case 'resume':
        storage.resume()
        send({ op: 'reply', id, ok: true })
        break
      case 'delete': {
        const handle = startDeletion(storage, msg.what, now())
        // The deletion is in force here: capture refuses the material and readers hide it while it is removed.
        send({ op: 'reply', id, ok: true, result: { tombstone: handle.tombstone } })
        handle.done.then(
          () => send({ op: 'deletion', id, state: 'done' }),
          () => send({ op: 'deletion', id, state: 'failed' }),
        )
        handle.purged.then(
          () => send({ op: 'deletion', id, state: 'purged' }),
          () => {},
        )
        break
      }
      case 'exclude': {
        const r = msg.rule
        if (!r || !MATCHES.includes(r.match) || !isText(r.value) || !isText(r.label)) throw new Error('bad_rule')
        storage.addExclusion({ match: r.match, value: r.value, label: r.label })
        send({ op: 'reply', id, ok: true })
        break
      }
      case 'unexclude':
        if (!MATCHES.includes(msg.match) || !isText(msg.value)) throw new Error('bad_rule')
        storage.removeExclusion(msg.match, msg.value)
        send({ op: 'reply', id, ok: true })
        break
      case 'retention':
        if (msg.days !== null && !(Number.isInteger(msg.days) && msg.days > 0)) throw new Error('bad_retention')
        storage.setRetentionDays(msg.days)
        send({ op: 'reply', id, ok: true })
        break
      case 'setting':
        if (typeof msg.key !== 'string' || !APP_SETTING.test(msg.key)) throw new Error('bad_setting')
        storage.setSetting(msg.key, msg.value)
        send({ op: 'reply', id, ok: true })
        break
      case 'correct':
        if (!Number.isInteger(msg.hour_id) || !['title', 'summary'].includes(msg.field) || !isText(msg.text)) throw new Error('bad_correction')
        if (!storage.hour(msg.hour_id)) throw new Error('no_hour')
        send({ op: 'reply', id, ok: true, result: { correction: storage.correct(msg.hour_id, msg.field, msg.text) } })
        break
      case 'assistant_request':
        if (!Number.isInteger(msg.request_id) || !['running', 'done', 'declined', 'failed', 'expired'].includes(msg.state)) throw new Error('bad_request')
        send({ op: 'reply', id, ok: true, result: { settled: settleRequest(storage.db, storage.bus, msg.request_id, msg.state, typeof msg.error === 'string' ? msg.error.slice(0, 200) : null, now()) } })
        break
    }
  } catch (err) {
    fail(err)
  }
  return true
}
