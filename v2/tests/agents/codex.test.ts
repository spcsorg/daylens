import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CodexParser } from '../../capture/agents/codex.ts'
import { codex, codexCtx, of, run, sec } from './fixtures.ts'

const parser = (c = codexCtx()) => new CodexParser(c.id, null)
// Live Codex turns are named by UUIDs; these stand in for them, one per short name.
const U = (name: string) => `00000000-0000-4000-8000-${Buffer.from(name).toString('hex').padStart(12, '0').slice(-12)}`
const TYPED = ['user.text']
const CONTEXT = ['agents_md.instructions', 'environments.environment_context']

test('a composer turn: context Codex adds is skipped, the person\'s message is the act, the end is the completion', () => {
  const c = codexCtx()
  const recs = run(parser(c), [
    codex.meta(c, sec(0)),
    codex.started(sec(1), U('turn-1'), 'composer'),
    codex.userItem(sec(2), '# AGENTS.md instructions\n\n<INSTRUCTIONS>…</INSTRUCTIONS>', CONTEXT),
    codex.context(sec(2), U('turn-1'), '/home/me/code/project-gamma'),
    codex.userItem(sec(2), '<external_codex_apps_open_page>{}</external_codex_apps_open_page>', ['additional_content.codex_apps_open_page']),
    codex.userItem(sec(2), 'rename the config loader', TYPED),
    codex.userCompleted(sec(2), U('turn-1'), 'rename the config loader', 'client-1'),
    codex.assistant(sec(30)),
    codex.tokens(sec(31)),
    codex.complete(sec(31), U('turn-1'), sec(1), sec(31)),
  ])
  assert.equal(of(recs, 'session')[0]!.origin, 'interactive')
  assert.deepEqual(of(recs, 'turn').map((t) => [t.key, t.opener, t.start, t.replayed]), [[U('turn-1'), 'user', sec(1), false]])
  assert.deepEqual(of(recs, 'turn_dir'), [{ t: 'turn_dir', key: U('turn-1'), dir: '/home/me/code/project-gamma' }])
  assert.deepEqual(of(recs, 'user').map((u) => [u.act, u.basis, u.at]), [['prompt', 'marked', sec(1)]])
  assert.deepEqual(of(recs, 'end'), [{ t: 'end', key: U('turn-1'), state: 'completed', at: sec(31) }])
  // Usage counts are bookkeeping, not work.
  assert.equal(Math.max(...of(recs, 'activity').map((a) => a.at)), sec(30))
})

test('messages sent mid-turn and answers to the agent\'s questions are acts at their own time', () => {
  const c = codexCtx()
  const recs = run(parser(c), [
    codex.meta(c, sec(0)),
    codex.started(sec(1), U('turn-1'), 'composer'),
    codex.userItem(sec(1), 'start the migration', TYPED),
    codex.assistant(sec(20)),
    codex.userItem(sec(40), 'skip the tests for now', TYPED),
    codex.userCompleted(sec(40), U('turn-1'), 'skip the tests for now', 'client-2'),
    codex.userItem(sec(55), '<send_user_message_question_reply>\n[{"questionItemId":"q"}]', TYPED),
    codex.userCompleted(sec(55), U('turn-1'), '<send_user_message_question_reply>\n[{"questionItemId":"q"}]', 'client-3'),
    codex.complete(sec(80), U('turn-1'), sec(1), sec(80)),
  ])
  assert.deepEqual(of(recs, 'user').map((u) => [u.act, u.at]), [
    ['prompt', sec(1)],
    ['steer', sec(40)],
    ['answer', sec(55)],
  ])
})

