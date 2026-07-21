// Tell the agent about your meetings (DEV-199 completion; timeline.md
// §Meetings, ai-agent.md §Daylens actions). "I didn't attend the 2pm ACME
// meeting", "that Zoom block was the ACME kickoff", "mark the standup as
// moved" — the chat agent turns the sentence into the mark-meeting correction
// and runs it through the SAME propose → preview → confirm → apply → undo
// machinery as every other correction. What must hold:
//   - each mark kind (attended / skipped / moved / unrelated) lands through
//     the REAL sendMessage seam: model tool call → preview card → explicit
//     confirmation → durable, undoable correction;
//   - the preview card shows the cross-surface effect before anything is
//     written: the meeting-bucket change and the search-label change;
//   - an applied mark propagates: the day meeting report re-buckets, the wrap
//     enrichment counts follow, and exact search flips Scheduled:/Meeting:;
//   - undo restores every one of those surfaces;
//   - the target resolves by title/time from the day's meeting resolution;
//     several matches ask the user which (the existing clarification
//     machinery), none names what IS scheduled;
//   - a preview that outlives its meeting — the calendar re-synced, or the
//     mark changed underneath the card — expires and applies nothing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import type Database from 'better-sqlite3'
import type { CalendarSignal } from '../src/shared/types.ts'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { setTestDb, clearTestDb } from './support/database-stub.mjs'
import { __resetSettings, __setSettings, setApiKey } from './support/settings-stub.mjs'
import { sendMessage } from '../src/main/jobs/aiService.ts'
import { resolveDayMeetingReport } from '../src/main/services/meetingResolution.ts'
import { resolveDayEnrichment } from '../src/main/services/enrichmentResolve.ts'
import { putExternalSignal } from '../src/main/services/externalSignals.ts'
import { indexMemoryForDay } from '../src/main/services/memoryIndex.ts'
import { applyCorrection } from '../src/main/services/correctionCommands.ts'
import {
  buildCorrectionTools,
  resolveMarkMeetingTarget,
  type CorrectionToolDeps,
} from '../src/main/agent/correctionTools.ts'
import type { AgentQuestion } from '../src/main/agent/interactionTools.ts'

const TEST_DATE = '2026-04-22'

function localMs(hour: number, minute = 0): number {
  return new Date(2026, 3, 22, hour, minute, 0, 0).getTime()
}

function insertZoom(db: Database.Database, startHour: number, startMinute: number, durationMinutes: number): void {
  const startTime = localMs(startHour, startMinute)
  const endTime = startTime + durationMinutes * 60_000
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, canonical_app_id, capture_source, capture_version
    ) VALUES ('us.zoom.xos', 'Zoom', ?, ?, ?, 'meetings', 1, 'Zoom Meeting', 'Zoom', 'us.zoom.xos', 'test', 1)
  `).run(startTime, endTime, durationMinutes * 60)
}

function storeCalendar(db: Database.Database, events: CalendarSignal['events']): void {
  // putExternalSignal (not a raw INSERT) so meeting entities are minted — the
  // same path the calendar probe and connectors use.
  putExternalSignal(db, TEST_DATE, 'calendar', { events } satisfies CalendarSignal)
}

function meetingStatement(db: Database.Database): string {
  return (db.prepare(`SELECT statement FROM memory_records WHERE record_kind = 'meeting'`).get() as { statement: string }).statement
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

function response(chunks: unknown[]) {
  return { stream: simulateReadableStream({ chunks }) }
}

/** A model that makes exactly one tool call, then answers in plain text. */
function toolCallModel(toolName: string, input: Record<string, unknown>): MockLanguageModelV3 {
  let modelCall = 0
  return new MockLanguageModelV3({
    doStream: async () => {
      modelCall += 1
      if (modelCall === 1) {
        return response([
          { type: 'tool-call', toolCallId: `${toolName}-1`, toolName, input: JSON.stringify(input) },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
        ] as never[])
      }
      return response([
        { type: 'text-start', id: 'answer-1' },
        { type: 'text-delta', id: 'answer-1', delta: 'Done — the meeting mark is applied.' },
        { type: 'text-end', id: 'answer-1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
      ] as never[])
    },
  })
}

interface SeamTurn {
  cards: AgentQuestion[]
  toolOutcome: Record<string, unknown>
}

/** One chat turn through the REAL sendMessage seam: the mock model proposes
 *  the correction, the user answers the card, the turn completes. */
async function markMeetingTurn(
  db: Database.Database,
  options: {
    message: string
    tool?: string
    input: Record<string, unknown>
    answer: string | ((question: AgentQuestion) => string)
    requestId: string
  },
): Promise<SeamTurn> {
  const cards: AgentQuestion[] = []
  const toolName = options.tool ?? 'propose_correction'
  setTestDb(db)
  __setSettings({ aiProvider: 'anthropic', aiChatProvider: 'anthropic' })
  await setApiKey('anthropic', 'test-key')
  try {
    const result = await sendMessage(
      { message: options.message, threadId: null, clientRequestId: options.requestId },
      {
        model: toolCallModel(toolName, options.input),
        onAgentQuestion: async (question) => {
          cards.push(question)
          return typeof options.answer === 'function' ? options.answer(question) : options.answer
        },
      },
    )
    const trace = result.assistantMessage.agent?.toolTrace.find((entry) => entry.tool === toolName)
    assert.ok(trace, `the turn called ${toolName}`)
    return { cards, toolOutcome: JSON.parse(trace!.output) as Record<string, unknown> }
  } finally {
    __resetSettings()
    clearTestDb()
  }
}

function undoLogCount(db: Database.Database): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM correction_undo_log`).get() as { c: number }).c
}

