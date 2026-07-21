// Fix your day by telling the agent (DEV-199; ai-agent.md §Daylens actions,
// timeline.md §Corrections, §Meetings). "That block was the ACME kickoff",
// "I was at lunch 12–1", "I didn't attend the 2pm ACME meeting" — the agent
// turns the sentence into a typed correction command and runs it through the
// EXACT machinery the Timeline's own correction UI uses (previewCorrection /
// applyCorrection / undoCorrection):
//
//   propose → preview affected facts and surfaces → confirm → apply → offer undo
//
// The preview card the person sees is computed by the same savepoint dry-run
// as the Settings flow, so what the card promises IS what apply does. Nothing
// is ever written silently: no confirmation, no change — silence, a timeout,
// or free text are all treated as "not confirmed". Applied corrections are
// durable product data and propagate everywhere corrections do (Timeline,
// Apps, search, the AI's own later answers), because they ARE corrections.
//
// Permanent deletion is deliberately absent: the spec keeps destructive
// purges out of ordinary agent actions. The agent can point at the block's
// own menu; it cannot destroy records.
import { tool } from 'ai'
import { z } from 'zod'
import type Database from 'better-sqlite3'
import type {
  AppCategory,
  CorrectionCommand,
  CorrectionPreview,
  LiveSession,
} from '@shared/types'
import { isAppCategory } from '@shared/types'
import { localDayBounds } from '../lib/localDate'
import {
  applyCorrection,
  previewCorrection,
  undoCorrection,
} from '../services/correctionCommands'
import {
  getMeetingAttendanceMarks,
  resolveDayMeetingReport,
  scheduledEventKey,
} from '../services/meetingResolution'
import type { AgentQuestion } from './interactionTools'

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').describe('Local date the block belongs to, YYYY-MM-DD')
const CLOCK = z.string().regex(/^\d{1,2}:\d{2}$/, 'HH:MM').describe('Local clock time, 24h HH:MM')

export const CORRECTION_ACTIONS = [
  'rename',
  'change_category',
  'adjust_time',
  'merge',
  'split',
  'exclude_block',
  'exclude_evidence',
  'assign_client',
  'mark_meeting',
] as const

export type CorrectionAction = (typeof CORRECTION_ACTIONS)[number]

/** The mark kinds a person can put on a scheduled meeting (timeline.md
 *  §Meetings), plus 'clear' to withdraw an earlier mark. */
export const MEETING_MARK_STATUSES = ['attended', 'skipped', 'moved', 'unrelated', 'clear'] as const

export type MeetingMarkStatus = (typeof MEETING_MARK_STATUSES)[number]

/** Hooks the production wiring injects so agent-applied corrections behave
 *  exactly like Settings-applied ones (live-session resolution, session flush
 *  before merges, projection invalidation after apply/undo). Every hook is
 *  optional so the terminal bench and tests run without Electron. */
export interface CorrectionToolHooks {
  resolveLiveSession?: (date: string) => LiveSession | null
  onBeforeApply?: (command: CorrectionCommand) => void
  /** Called after an applied correction or undo touched `date`. */
  onApplied?: (date: string) => void
}

export interface CorrectionToolDeps {
  db: Database.Database
  askUser: (question: AgentQuestion) => Promise<string>
  hooks?: CorrectionToolHooks
  signal?: AbortSignal
}

const APPLY_OPTION = 'Apply correction'
const CANCEL_OPTION = 'Cancel'
const UNDO_OPTION = 'Undo it'
const KEEP_OPTION = 'Keep it'

const CONFIRM_RE = /^(apply( it| correction)?|yes|confirm|do it|go ahead|ok(ay)?)\b/i
const DECLINE_RE = /^(cancel|no(pe| thanks?)?|don'?t|stop|never mind|nevermind|keep it|leave it)\b/i

function clockToMs(date: string, clock: string): number | null {
  const [hourRaw, minuteRaw] = clock.split(':')
  const hour = Number(hourRaw)
  const minute = Number(minuteRaw)
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d, hour, minute, 0, 0).getTime()
}

