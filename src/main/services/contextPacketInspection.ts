// Context packet inspection (DEV-183, agent-runtime-and-context.md §Context
// inspection): "what did the model see for this answer", assembled from the
// recorded ledger row — never by re-running assembly, never by calling a
// model. The inspection is read-only and honest:
//
//   grouped — every packet kind appears (empty or not), so the view can state
//     plainly that e.g. no file contents were sent;
//   reasoned — each item keeps its recorded "why was this included" reason,
//     source type, sensitivity, and content version;
//   omissions in plain language — what was considered and deliberately not
//     sent, and why;
//   deletion-coherent — the packet is a historical disclosure record: content
//     that already left the device cannot be un-sent by deleting the evidence
//     later (the deletion machinery separately deletes whole packet rows whose
//     text is in scope of a purge — see trackingHistory's generic scrub). For
//     the rows that remain, each item is checked against the evidence backing
//     it TODAY and labeled when that evidence has since been deleted, the
//     block recomputed, or the file grant revoked (spec §Privacy and
//     disclosure: deletion removes material from FUTURE packets; the recorded
//     disclosure stays truthful about the past);
//   claim-backed — WO-76 adds the answer's own evidence: which claims were
//     traced to which recorded item, which figures Daylens computed instead of
//     letting the model choose them, and what the answer had to admit it could
//     not back.
//
// The inspector never exposes provider system prompts, hidden model
// reasoning, credentials, or security instructions — everything here comes
// from the packet the person's own data produced (spec §Context inspection).
// The tool trace and the answer evidence are both re-projected from the
// persisted row on the way out rather than parsed and trusted, so that
// guarantee holds at the boundary and not only upstream of it.
import type Database from 'better-sqlite3'
import { aggregateToolsConsulted } from '@shared/agentTrail'
import type {
  AIThreadMessageMetadata,
  ContextPacketAnswerEvidence,
  ContextPacketClaimKind,
  ContextPacketComputedFigure,
  ContextPacketEvidenceSource,
  ContextPacketEvidenceState,
  ContextPacketInspection,
  ContextPacketInspectionGroup,
  ContextPacketInspectionItem,
  ContextPacketInspectionOmission,
  ContextPacketListEntry,
  ContextPacketSupportedClaim,
  ContextPacketUnsupportedClaim,
  ContextPacketToolConsulted,
} from '@shared/types'
import {
  getContextPacketById,
  getContextPacketForMessage,
  listContextPackets,
  type ContextItemKind,
  type ContextPacketItem,
  type ContextPacketOmission,
  type StoredContextPacket,
} from './contextPacket'

/** Plain-language group headings, in the packet's own kind order. */
export const KIND_LABELS: Record<ContextItemKind, string> = {
  day_fact: 'Facts from your timeline',
  corrected_fact: 'Things Daylens knows about you',
  entity: 'People, projects, and things the question named',
  search_exact: 'Moments matched by exact search',
  search_semantic: 'Moments matched by meaning',
  file_excerpt: 'File excerpts',
}

const KIND_ORDER: ContextItemKind[] = [
  'day_fact',
  'corrected_fact',
  'entity',
  'search_exact',
  'search_semantic',
  'file_excerpt',
]

const OMISSION_KIND_PHRASES: Record<ContextItemKind, [singular: string, plural: string]> = {
  day_fact: ['timeline fact', 'timeline facts'],
  corrected_fact: ['memory fact', 'memory facts'],
  entity: ['entity', 'entities'],
  search_exact: ['search match', 'search matches'],
  search_semantic: ['by-meaning match', 'by-meaning matches'],
  file_excerpt: ['file excerpt', 'file excerpts'],
}

const OMISSION_REASON_PHRASES: Record<ContextPacketOmission['reason'], string> = {
  excluded: 'held back by an applicable exclusion',
  deleted: 'held back because the supporting material was deleted',
  unauthorized: 'held back because the required permission was not granted',
  unavailable: 'held back because the supporting source was unavailable',
  'high-sensitivity': 'held back as high-sensitivity — sending it needs its own explicit permission',
  'tracking-excluded': 'held back by your tracking exclusions',
  'context-budget': 'left for on-demand retrieval because the initial context budget was full',
}

/** "1 file excerpt was considered and not sent: held back as high-sensitivity…" */
export function omissionLabel(omission: ContextPacketOmission): string {
  const [singular, plural] = OMISSION_KIND_PHRASES[omission.kind] ?? ['item', 'items']
  const noun = omission.count === 1 ? singular : plural
  const verb = omission.count === 1 ? 'was' : 'were'
  const reason = OMISSION_REASON_PHRASES[omission.reason] ?? omission.reason
  return `${omission.count} ${noun} ${verb} considered and not sent: ${reason}`
}