// ─── attended: explicit confirmation, everywhere, and undo restores it ───────

test('"I attended the 10am quarterly planning": the mark applies through sendMessage, propagates to report, wrap, and search — and undo restores all three', async () => {
  const db = createProductionTestDatabase()
  try {
    storeCalendar(db, [{ title: 'Quarterly planning', startClock: '10:00', durationMinutes: 60, attendeeCount: 4 }])
    indexMemoryForDay(db, TEST_DATE)
    assert.equal(resolveDayMeetingReport(db, TEST_DATE)!.calendarOnlyCount, 1)
    assert.match(meetingStatement(db), /^Scheduled: /)

    const turn = await markMeetingTurn(db, {
      message: 'I did attend the 10am quarterly planning meeting, mark it.',
      input: { action: 'mark_meeting', date: TEST_DATE, meetingTitle: 'Quarterly planning', meetingTime: '10:00', meetingStatus: 'attended' },
      answer: 'Apply correction',
      requestId: 'meeting-attended-1',
    })

    // The preview card showed the cross-surface effect BEFORE the write:
    // the bucket change and the search-label change.
    assert.equal(turn.cards.length, 1)
    const card = turn.cards[0]
    assert.deepEqual(card.options, ['Apply correction', 'Cancel'])
    assert.match(card.question, /Mark "Quarterly planning" as attended/)
    assert.match(card.question, /Meeting buckets: scheduled only → attended \(matched\)/)
    assert.match(card.question, /Search will label it "Meeting: Quarterly planning" instead of "Scheduled: Quarterly planning"/)
    assert.match(card.question, /Reversible/)

    assert.equal(turn.toolOutcome.applied, true)
    const correctionId = turn.toolOutcome.correctionId as string
    assert.equal(typeof correctionId, 'string')

    // Propagation: the day report re-buckets, the wrap counts follow, exact
    // search upgrades the record.
    const marked = resolveDayMeetingReport(db, TEST_DATE)!
    assert.equal(marked.matchedCount, 1)
    assert.equal(marked.calendarOnlyCount, 0)
    assert.equal(marked.meetings[0].marked, 'attended')
    assert.equal(marked.meetings[0].observedSeconds, null, 'a mark never invents observed minutes')
    const enrichment = resolveDayEnrichment(db, TEST_DATE, { focusEnabled: () => false, notesEnabled: false })!
    assert.equal(enrichment.meetings!.matched, 1)
    assert.equal(enrichment.meetings!.calendarOnly, 0)
    assert.match(meetingStatement(db), /^Meeting: /)

    // Undo through the same seam restores every surface.
    const undoTurn = await markMeetingTurn(db, {
      message: 'Actually, undo that.',
      tool: 'undo_correction',
      input: { correctionId },
      answer: 'Undo it',
      requestId: 'meeting-attended-undo-1',
    })
    assert.equal(undoTurn.toolOutcome.undone, true)
    const restored = resolveDayMeetingReport(db, TEST_DATE)!
    assert.equal(restored.calendarOnlyCount, 1)
    assert.equal(restored.meetings[0].marked, null)
    const restoredEnrichment = resolveDayEnrichment(db, TEST_DATE, { focusEnabled: () => false, notesEnabled: false })!
    assert.equal(restoredEnrichment.meetings!.matched, 0)
    assert.equal(restoredEnrichment.meetings!.calendarOnly, 1)
    assert.match(meetingStatement(db), /^Scheduled: /)
  } finally {
    db.close()
  }
})