function fmtClock(ms: number): string {
  const value = new Date(ms)
  return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`
}

function fmtDuration(totalSeconds: number): string {
  const minutes = Math.round(totalSeconds / 60)
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest}m`
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

interface ProposeCorrectionInput {
  action: CorrectionAction
  date: string
  blockId?: string
  blockIds?: string[]
  label?: string
  category?: string
  startTime?: string
  endTime?: string
  splitAt?: string
  excludeAppName?: string
  excludeSiteDomain?: string
  clientName?: string | null
  projectName?: string | null
  meetingTitle?: string
  meetingTime?: string
  meetingStatus?: string
}

type Miss = { found: false; reason: string }

function miss(reason: string): Miss {
  return { found: false, reason }
}

function resolveClient(
  db: Database.Database,
  clientName: string,
): { id: string; name: string } | Miss {
  const rows = db.prepare(`SELECT id, name FROM clients ORDER BY name`).all() as Array<{ id: string; name: string }>
  const needle = clientName.trim().toLowerCase()
  const matches = rows.filter((row) => row.name.toLowerCase().includes(needle))
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    return miss(`Several clients match "${clientName}": ${matches.map((m) => m.name).join(', ')}. Use the exact name.`)
  }
  return rows.length === 0
    ? miss('No clients exist yet — the user can create one in Settings → Clients first.')
    : miss(`No client matches "${clientName}". Existing clients: ${rows.map((r) => r.name).join(', ')}.`)
}

function resolveProject(
  db: Database.Database,
  clientId: string,
  projectName: string,
): { id: string; name: string } | Miss {
  const rows = db.prepare(`SELECT id, name FROM projects WHERE client_id = ? ORDER BY name`)
    .all(clientId) as Array<{ id: string; name: string }>
  const needle = projectName.trim().toLowerCase()
  const matches = rows.filter((row) => row.name.toLowerCase().includes(needle))
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    return miss(`Several projects match "${projectName}": ${matches.map((m) => m.name).join(', ')}. Use the exact name.`)
  }
  return rows.length === 0
    ? miss('That client has no projects yet — assign the client alone, or create the project in Settings → Clients.')
    : miss(`No project matches "${projectName}" for that client. Its projects: ${rows.map((r) => r.name).join(', ')}.`)
}

// ─── Mark a scheduled meeting (the DEV-199 meeting-relationship action) ───────
// "I didn't attend the 2pm ACME meeting" / "that Zoom block was the ACME
// kickoff" / "mark Friday's standup as moved". The target is a SCHEDULED
// meeting — addressed by calendar identity, not a block id — so it resolves
// against the same day-level meeting resolution the Timeline, wrap, and
// search read.

interface MarkMeetingCandidate {
  title: string
  startMs: number
}

export type MarkMeetingResolution =
  | { kind: 'command'; command: Extract<CorrectionCommand, { kind: 'mark-meeting' }> }
  | { kind: 'ambiguous'; status: 'attended' | 'skipped' | 'moved' | 'unrelated' | null; candidates: MarkMeetingCandidate[] }
  | Miss

function describeMeeting(candidate: MarkMeetingCandidate): string {
  return `"${candidate.title}" (${fmtClock(candidate.startMs)})`
}

/** Resolve the meeting the user means from the day's meeting resolution.
 *  One match → the typed command. Several → the candidates, so the caller can
 *  ask which (the model-facing fallback turns them into a miss). None → a
 *  miss that names what IS scheduled, so the model can answer honestly. */