test('who started a turn comes from its trigger', () => {
  const c = codexCtx()
  const recs = run(parser(c), [
    codex.meta(c, sec(0)),
    codex.started(sec(1), U('q'), 'queue'),
    codex.userItem(sec(1), 'queued while it worked', TYPED),
    codex.complete(sec(9), U('q'), sec(1), sec(9)),
    codex.started(sec(10), U('r'), 'resume_interrupted_task'),
    codex.assistant(sec(12)),
    codex.complete(sec(13), U('r'), sec(10), sec(13)),
    codex.started(sec(20), U('a'), 'capacity_retry_automatic'),
    codex.complete(sec(21), U('a'), sec(20), sec(21)),
    codex.started(sec(30), U('m'), 'capacity_retry_manual'),
    codex.complete(sec(31), U('m'), sec(30), sec(31)),
    codex.started(sec(40), U('x'), 'send_user_message_async_question'),
    codex.userItem(sec(40), '<send_user_message_question_reply>\n[]', TYPED),
    codex.complete(sec(41), U('x'), sec(40), sec(41)),
  ])
  assert.deepEqual(of(recs, 'turn').map((t) => [t.key, t.opener]), [
    [U('q'), 'user_queued'],
    [U('r'), 'resume'],
    [U('a'), 'retry'],
    [U('m'), 'user_retry'],
    [U('x'), 'user_answer'],
  ])
  assert.deepEqual(of(recs, 'user').map((u) => [u.turn, u.act, u.at]), [
    [U('q'), 'queued', sec(1)],
    [U('m'), 'prompt', sec(30)],
    [U('x'), 'answer', sec(40)],
  ])
})

test('an interrupted turn is aborted at its completion time', () => {
  const c = codexCtx()
  const recs = run(parser(c), [codex.meta(c, sec(0)), codex.started(sec(1), U('t'), 'composer'), codex.userItem(sec(1), 'go', TYPED), codex.assistant(sec(5)), codex.aborted(sec(9), U('t'), sec(1))])
  assert.deepEqual(of(recs, 'end'), [{ t: 'end', key: U('t'), state: 'aborted', at: sec(9) }])
  assert.deepEqual(of(recs, 'user').map((u) => [u.act, u.basis]), [
    ['prompt', 'marked'],
    ['interrupt', 'inferred'],
  ])
})

test('a turn that fails after a stalled request ends late, but its activity stops when the agent stopped', () => {
  const c = codexCtx()
  const recs = run(parser(c), [
    codex.meta(c, sec(0)),
    codex.started(sec(1), U('t'), 'composer'),
    codex.userItem(sec(1), 'go', TYPED),
    codex.toolCall(sec(600), 'ok'),
    codex.tokens(sec(2400)),
    codex.complete(sec(2400), U('t'), sec(1), sec(2400), { message: 'Selected model is at capacity.' }),
  ])
  assert.deepEqual(of(recs, 'end'), [{ t: 'end', key: U('t'), state: 'failed', at: sec(2400) }])
  assert.equal(Math.max(...of(recs, 'activity').map((a) => a.at)), sec(600))
})

test('an imported history keeps each turn\'s own times; the import time is never activity', () => {
  const c = codexCtx()
  const importedAt = sec(86_400)
  const recs = run(parser(c), [
    codex.meta(c, importedAt),
    codex.started(importedAt, 'old-1', undefined, sec(0)),
    codex.userEvent(importedAt, 'from before the import'),
    codex.userItem(importedAt, 'from before the import', null, null),
    codex.assistant(importedAt),
    codex.complete(importedAt, 'old-1', sec(0), sec(120)),
    codex.started(importedAt, 'old-2', undefined, sec(500)),
    codex.complete(importedAt, 'old-2', sec(500), null),
  ])
  assert.deepEqual(of(recs, 'turn').map((t) => [t.key, t.start, t.replayed]), [
    [`${c.id}:old-1`, sec(0), true],
    [`${c.id}:old-2`, sec(500), true],
  ])
  assert.deepEqual(of(recs, 'end'), [
    { t: 'end', key: `${c.id}:old-1`, state: 'completed', at: sec(120) },
    // No completion time and no duration: the end is unknown, not invented.
    { t: 'end', key: `${c.id}:old-2`, state: 'completed', at: null },
  ])
  assert.equal(of(recs, 'activity').length, 0)
  assert.deepEqual(of(recs, 'user').map((u) => [u.act, u.basis, u.at]), [['prompt', 'inferred', sec(0)]])
})