// ─── skipped: a matched meeting the person says did not happen for them ──────

test('"I skipped the standup": the mark releases the supporting evidence — calendar-only again, the call stands on its own, wrap counts follow', async () => {
  const db = createProductionTestDatabase()
  try {
    storeCalendar(db, [{ title: 'Standup', startClock: '09:30', durationMinutes: 15, attendeeCount: 5 }])
    insertZoom(db, 9, 28, 18)
    assert.equal(resolveDayMeetingReport(db, TEST_DATE)!.matchedCount, 1)

    const turn = await markMeetingTurn(db, {
      message: 'I skipped the standup today.',
      input: { action: 'mark_meeting', date: TEST_DATE, meetingTitle: 'Standup', meetingStatus: 'skipped' },
      answer: 'Apply correction',
      requestId: 'meeting-skipped-1',
    })
    assert.equal(turn.toolOutcome.applied, true)
    assert.match(turn.cards[0].question, /Mark "Standup" as skipped/)
    assert.match(turn.cards[0].question, /Meeting buckets: attended \(matched\) → scheduled only/)

    const report = resolveDayMeetingReport(db, TEST_DATE)!
    assert.equal(report.matchedCount, 0)
    assert.equal(report.calendarOnlyCount, 1)
    assert.equal(report.capturedOnlyCount, 1, 'the real call still exists, on its own')
    assert.equal(report.meetings.find((m) => m.attendance === 'calendar_only')!.marked, 'skipped')
    const enrichment = resolveDayEnrichment(db, TEST_DATE, { focusEnabled: () => false, notesEnabled: false })!
    assert.equal(enrichment.meetings!.matched, 0)
    assert.equal(enrichment.meetings!.calendarOnly, 1)
    assert.equal(enrichment.meetings!.capturedOnly, 1)
  } finally {
    db.close()
  }
})

// ─── moved: scheduled context that happened at another time ──────────────────

test('"mark the design review as moved": the mark lands by title alone and the meeting stays scheduled context', async () => {
  const db = createProductionTestDatabase()
  try {
    storeCalendar(db, [{ title: 'Design review', startClock: '14:00', durationMinutes: 60, attendeeCount: 3 }])
    const turn = await markMeetingTurn(db, {
      message: 'The design review moved to tomorrow, mark it moved.',
      input: { action: 'mark_meeting', date: TEST_DATE, meetingTitle: 'design review', meetingStatus: 'moved' },
      answer: 'Apply correction',
      requestId: 'meeting-moved-1',
    })
    assert.equal(turn.toolOutcome.applied, true)
    assert.match(turn.cards[0].question, /Mark "Design review" as moved/)

    const report = resolveDayMeetingReport(db, TEST_DATE)!
    assert.equal(report.calendarOnlyCount, 1)
    assert.equal(report.matchedCount, 0)
    assert.equal(report.meetings[0].marked, 'moved')
    assert.equal(report.meetings[0].observedSeconds, null)
    assert.equal(undoLogCount(db), 1, 'the mark is durable, undoable product data')
  } finally {
    db.close()
  }
})

// ─── unrelated: the nearby call time was NOT this meeting ────────────────────