export function resolveMarkMeetingTarget(
  db: Database.Database,
  input: ProposeCorrectionInput,
): MarkMeetingResolution {
  const { date } = input
  const statusRaw = input.meetingStatus?.trim().toLowerCase()
  if (!statusRaw || !(MEETING_MARK_STATUSES as readonly string[]).includes(statusRaw)) {
    return miss('mark_meeting needs meetingStatus: attended, skipped, moved, unrelated, or clear.')
  }
  const status = statusRaw === 'clear' ? null : statusRaw as 'attended' | 'skipped' | 'moved' | 'unrelated'
  const titleNeedle = input.meetingTitle?.trim().toLowerCase() ?? ''
  const timeMs = input.meetingTime ? clockToMs(date, input.meetingTime) : undefined
  if (input.meetingTime && timeMs == null) return miss('mark_meeting got an invalid HH:MM meetingTime.')
  if (!titleNeedle && timeMs === undefined) {
    return miss('mark_meeting needs meetingTitle and/or meetingTime to name the scheduled meeting.')
  }

  let scheduled: MarkMeetingCandidate[] = []
  try {
    scheduled = (resolveDayMeetingReport(db, date)?.meetings ?? [])
      .filter((meeting) => meeting.scheduledStartMs != null && meeting.title)
      .map((meeting) => ({ title: meeting.title!, startMs: meeting.scheduledStartMs! }))
  } catch { /* pre-migration database resolves to the empty roster below */ }
  if (scheduled.length === 0) {
    return miss(`No scheduled meetings are on ${date}. Only calendar-scheduled meetings can be marked; a call known from app evidence alone has no schedule to mark — correct its block instead.`)
  }

  let candidates = titleNeedle
    ? scheduled.filter((candidate) => candidate.title.toLowerCase().includes(titleNeedle))
    : scheduled
  if (timeMs !== undefined) {
    const atTime = candidates.filter((candidate) => candidate.startMs === timeMs)
    if (atTime.length === 0 && candidates.length > 0 && titleNeedle) {
      return miss(`No meeting matching "${input.meetingTitle}" starts at ${input.meetingTime}. Its matches: ${candidates.map(describeMeeting).join(', ')}.`)
    }
    candidates = atTime
  }
  if (candidates.length === 0) {
    return miss(`No scheduled meeting matches that. The day's scheduled meetings: ${scheduled.map(describeMeeting).join(', ')}.`)
  }
  if (candidates.length === 1) {
    return { kind: 'command', command: { kind: 'mark-meeting', date, meeting: candidates[0], status } }
  }
  if (candidates.length > 4) {
    return miss(`${candidates.length} scheduled meetings match: ${candidates.map(describeMeeting).join(', ')}. Narrow it with meetingTime.`)
  }
  return { kind: 'ambiguous', status, candidates }
}

/** The stale-preview fingerprint for a mark-meeting command: the target's
 *  ledger identity plus its current mark. A calendar re-sync that drops the
 *  event expires the preview through the dry-run re-check; a mark that
 *  changed underneath the card expires it here. */
function markMeetingLedgerState(db: Database.Database, command: CorrectionCommand): string {
  if (command.kind !== 'mark-meeting') return ''
  const [dayStartMs] = localDayBounds(command.date)
  const minutes = Math.round((command.meeting.startMs - dayStartMs) / 60_000)
  const key = scheduledEventKey(minutes, command.meeting.title)
  try {
    return `${key}=${getMeetingAttendanceMarks(db, command.date).get(key) ?? 'none'}`
  } catch {
    return `${key}=unavailable`
  }
}

/** Translate the model's typed intent into the shared CorrectionCommand.
 *  Every invalid shape becomes an explicit miss the model can act on —
 *  never a thrown stack, never a silent guess. */