test('a fork repeats its parent\'s metadata and turns; the copies keep the parent\'s keys', () => {
  const parent = codexCtx()
  const child = codexCtx()
  const lines = [
    codex.meta(child, sec(100), { forkedFrom: parent.id }),
    codex.meta(parent, sec(100)),
    codex.started(sec(100), U('parent-turn'), 'composer', sec(0)),
    codex.userItem(sec(100), 'parent prompt', TYPED, sec(0)),
    codex.complete(sec(100), U('parent-turn'), sec(0), sec(50)),
    codex.started(sec(101), U('child-turn'), 'composer'),
    codex.userItem(sec(101), 'child prompt', TYPED),
    codex.complete(sec(120), U('child-turn'), sec(101), sec(120)),
  ]
  const recs = run(parser(child), lines)
  assert.deepEqual(of(recs, 'session').map((s) => s.session), [child.id])
  assert.deepEqual(of(recs, 'turn').map((t) => [t.key, t.replayed]), [
    [U('parent-turn'), true],
    [U('child-turn'), false],
  ])
  assert.deepEqual(of(recs, 'user').map((u) => u.key), [`${U('parent-turn')}:u1`, `${U('child-turn')}:u1`])
})

test('sessions driven by a script or another agent, and subagents, have no acts of the person', () => {
  for (const opts of [{ source: 'exec', originator: 'codex_exec' }, { originator: 'Claude Code' }]) {
    const c = codexCtx()
    const recs = run(parser(c), [codex.meta(c, sec(0), opts), codex.started(sec(1), U('t'), 'exec'), codex.userItem(sec(1), 'review this diff', TYPED), codex.complete(sec(9), U('t'), sec(1), sec(9))])
    assert.equal(of(recs, 'session')[0]!.origin, 'automated')
    assert.deepEqual(of(recs, 'turn').map((t) => t.opener), ['automation'])
    assert.equal(of(recs, 'user').length, 0)
  }
  const c = codexCtx()
  const recs = run(parser(c), [
    codex.meta(c, sec(0), { source: { subagent: { thread_spawn: { parent_thread_id: 'parent-thread', depth: 1, agent_path: '/root/x' } } }, threadSource: 'subagent' }),
    codex.started(sec(1), U('t'), null),
    codex.userItem(sec(1), 'audit the routes', TYPED),
    codex.complete(sec(9), U('t'), sec(1), sec(9)),
  ])
  assert.equal(of(recs, 'session')[0]!.origin, 'subagent')
  assert.equal(of(recs, 'session')[0]!.parent, 'parent-thread')
  assert.equal(of(recs, 'user').length, 0)
})

test('an older log without triggers or content kinds is read from its messages\' shape', () => {
  const c = codexCtx()
  const recs = run(parser(c), [
    codex.meta(c, sec(0), { originator: 'codex-tui', source: 'cli' }),
    codex.started(sec(1), U('t'), undefined),
    codex.userItem(sec(2), '<environment_context>\n  <cwd>/x</cwd>\n</environment_context>', null, null),
    codex.userItem(sec(3), 'explain this stack trace', null, null),
    codex.userEvent(sec(3), 'explain this stack trace'),
    codex.assistant(sec(10)),
    codex.userItem(sec(15), '<turn_aborted>\nThe user interrupted the previous turn.\n</turn_aborted>', null, null),
    codex.aborted(sec(15), U('t'), sec(1)),
  ])
  assert.deepEqual(of(recs, 'turn_opener'), [{ t: 'turn_opener', key: U('t'), opener: 'user' }])
  assert.deepEqual(of(recs, 'user').map((u) => [u.act, u.basis, u.at]), [
    ['prompt', 'inferred', sec(1)],
    ['interrupt', 'inferred', sec(15)],
  ])
})