// ─── Evidence presence ───────────────────────────────────────────────────────
// Each recorded item names its backing record by typed identity. The check is
// per identity form and conservative: a lookup failure (older install missing
// a table, malformed identity) reports 'unverified' rather than guessing.

function exists(db: Database.Database, sql: string, ...params: unknown[]): boolean {
  try {
    return db.prepare(sql).get(...params) != null
  } catch {
    return false
  }
}

export interface EvidencePresence {
  state: ContextPacketEvidenceState
  note: string | null
}

const PRESENT: EvidencePresence = { state: 'present', note: null }

/**
 * Is the evidence behind this disclosed item still part of the record today?
 * Identity forms mirror the assembler's: block:<id>, fact:<id>, entity:<id>,
 * session:<rowid>, browser:<id>, artifact:<id>, file:<path>.
 */
export function resolveEvidencePresence(
  db: Database.Database,
  item: Pick<ContextPacketItem, 'identity' | 'kind'>,
): EvidencePresence {
  const separator = item.identity.indexOf(':')
  if (separator <= 0) {
    return { state: 'unverified', note: 'Daylens cannot check whether this evidence still exists.' }
  }
  const prefix = item.identity.slice(0, separator)
  const id = item.identity.slice(separator + 1)
  switch (prefix) {
    case 'block':
      // Block ids churn on reprojection, so a missing or invalidated row means
      // "no longer in the current timeline" — recomputed or deleted — not
      // necessarily a person's deletion. Say exactly that.
      return exists(db, `SELECT 1 FROM timeline_blocks WHERE id = ? AND invalidated_at IS NULL`, id)
        ? PRESENT
        : {
            state: 'deleted',
            note: 'This timeline block is no longer in your current record — it was recomputed or deleted after this answer.',
          }
    case 'fact':
      // Memory facts live in two stores of one profile: evidence-drafted rows
      // in work_memory_facts and confirmed supplied rows (smf_…) in
      // supplied_memory_facts, which deletes by row removal (DEV-185).
      return exists(db, `SELECT 1 FROM work_memory_facts WHERE id = ? AND status = 'active'`, id)
          || exists(db, `SELECT 1 FROM supplied_memory_facts WHERE id = ?`, id)
        ? PRESENT
        : { state: 'deleted', note: 'This memory fact has since been forgotten.' }
    case 'entity':
      // A merged entity still exists (it points at its survivor); only a
      // deleted or missing row is gone.
      return exists(db, `SELECT 1 FROM entities WHERE id = ? AND status != 'deleted'`, id)
        ? PRESENT
        : { state: 'deleted', note: 'This entity has since been deleted from your memory.' }
    case 'session':
      // Search hits address memory records by rowid, with legacy app_sessions
      // sharing the id space as a fallback — mirror both.
      return exists(db, `SELECT 1 FROM memory_records WHERE rowid = ? AND deleted_at IS NULL`, id)
          || exists(db, `SELECT 1 FROM app_sessions WHERE id = ?`, id)
        ? PRESENT
        : { state: 'deleted', note: 'This moment has since been deleted from your history.' }
    case 'browser':
      return exists(db, `SELECT 1 FROM website_visits WHERE id = ?`, id)
        ? PRESENT
        : { state: 'deleted', note: 'This page visit has since been deleted from your history.' }
    case 'artifact':
      return exists(db, `SELECT 1 FROM ai_artifacts WHERE id = ?`, id)
        ? PRESENT
        : { state: 'deleted', note: 'This exported file has since been deleted.' }
    case 'file':
      // The excerpt was disclosed under a model-readable grant on exactly this
      // path. A revoked grant also deleted its derived text (DEV-184), so the
      // honest state is "access revoked" rather than pretending the read never
      // happened.
      return exists(
        db,
        `SELECT 1 FROM file_access_grants WHERE path = ? AND state = 'model_readable' AND revoked_at IS NULL`,
        id,
      )
        ? PRESENT
        : {
            state: 'access_revoked',
            note: 'Access to this file has since been revoked and its extracted text deleted. This excerpt remains part of the disclosure record because it was already sent.',
          }
    default:
      return { state: 'unverified', note: 'Daylens cannot check whether this evidence still exists.' }
  }
}

// ─── Tools consulted ─────────────────────────────────────────────────────────
// The packet is recorded before the model call, so tool calls live in the
// persisted turn trace, not in the packet: read them from the assistant
// message the packet was later bound to. Only tool NAMES and call counts are
// exposed — never the traced inputs/outputs, which the message view already
// governs separately. An mcp_-prefixed name is one of the person's own MCP
// servers (the namespace connectMcpTools applies), identified as such.

/** The persisted turn record bound to this message, or null when there is
 *  none (no id, no row, no metadata, unreadable JSON). */