export function toCorrectionCommand(
  db: Database.Database,
  input: ProposeCorrectionInput,
): CorrectionCommand | Miss {
  const { action, date } = input
  const needBlock = (): string | Miss => input.blockId ?? miss(`${action} needs blockId (get it from get_day_overview).`)

  switch (action) {
    case 'rename': {
      const blockId = needBlock()
      if (typeof blockId !== 'string') return blockId
      const label = input.label?.trim()
      if (!label) return miss('rename needs the new label.')
      return { kind: 'edit', date, blockId, label }
    }
    case 'change_category': {
      const blockId = needBlock()
      if (typeof blockId !== 'string') return blockId
      if (!isAppCategory(input.category)) {
        return miss(`change_category needs a valid category (got "${input.category ?? ''}").`)
      }
      return { kind: 'edit', date, blockId, category: input.category as AppCategory }
    }
    case 'adjust_time': {
      const blockId = needBlock()
      if (typeof blockId !== 'string') return blockId
      const startMs = input.startTime ? clockToMs(date, input.startTime) : undefined
      const endMs = input.endTime ? clockToMs(date, input.endTime) : undefined
      if (startMs === null || endMs === null) return miss('adjust_time got an invalid HH:MM time.')
      if (startMs === undefined && endMs === undefined) {
        return miss('adjust_time needs startTime and/or endTime.')
      }
      return {
        kind: 'edit',
        date,
        blockId,
        ...(startMs !== undefined ? { startMs } : {}),
        ...(endMs !== undefined ? { endMs } : {}),
        ...(input.label?.trim() ? { label: input.label.trim() } : {}),
      }
    }
    case 'merge': {
      const blockIds = input.blockIds?.filter(Boolean) ?? []
      if (blockIds.length < 2) return miss('merge needs at least two blockIds.')
      return { kind: 'merge', date, blockIds }
    }
    case 'split': {
      const blockId = needBlock()
      if (typeof blockId !== 'string') return blockId
      const cutMs = input.splitAt ? clockToMs(date, input.splitAt) : null
      if (cutMs == null) return miss('split needs splitAt as HH:MM inside the block.')
      return { kind: 'split', date, blockId, cutMs }
    }
    case 'exclude_block': {
      const blockId = needBlock()
      if (typeof blockId !== 'string') return blockId
      return { kind: 'exclude-block', date, blockId }
    }
    case 'exclude_evidence': {
      const blockId = needBlock()
      if (typeof blockId !== 'string') return blockId
      const site = input.excludeSiteDomain?.trim()
      const app = input.excludeAppName?.trim()
      if (site) return { kind: 'exclude-evidence', date, blockId, evidence: { kind: 'site', domain: site } }
      if (app) return { kind: 'exclude-evidence', date, blockId, evidence: { kind: 'app', appName: app } }
      return miss('exclude_evidence needs excludeAppName or excludeSiteDomain.')
    }
    case 'assign_client': {
      const blockId = needBlock()
      if (typeof blockId !== 'string') return blockId
      if (input.clientName == null || input.clientName.trim() === '') {
        // Explicitly clearing the assignment.
        return { kind: 'assign-client', date, blockId, clientId: null, projectId: null }
      }
      const client = resolveClient(db, input.clientName)
      if ('found' in client) return client
      let projectId: string | null = null
      if (input.projectName?.trim()) {
        const project = resolveProject(db, client.id, input.projectName)
        if ('found' in project) return project
        projectId = project.id
      }
      return { kind: 'assign-client', date, blockId, clientId: client.id, projectId }
    }
    case 'mark_meeting': {
      // The interactive proposal path resolves ambiguity with a clarifying
      // question before reaching here; this fallback keeps the mapping total
      // for direct callers, turning several matches into an actionable miss.
      const resolution = resolveMarkMeetingTarget(db, input)
      if ('found' in resolution) return resolution
      if (resolution.kind === 'ambiguous') {
        return miss(`Several scheduled meetings match: ${resolution.candidates.map(describeMeeting).join(', ')}. Narrow it with meetingTime.`)
      }
      return resolution.command
    }
  }
}

/** The preview card body: the same deltas the Settings correction flow shows,
 *  in plain sentences. Everything here comes from the savepoint dry-run. */