test('a turn that never ended is closed as missing when the next one starts', () => {
  const c = codexCtx()
  const recs = run(parser(c), [codex.meta(c, sec(0)), codex.started(sec(1), U('a'), 'composer'), codex.assistant(sec(5)), codex.started(sec(3600), U('b'), 'composer')])
  assert.deepEqual(of(recs, 'end'), [{ t: 'end', key: U('a'), state: 'missing', at: null }])
  assert.equal(Math.max(...of(recs, 'activity').filter((a) => a.key === U('a')).map((a) => a.at)), sec(5))
})

test('a line that no longer starts the usual way is still parsed, and garbage is counted', () => {
  const c = codexCtx()
  const p = parser(c)
  const reordered = JSON.stringify({ type: 'event_msg', timestamp: new Date(sec(1)).toISOString(), payload: { type: 'task_started', turn_id: U('t'), started_at: Math.floor(sec(1) / 1000) } })
  const recs = run(p, [codex.meta(c, sec(0)), reordered, 'not json at all'])
  assert.deepEqual(of(recs, 'turn').map((t) => t.key), [U('t')])
  assert.equal(p.counts.bad, 1)
})

test('turn ids that are not unique (imports number turns from 1) never merge turns of different sessions', () => {
  const a = codexCtx()
  const b = codexCtx()
  const imported = (c: typeof a, startS: number) =>
    run(parser(c), [codex.meta(c, sec(90_000)), codex.started(sec(90_000), 'external-import-turn-1', undefined, sec(startS)), codex.complete(sec(90_000), 'external-import-turn-1', sec(startS), sec(startS + 60))])
  const ka = of(imported(a, 0), 'turn')[0]!.key
  const kb = of(imported(b, 3600), 'turn')[0]!.key
  assert.notEqual(ka, kb)
  // A UUID names the same turn wherever it is copied.
  const u = '01a13b98-3458-74b2-81c7-eb4c0d024d4f'
  const live = of(run(parser(a), [codex.meta(a, sec(0)), codex.started(sec(1), u, 'composer')]), 'turn')[0]!.key
  const copy = of(run(parser(b), [codex.meta(b, sec(500), { forkedFrom: a.id }), codex.started(sec(500), u, 'composer', sec(1))]), 'turn')[0]!.key
  assert.equal(live, copy)
  // A fork's copy of a numbered turn is keyed by the session it was copied from, so it merges with the original.
  const orig = of(run(parser(a), [codex.meta(a, sec(0)), codex.started(sec(1), 'external-import-turn-2', undefined)]), 'turn')[0]!.key
  const forked = of(run(parser(b), [codex.meta(b, sec(500), { forkedFrom: a.id }), codex.started(sec(500), 'external-import-turn-2', undefined, sec(1))]), 'turn')[0]!.key
  assert.equal(orig, forked)
})

test('items copied into an import or a fork never add activity, whatever times they carry', () => {
  const c = codexCtx()
  const copiedAt = sec(86_400 * 2)
  const recs = run(parser(c), [
    codex.meta(c, copiedAt),
    codex.started(copiedAt, U('old'), 'composer', sec(0)),
    codex.itemDone(copiedAt, U('old'), copiedAt - 1000, copiedAt),
    codex.itemDone(copiedAt, U('old'), sec(30), sec(40)),
    codex.complete(copiedAt, U('old'), sec(0), sec(60)),
  ])
  assert.equal(of(recs, 'activity').length, 0)
  assert.deepEqual(of(recs, 'end'), [{ t: 'end', key: U('old'), state: 'completed', at: sec(60) }])
})

test('an event type the reader does not know is never counted as understood', () => {
  const c = codexCtx()
  const p = parser(c)
  run(p, [codex.meta(c, sec(0)), JSON.stringify({ timestamp: new Date(sec(1)).toISOString(), type: 'event_msg', payload: { type: 'turn_began', turn_id: 'x' } })])
  assert.equal(p.counts.unknown, 1)
  assert.equal(p.counts.recognized, 1)
  assert.equal(p.counts.turns, 0)
})