test('"that Zoom time wasn\'t the ACME kickoff": unrelated re-buckets the meeting and frees the evidence', async () => {
  const db = createProductionTestDatabase()
  try {
    storeCalendar(db, [{ title: 'ACME kickoff', startClock: '14:00', durationMinutes: 60, attendeeCount: 6 }])
    insertZoom(db, 14, 0, 60)
    assert.equal(resolveDayMeetingReport(db, TEST_DATE)!.matchedCount, 1)

    const turn = await markMeetingTurn(db, {
      message: 'That Zoom call at 2pm was not the ACME kickoff.',
      input: { action: 'mark_meeting', date: TEST_DATE, meetingTitle: 'ACME', meetingTime: '14:00', meetingStatus: 'unrelated' },
      answer: 'Apply correction',
      requestId: 'meeting-unrelated-1',
    })
    assert.equal(turn.toolOutcome.applied, true)
    assert.match(turn.cards[0].question, /Mark "ACME kickoff" as unrelated to your day/)
    assert.match(turn.cards[0].question, /stays scheduled context only/)

    const report = resolveDayMeetingReport(db, TEST_DATE)!
    assert.equal(report.matchedCount, 0)
    assert.equal(report.calendarOnlyCount, 1)
    assert.equal(report.capturedOnlyCount, 1)
    assert.equal(report.meetings.find((m) => m.attendance === 'calendar_only')!.marked, 'unrelated')
  } finally {
    db.close()
  }
})

// ─── Ambiguity: several matches ask the user which (existing machinery) ──────

test('an ambiguous meeting name raises ONE clarifying card with the candidates, then the normal preview card', async () => {
  const db = createProductionTestDatabase()
  try {
    storeCalendar(db, [
      { title: 'Sync with Alex', startClock: '14:00', durationMinutes: 30, attendeeCount: 2 },
      { title: 'Sync with Priya', startClock: '15:00', durationMinutes: 30, attendeeCount: 2 },
    ])
    const questions: AgentQuestion[] = []
    const deps: CorrectionToolDeps = {
      db,
      askUser: async (question) => {
        questions.push(question)
        return questions.length === 1 ? '"Sync with Priya" (15:00)' : 'Apply correction'
      },
      hooks: { resolveLiveSession: () => null },
    }
    const tools = buildCorrectionTools(deps)
    const outcome = await (tools.propose_correction as unknown as {
      execute: (input: unknown, options: unknown) => Promise<Record<string, unknown>>
    }).execute({ action: 'mark_meeting', date: TEST_DATE, meetingTitle: 'Sync', meetingStatus: 'skipped' }, {})

    assert.equal(questions.length, 2)
    assert.match(questions[0].question, /which one/i)
    assert.deepEqual(questions[0].options, ['"Sync with Alex" (14:00)', '"Sync with Priya" (15:00)'])
    assert.match(questions[1].question, /Mark "Sync with Priya" as skipped/)
    assert.equal(outcome.applied, true)

    const report = resolveDayMeetingReport(db, TEST_DATE)!
    const byTitle = new Map(report.meetings.map((m) => [m.title, m.marked]))
    assert.equal(byTitle.get('Sync with Priya'), 'skipped')
    assert.equal(byTitle.get('Sync with Alex'), null, 'only the chosen meeting is marked')
  } finally {
    db.close()
  }
})