export function renderCorrectionPreviewCard(preview: CorrectionPreview): string {
  const lines: string[] = [`${preview.description}.`]
  for (const delta of preview.blocks) {
    const before = `“${delta.labelBefore}” (${fmtClock(delta.startMsBefore)}–${fmtClock(delta.endMsBefore)})`
    if (delta.labelAfter == null) {
      lines.push(`${before} → removed from the day`)
      continue
    }
    const after = `“${delta.labelAfter}” (${fmtClock(delta.startMsAfter ?? delta.startMsBefore)}–${fmtClock(delta.endMsAfter ?? delta.endMsBefore)})`
    if (before !== after) lines.push(`${before} → ${after}`)
  }
  if (preview.totalSecondsBefore !== preview.totalSecondsAfter) {
    lines.push(`Day total: ${fmtDuration(preview.totalSecondsBefore)} → ${fmtDuration(preview.totalSecondsAfter)}`)
  }
  if (preview.blockCountBefore !== preview.blockCountAfter) {
    lines.push(`Blocks: ${preview.blockCountBefore} → ${preview.blockCountAfter}`)
  }
  for (const app of preview.apps.slice(0, 3)) {
    lines.push(`${app.appName}: ${fmtDuration(app.secondsBefore)} → ${fmtDuration(app.secondsAfter)} in Apps`)
  }
  lines.push(...preview.surfaces)
  lines.push('Reversible — it can be undone afterwards.')
  return lines.join('\n')
}

export type ProposeCorrectionOutcome =
  | {
      applied: true
      correctionId: string
      description: string
      preview: CorrectionPreview
      note: string
    }
  | Miss
  | { applied: false; reason: string; userNote?: string }

export async function runCorrectionProposal(
  deps: CorrectionToolDeps,
  input: ProposeCorrectionInput,
): Promise<ProposeCorrectionOutcome> {
  const { db } = deps
  let command: CorrectionCommand
  if (input.action === 'mark_meeting') {
    // Meetings resolve by title/time against the day's meeting resolution;
    // when several match, the EXISTING clarification machinery asks which —
    // one short question with the candidates as options.
    const resolution = resolveMarkMeetingTarget(db, input)
    if ('found' in resolution) return resolution
    if (resolution.kind === 'ambiguous') {
      const options = resolution.candidates.map(describeMeeting)
      if (deps.signal?.aborted) throw new Error('aborted')
      const answer = await deps.askUser({
        question: 'A few scheduled meetings match — which one do you mean?',
        options,
        allowFreeText: true,
      })
      const normalized = answer.trim()
      if (!normalized || normalized.startsWith('(')) {
        return { applied: false, reason: 'No answer — nothing was changed. Do not re-ask this turn.' }
      }
      const lower = normalized.toLowerCase()
      const chosen = resolution.candidates.find((_, index) => options[index].toLowerCase() === lower)
        ?? (() => {
          const textual = resolution.candidates.filter((candidate) =>
            candidate.title.toLowerCase().includes(lower) || fmtClock(candidate.startMs) === normalized)
          return textual.length === 1 ? textual[0] : null
        })()
      if (!chosen) {
        return {
          applied: false,
          reason: 'The user did not pick one of the matching meetings — nothing was changed. Read their note and propose again.',
          userNote: normalized,
        }
      }
      command = { kind: 'mark-meeting', date: input.date, meeting: chosen, status: resolution.status }
    } else {
      command = resolution.command
    }
  } else {
    const mapped = toCorrectionCommand(db, input)
    if ('found' in mapped) return mapped
    command = mapped
  }

  const live = deps.hooks?.resolveLiveSession?.(command.date) ?? null
  let preview: CorrectionPreview
  try {
    preview = previewCorrection(db, command, live)
  } catch (error) {
    return miss(error instanceof Error ? error.message : 'The correction could not be previewed.')
  }

  if (deps.signal?.aborted) throw new Error('aborted')
  const markStateBefore = markMeetingLedgerState(db, command)
  const answer = await deps.askUser({
    question: renderCorrectionPreviewCard(preview),
    options: [APPLY_OPTION, CANCEL_OPTION],
    allowFreeText: true,
  })

  const normalized = answer.trim()
  // The no-answer timeout note arrives parenthesized — treat it as silence:
  // silence is never consent, nothing is applied.
  if (!normalized || normalized.startsWith('(')) {
    return { applied: false, reason: 'No answer — nothing was changed. Do not re-propose this turn.' }
  }
  const lower = normalized.toLowerCase()
  const confirmed = lower === APPLY_OPTION.toLowerCase() || CONFIRM_RE.test(normalized)
  const declined = lower === CANCEL_OPTION.toLowerCase() || DECLINE_RE.test(normalized)

  if (!confirmed) {
    if (declined) {
      return { applied: false, reason: 'The user declined — nothing was changed. Acknowledge briefly and move on.' }
    }
    // Free text is never consent. It is the user's adjustment — hand it back
    // to the model so it can re-propose a corrected version.
    return {
      applied: false,
      reason: 'The user replied with an adjustment instead of confirming — nothing was changed. Read their note and propose the corrected version.',
      userNote: normalized,
    }
  }

  // Stale-preview guard: the day may have changed while the card sat on
  // screen (a live block advanced, another correction landed, evidence
  // arrived, the calendar re-synced). Recompute the dry-run and compare the
  // target blocks' BEFORE fingerprints — and, for a meeting mark, the target
  // meeting's ledger state — a preview that no longer matches reality expires
  // and applies nothing (ai-agent.md: a stale preview cannot apply).
  try {
    const recheck = previewCorrection(db, command, deps.hooks?.resolveLiveSession?.(command.date) ?? null)
    const fingerprint = (p: CorrectionPreview): string =>
      p.blocks.map((b) => `${b.blockId}|${b.labelBefore}|${b.startMsBefore}|${b.endMsBefore}|${b.categoryBefore}`).join('\n')
    if (fingerprint(recheck) !== fingerprint(preview) || markMeetingLedgerState(db, command) !== markStateBefore) {
      return {
        applied: false,
        reason: 'The day changed while the preview was on screen, so the preview expired and nothing was applied. Re-read the day and propose again.',
      }
    }
  } catch (error) {
    // The re-check could not even resolve the target — the block rebuilt or
    // the scheduled meeting re-synced away. Same verdict: expired, untouched.
    const detail = error instanceof Error ? ` (${error.message})` : ''
    return {
      applied: false,
      reason: `The day changed while the preview was on screen, so the preview expired and nothing was applied.${detail}`,
    }
  }

  try {
    deps.hooks?.onBeforeApply?.(command)
    const result = applyCorrection(db, command, live)
    deps.hooks?.onApplied?.(command.date)
    return {
      applied: true,
      correctionId: result.correctionId,
      description: result.description,
      preview,
      note: 'Applied. Timeline, Apps, search, and future answers now use the corrected facts. It can be undone with undo_correction or from the Timeline.',
    }
  } catch (error) {
    return miss(error instanceof Error ? error.message : 'The correction could not be applied.')
  }
}