test('a message and its copy split across two reads still count once', () => {
  const c = codexCtx()
  const turn = U('split')
  const first = parser(c)
  const a = run(first, [codex.meta(c, sec(0)), codex.started(sec(1), turn, 'composer'), codex.userItem(sec(1), 'go', TYPED), codex.assistant(sec(5)), codex.userItem(sec(9), 'and also this', TYPED)])
  const second = new CodexParser(c.id, first.state())
  const b = run(second, [codex.userCompleted(sec(9), turn, 'and also this', 'client-9'), codex.complete(sec(20), turn, sec(1), sec(20))])
  assert.deepEqual([...of(a, 'user'), ...of(b, 'user')].map((u) => [u.act, u.at]), [
    ['prompt', sec(1)],
    ['steer', sec(9)],
  ])
  // The older pairing: the user_message event first, then its response item.
  const legacy = codexCtx()
  const lt = U('legacy')
  const l1 = parser(legacy)
  const x = run(l1, [codex.meta(legacy, sec(0), { originator: 'codex-tui', source: 'cli' }), codex.started(sec(1), lt, undefined), codex.userEvent(sec(1), 'explain this'), codex.assistant(sec(4)), codex.userEvent(sec(6), 'and that')])
  const l2 = new CodexParser(legacy.id, l1.state())
  const y = run(l2, [codex.userItem(sec(6), 'and that', null, null), codex.assistant(sec(8))])
  assert.equal([...of(x, 'user'), ...of(y, 'user')].length, 2)
})

test('bookkeeping between copies remains deduplicated after rebuilding the parser', () => {
  const c = codexCtx()
  const turn = U('bookkeeping')
  const first = parser(c)
  const a = run(first, [codex.meta(c, sec(0)), codex.started(sec(1), turn, 'composer'), codex.userItem(sec(1), 'go', TYPED), codex.assistant(sec(5)), codex.userItem(sec(9), 'and also this', TYPED), codex.tokens(sec(10)), codex.tokens(sec(11))])
  const second = new CodexParser(c.id, first.state())
  const b = run(second, [codex.userCompleted(sec(12), turn, 'and also this', 'client-9'), codex.complete(sec(20), turn, sec(1), sec(20))])
  assert.deepEqual([...of(a, 'user'), ...of(b, 'user')].map((u) => [u.act, u.at]), [
    ['prompt', sec(1)],
    ['steer', sec(9)],
  ])
})

test('the persisted message fingerprint is bounded and cleared between turns', () => {
  const c = codexCtx()
  const turn = U('bounded')
  let p = parser(c)
  run(p, [codex.meta(c, sec(0)), codex.started(sec(1), turn, 'composer')])
  const baseline = p.state().length
  for (let i = 0; i < 200; i++) {
    const words = `private message ${i}`
    run(p, [codex.userItem(sec(i + 2), words, TYPED)])
    assert.ok(!p.state().includes(words))
    assert.ok(p.state().length < baseline + 100)
    p = new CodexParser(c.id, p.state())
  }
  run(p, [codex.tokens(sec(204)), codex.tokens(sec(205))])
  p = new CodexParser(c.id, p.state())
  assert.equal(of(run(p, [codex.userCompleted(sec(206), turn, 'private message 199', 'client')]), 'user').length, 0)
  const next = run(p, [codex.complete(sec(300), turn, sec(1), sec(300)), codex.started(sec(301), U('next'), 'composer'), codex.userItem(sec(301), 'private message 199', TYPED)])
  assert.equal(of(next, 'user').length, 1)
})

test('a Claude Code session imported into Codex adds no acts: they are recorded from the Claude Code log itself', () => {
  const c = codexCtx()
  const importedAt = sec(90_000)
  const recs = run(parser(c), [
    codex.meta(c, importedAt),
    codex.started(importedAt, 'external-import-turn-1', undefined, sec(0)),
    codex.userEvent(importedAt, 'a prompt typed in Claude Code'),
    codex.userItem(importedAt, 'a prompt typed in Claude Code', null, null),
    codex.aborted(importedAt, 'external-import-turn-1', sec(0)),
  ])
  assert.equal(of(recs, 'turn').length, 1)
  assert.equal(of(recs, 'user').length, 0)
  assert.equal(of(recs, 'activity').length, 0)
})