test('no answer to the clarifying card marks nothing; an unknown meeting is an explicit miss naming the day\'s roster', async () => {
  const db = createProductionTestDatabase()
  try {
    storeCalendar(db, [
      { title: 'Sync with Alex', startClock: '14:00', durationMinutes: 30, attendeeCount: 2 },
      { title: 'Sync with Priya', startClock: '15:00', durationMinutes: 30, attendeeCount: 2 },
    ])
    const deps: CorrectionToolDeps = {
      db,
      askUser: async () => '(No answer is available right now — pick the most defensible reading.)',
      hooks: { resolveLiveSession: () => null },
    }
    const tools = buildCorrectionTools(deps)
    const execute = (input: unknown) => (tools.propose_correction as unknown as {
      execute: (input: unknown, options: unknown) => Promise<Record<string, unknown>>
    }).execute(input, {})

    const silent = await execute({ action: 'mark_meeting', date: TEST_DATE, meetingTitle: 'Sync', meetingStatus: 'skipped' })
    assert.equal(silent.applied, false, 'silence on the clarifying card is never consent')
    assert.equal(undoLogCount(db), 0)

    const unknown = await execute({ action: 'mark_meeting', date: TEST_DATE, meetingTitle: 'Budget review', meetingStatus: 'attended' })
    assert.equal(unknown.found, false)
    assert.match(String(unknown.reason), /Sync with Alex/, 'the miss names what IS scheduled')
    assert.match(String(unknown.reason), /Sync with Priya/)

    // Resolution itself is deterministic and sync-testable: title + time pins
    // one of several same-name candidates.
    const resolved = resolveMarkMeetingTarget(db, {
      action: 'mark_meeting', date: TEST_DATE, meetingTitle: 'Sync', meetingTime: '15:00', meetingStatus: 'moved',
    })
    assert.ok('kind' in resolved && resolved.kind === 'command')
    assert.deepEqual((resolved as { command: { meeting: unknown } }).command.meeting, {
      title: 'Sync with Priya', startMs: localMs(15, 0),
    })
  } finally {
    db.close()
  }
})

// ─── Stale previews expire ────────────────────────────────────────────────────

test('a preview that outlives its meeting expires: the calendar re-synced while the card sat open, so confirming applies nothing', async () => {
  const db = createProductionTestDatabase()
  try {
    storeCalendar(db, [{ title: 'Standup', startClock: '09:30', durationMinutes: 15, attendeeCount: 5 }])
    const turn = await markMeetingTurn(db, {
      message: 'I skipped the standup.',
      input: { action: 'mark_meeting', date: TEST_DATE, meetingTitle: 'Standup', meetingStatus: 'skipped' },
      answer: () => {
        // While the card is on screen, the connector re-syncs and the event
        // moves — the scheduled identity the preview was computed for is gone.
        storeCalendar(db, [{ title: 'Standup', startClock: '10:00', durationMinutes: 15, attendeeCount: 5 }])
        return 'Apply correction'
      },
      requestId: 'meeting-stale-1',
    })

    assert.equal(turn.toolOutcome.applied, false)
    assert.match(String(turn.toolOutcome.reason), /expired/i)
    const report = resolveDayMeetingReport(db, TEST_DATE)!
    assert.ok(report.meetings.every((m) => m.marked == null), 'no mark landed')
    assert.equal(undoLogCount(db), 0)
  } finally {
    db.close()
  }
})

test('a mark that changed underneath the card also expires the preview', async () => {
  const db = createProductionTestDatabase()
  try {
    storeCalendar(db, [{ title: 'Standup', startClock: '09:30', durationMinutes: 15, attendeeCount: 5 }])
    const questions: AgentQuestion[] = []
    const deps: CorrectionToolDeps = {
      db,
      askUser: async (question) => {
        questions.push(question)
        // Another surface (the Timeline UI) marks the same meeting while the
        // agent's card is open.
        applyCorrection(db, {
          kind: 'mark-meeting', date: TEST_DATE,
          meeting: { title: 'Standup', startMs: localMs(9, 30) }, status: 'moved',
        }, null)
        return 'Apply correction'
      },
      hooks: { resolveLiveSession: () => null },
    }
    const tools = buildCorrectionTools(deps)
    const outcome = await (tools.propose_correction as unknown as {
      execute: (input: unknown, options: unknown) => Promise<Record<string, unknown>>
    }).execute({ action: 'mark_meeting', date: TEST_DATE, meetingTitle: 'Standup', meetingStatus: 'attended' }, {})

    assert.equal(outcome.applied, false)
    assert.match(String(outcome.reason), /expired/i)
    // The interfering mark stands; the agent's never landed.
    assert.equal(resolveDayMeetingReport(db, TEST_DATE)!.meetings[0].marked, 'moved')
    assert.equal(undoLogCount(db), 1, 'only the interfering correction is in the ledger')
  } finally {
    db.close()
  }
})