export type UndoCorrectionOutcome =
  | { undone: true; description: string; note: string }
  | { undone: false; reason: string }

export async function runCorrectionUndo(
  deps: CorrectionToolDeps,
  input: { correctionId: string },
): Promise<UndoCorrectionOutcome> {
  const row = deps.db.prepare(
    `SELECT id, date, description, undone_at FROM correction_undo_log WHERE id = ?`,
  ).get(input.correctionId) as { id: string; date: string; description: string; undone_at: number | null } | undefined
  if (!row) return { undone: false, reason: 'No correction with that id exists.' }
  if (row.undone_at != null) return { undone: false, reason: 'That correction was already undone.' }

  if (deps.signal?.aborted) throw new Error('aborted')
  const answer = await deps.askUser({
    question: `Undo “${row.description}”? The day goes back to how it was before this correction.`,
    options: [UNDO_OPTION, KEEP_OPTION],
    allowFreeText: true,
  })
  const normalized = answer.trim()
  if (!normalized || normalized.startsWith('(')) {
    return { undone: false, reason: 'No answer — the correction stays. Do not re-ask this turn.' }
  }
  const confirmed = normalized.toLowerCase() === UNDO_OPTION.toLowerCase()
    || /^(undo( it)?|yes|confirm|revert)\b/i.test(normalized)
  if (!confirmed) {
    return { undone: false, reason: 'The user kept the correction — nothing was undone.' }
  }

  try {
    const result = undoCorrection(deps.db, input.correctionId)
    if (result.undone) deps.hooks?.onApplied?.(row.date)
    return result.undone
      ? { undone: true, description: result.description, note: 'Undone. Every surface shows the pre-correction facts again.' }
      : { undone: false, reason: 'That correction was already undone.' }
  } catch (error) {
    return { undone: false, reason: error instanceof Error ? error.message : 'The undo failed.' }
  }
}