function readTurnMetadata(
  db: Database.Database,
  messageId: number | null,
): AIThreadMessageMetadata | null {
  if (messageId == null) return null
  let metadataJson: string | undefined
  try {
    const row = db.prepare(`SELECT metadata_json FROM ai_messages WHERE id = ?`).get(messageId) as
      | { metadata_json: string }
      | undefined
    metadataJson = row?.metadata_json
  } catch {
    return null
  }
  if (!metadataJson) return null
  try {
    return JSON.parse(metadataJson) as AIThreadMessageMetadata
  } catch {
    return null
  }
}

/** Tools called during the exchange, in first-use order; null when no turn
 *  record is bound to the message. */
export function toolsConsultedForMessage(
  db: Database.Database,
  messageId: number | null,
): ContextPacketToolConsulted[] | null {
  const metadata = readTurnMetadata(db, messageId)
  if (!metadata) return null
  return aggregateToolsConsulted(metadata.agent?.toolTrace)
}

// ─── Answer evidence (WO-76 / AC-AIA-002.3) ──────────────────────────────────
// The read half of the answer-evidence boundary. The write half
// (agent/answerEvidence) already narrowed the turn's evidence before it was
// persisted, but by the time it is read back it is JSON on a row that any
// past or future writer could have shaped differently, so it is projected
// again here rather than parsed and trusted.
//
// The projection is a strict allowlist: each output field is built from one
// named input field of an expected primitive type, unions are checked against
// their members, free text is bounded, and anything else on the object is
// dropped on the floor. A writer that stuffed a system prompt, an API key, or
// another turn's text into an extra key would therefore not get it past this
// function and onto the IPC surface.

/** Long enough for a real claim, an evidence statement, or a computed
 *  figure's sentence; short enough that no pasted document or serialized
 *  payload can ride out through a text field. */
const EVIDENCE_TEXT_MAX = 400

const CLAIM_KINDS: readonly ContextPacketClaimKind[] = ['duration', 'clock_time', 'date', 'entity']
const EVIDENCE_SOURCES: readonly ContextPacketEvidenceSource[] = ['packet', 'tool', 'computed']

/** A non-empty bounded string, or null for anything else (missing, wrong
 *  type, blank). Callers decide whether null drops the whole row. */
function evidenceText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  return text.length > EVIDENCE_TEXT_MAX ? `${text.slice(0, EVIDENCE_TEXT_MAX - 1)}…` : text
}