export function buildCorrectionTools(deps: CorrectionToolDeps) {
  return {
    propose_correction: tool({
      description: 'Fix the user\'s day when they say a block or a meeting is wrong ("that was the ACME kickoff", "I was at lunch 12-1", "I didn\'t attend the 2pm ACME meeting"). Proposes ONE reversible Daylens correction; the user sees a preview card of exactly what will change (labels, times, day totals, Apps, meeting buckets, search, AI answers) and confirms or cancels — nothing changes without their confirmation, so never claim the day was fixed unless this tool returned applied: true. Get blockId from get_day_overview first. Actions: rename, change_category, adjust_time (HH:MM), merge (2+ blockIds), split (at HH:MM), exclude_block (removes the stretch from every surface, reversibly), exclude_evidence (drop one app or site from a block), assign_client (by client/project name; empty clientName clears), mark_meeting (a SCHEDULED meeting was attended, skipped, moved, or unrelated to nearby call time — or clear an earlier mark; no blockId: give meetingTitle and/or meetingTime and the meeting resolves from the day\'s calendar, asking the user which when several match). Permanent deletion is not available here — that stays in the app\'s own confirmed flow.',
      inputSchema: z.object({
        action: z.enum(CORRECTION_ACTIONS),
        date: DATE,
        blockId: z.string().min(1).optional().describe('The target block\'s blockId from get_day_overview'),
        blockIds: z.array(z.string().min(1)).max(12).optional().describe('merge only: every block to merge'),
        label: z.string().min(1).max(120).optional().describe('rename / adjust_time: the human label, naming the activity ("Lunch", "ACME kickoff"), never the app'),
        category: z.string().optional().describe('change_category: development, communication, research, writing, aiTools, design, browsing, meetings, entertainment, email, productivity, social, system, uncategorized'),
        startTime: CLOCK.optional().describe('adjust_time: new start'),
        endTime: CLOCK.optional().describe('adjust_time: new end'),
        splitAt: CLOCK.optional().describe('split: the cut point, at least a minute inside the block'),
        excludeAppName: z.string().optional().describe('exclude_evidence: the app to drop from the block'),
        excludeSiteDomain: z.string().optional().describe('exclude_evidence: the site domain to drop from the block'),
        clientName: z.string().nullable().optional().describe('assign_client: client name (partial ok); null or empty clears the assignment'),
        projectName: z.string().nullable().optional().describe('assign_client: optional project name under that client'),
        meetingTitle: z.string().min(1).max(160).optional().describe('mark_meeting: the scheduled meeting\'s title or a distinctive fragment of it ("ACME kickoff", "standup")'),
        meetingTime: CLOCK.optional().describe('mark_meeting: the scheduled start time, when the user gives one ("the 2pm ACME meeting")'),
        meetingStatus: z.enum(MEETING_MARK_STATUSES).optional().describe('mark_meeting: attended = explicit confirmation they were there; skipped = it did not happen for them; moved = it happened at another time; unrelated = nearby meeting-app time was NOT this meeting; clear = withdraw an earlier mark'),
      }),
      execute: async (input) => runCorrectionProposal(deps, input as ProposeCorrectionInput),
    }),

    undo_correction: tool({
      description: 'Undo a correction previously applied with propose_correction (use its returned correctionId). The user confirms on a card first. Only the newest un-undone correction of a day can be undone.',
      inputSchema: z.object({
        correctionId: z.string().min(1).describe('The correctionId returned by propose_correction'),
      }),
      execute: async (input) => runCorrectionUndo(deps, input),
    }),
  }
}