function memberOf<T extends string>(value: unknown, members: readonly T[]): T | null {
  return typeof value === 'string' && (members as readonly string[]).includes(value) ? (value as T) : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Project a list, dropping every element the shape rejects. A malformed row
 *  is left out rather than rendered half-built or guessed at. */
function projectList<T>(value: unknown, project: (row: Record<string, unknown>) => T | null): T[] {
  if (!Array.isArray(value)) return []
  const out: T[] = []
  for (const entry of value) {
    const row = asRecord(entry)
    if (!row) continue
    const projected = project(row)
    if (projected) out.push(projected)
  }
  return out
}

function projectComputedFigure(row: Record<string, unknown>): ContextPacketComputedFigure | null {
  const subject = evidenceText(row.subject)
  const rendered = evidenceText(row.rendered)
  const identity = evidenceText(row.identity)
  const statement = evidenceText(row.statement)
  if (!subject || !rendered || !identity || !statement) return null
  return { subject, rendered, identity, statement, replaced: evidenceText(row.replaced) }
}

function projectSupportedClaim(row: Record<string, unknown>): ContextPacketSupportedClaim | null {
  const kind = memberOf(row.kind, CLAIM_KINDS)
  const source = memberOf(row.source, EVIDENCE_SOURCES)
  const text = evidenceText(row.text)
  const identity = evidenceText(row.identity)
  const statement = evidenceText(row.statement)
  if (!kind || !source || !text || !identity || !statement) return null
  return { kind, text, identity, source, statement }
}

function projectUnsupportedClaim(row: Record<string, unknown>): ContextPacketUnsupportedClaim | null {
  const kind = memberOf(row.kind, CLAIM_KINDS)
  const text = evidenceText(row.text)
  if (!kind || !text) return null
  return { kind, text }
}

/**
 * The inspectable answer-evidence record, rebuilt field by field from a
 * persisted turn record. Null when the value is not an evidence record at all
 * — a turn from before evidence coverage existed carries no such key, and a
 * corrupt one carries something that is not an object. The inspector states
 * that honestly; it never reconstructs coverage after the fact.
 */
export function projectAnswerEvidence(value: unknown): ContextPacketAnswerEvidence | null {
  const row = asRecord(value)
  if (!row) return null
  const disclosedUncertainties = Array.isArray(row.disclosedUncertainties)
    ? row.disclosedUncertainties.map(evidenceText).filter((text): text is string => text !== null)
    : []
  return {
    computedFigures: projectList(row.computedFigures, projectComputedFigure),
    supportedClaims: projectList(row.supportedClaims, projectSupportedClaim),
    unsupportedClaims: projectList(row.unsupportedClaims, projectUnsupportedClaim),
    disclosedUncertainties,
  }
}

/** How the bound answer's claims were backed; null when no turn record is
 *  bound to the message or the bound one recorded no evidence. */
export function answerEvidenceForMessage(
  db: Database.Database,
  messageId: number | null,
): ContextPacketAnswerEvidence | null {
  const metadata = readTurnMetadata(db, messageId)
  if (!metadata) return null
  return projectAnswerEvidence(metadata.agent?.evidence)
}

// ─── Assembly ────────────────────────────────────────────────────────────────

function toInspectionItem(db: Database.Database, item: ContextPacketItem): ContextPacketInspectionItem {
  const presence = resolveEvidencePresence(db, item)
  return {
    identity: item.identity,
    kind: item.kind,
    sourceType: item.sourceType,
    statement: item.statement,
    version: item.version,
    reason: item.reason,
    sensitivity: item.sensitivity,
    date: item.date,
    evidenceState: presence.state,
    evidenceNote: presence.note,
  }
}

/**
 * The full read-only inspection of one recorded packet. Pure over the stored
 * row apart from the per-item presence checks.
 */
export function assembleContextPacketInspection(
  db: Database.Database,
  stored: StoredContextPacket,
): ContextPacketInspection {
  const { packet } = stored
  const groups: ContextPacketInspectionGroup[] = KIND_ORDER.map((kind) => ({
    kind,
    label: KIND_LABELS[kind],
    items: packet.items
      .filter((item) => item.kind === kind)
      .map((item) => toInspectionItem(db, item)),
  }))
  const omissions: ContextPacketInspectionOmission[] = packet.disclosure.omissions.map((omission) => ({
    kind: omission.kind,
    count: omission.count,
    reason: omission.reason,
    label: omissionLabel(omission),
  }))
  return {
    packetId: packet.id,
    exchangeKind: stored.exchangeKind,
    purpose: packet.purpose as ContextPacketInspection['purpose'],
    threadId: stored.threadId,
    messageId: stored.messageId,
    question: packet.request.originalText,
    dates: packet.request.dates,
    timezone: packet.person.timezone,
    createdAt: stored.createdAt,
    policyVersion: packet.policyVersion,
    contentFingerprint: packet.contentFingerprint,
    destination: stored.destination,
    leftDevice: packet.disclosure.leftDevice,
    itemCount: packet.disclosure.itemCount,
    toolsConsulted: toolsConsultedForMessage(db, stored.messageId),
    answerEvidence: answerEvidenceForMessage(db, stored.messageId),
    groups,
    conflicts: packet.conflicts.map((conflict) => ({
      identity: conflict.identity,
      detail: conflict.detail,
      resolvedBy: conflict.resolvedBy,
    })),
    gaps: packet.gaps.map((gap) => ({ date: gap.date, detail: gap.detail, kind: gap.kind })),
    permissions: packet.permissions.map((permission) => ({
      kind: permission.kind,
      scopeKind: permission.scopeKind,
      path: permission.path,
      state: permission.state,
      allowHighSensitivity: permission.allowHighSensitivity,
    })),
    omissions,
  }
}

/**
 * Look the packet up by its id or by the assistant message it answered, then
 * assemble the inspection. Null when nothing was recorded — the UI states
 * that honestly instead of inventing a view.
 */
export function inspectContextPacket(
  db: Database.Database,
  ref: { packetId?: string | null; messageId?: number | null },
): ContextPacketInspection | null {
  const stored = ref.packetId
    ? getContextPacketById(db, ref.packetId)
    : typeof ref.messageId === 'number'
      ? getContextPacketForMessage(db, ref.messageId)
      : null
  return stored ? assembleContextPacketInspection(db, stored) : null
}

/** Lightweight rows for the packet browser — no packet JSON crosses IPC. */
export function listContextPacketEntries(
  db: Database.Database,
  options: { limit?: number } = {},
): ContextPacketListEntry[] {
  return listContextPackets(db, { limit: options.limit ?? 30 }).map((stored) => ({
    packetId: stored.id,
    exchangeKind: stored.exchangeKind,
    threadId: stored.threadId,
    messageId: stored.messageId,
    question: stored.packet.request.originalText,
    destination: stored.destination,
    createdAt: stored.createdAt,
    itemCount: stored.packet.disclosure.itemCount,
    counts: { ...stored.packet.disclosure.counts } as Record<string, number>,
  }))
}
