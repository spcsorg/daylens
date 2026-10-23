import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Packet, Ref } from '../../engine/packet.ts'
import { validateHour, type WrittenHour } from '../../engine/validate.ts'

const packet: Packet = {
  hour: '2026-03-02 10:00-11:00',
  tz: 'Africa/Kigali',
  away: [{ id: 'w1', from: '10:30', to: '10:50', why: 'locked' }],
  unknown: [],
  windows: [
    { id: 'i1', app: 'Editor', title: 'alpha — main.ts', min: 25, from: '10:00', to: '10:29', times: 1 },
    { id: 'i2', app: 'Terminal', title: 'deploy.log', min: 0, away_min: 6, from: '10:31', to: '10:45', times: 1 },
  ],
  pages: [{ id: 'p1', app: 'Dia', title: 'Release notes', site: 'example.com', min: 3, from: '10:52', to: '10:55', times: 1 }],
  agents: [
    { id: 'a1', agent: 'Codex', project: 'alpha', with_you_min: 20, while_away_min: 15, messages: ['10:05 prompt'] },
    { id: 'a2', agent: 'Claude Code', project: 'beta', with_you_min: 0, while_away_min: 12, messages: [] },
  ],
  commits: [
    { id: 'c1', at: '10:15', repos: ['alpha'], subject: 'Parse the config once' },
    { id: 'c2', at: '10:40', repos: ['alpha'], subject: 'Stop retrying failed uploads', while_away: 'screen locked', agents_working: ['a1'] },
  ],
  scheduled_events: [{ id: 'k1', title: 'Standup', from: '09:30', to: '10:30' }],
}
const refs: Record<string, Ref> = {
  w1: { kind: 'away' },
  i1: { kind: 'observations', ids: [1, 2] },
  i2: { kind: 'observations', ids: [4] },
  a2: { kind: 'agent', agent: 'claude_code', session: 's2' },
  p1: { kind: 'observations', ids: [3] },
  a1: { kind: 'agent', agent: 'codex', session: 's1' },
  c1: { kind: 'commit', hash: 'aaa' },
  c2: { kind: 'commit', hash: 'bbb' },
  k1: { kind: 'event', id: 'e1' },
}

const good: WrittenHour = {
  title: 'Worked on alpha with Codex',
  summary: 'You worked on alpha in the editor with Codex until 10:29, then stepped away.',
  apps: ['Editor', 'Codex'],
  detail: 'Standup was on the calendar from 09:30. Codex committed a fix to uploads at 10:40, while the screen was locked.',
  outcome: 'The config change was committed at 10:15.',
  sources: ['i1', 'a1', 'c1', 'c2', 'w1'],
  suggestion: null,
}
const check = (h: Partial<WrittenHour> | string) => validateHour(typeof h === 'string' ? h : JSON.stringify({ ...good, ...h }), packet, refs)
const codes = (h: Partial<WrittenHour> | string) => check(h).errors.map((e) => e.code)

test('a well-formed hour passes and returns what it cites', () => {
  const v = check({})
  assert.deepEqual(v.errors, [])
  assert.ok(v.ok)
  assert.equal(v.cited.length, 5)
  assert.deepEqual(v.cited.find((r) => r.kind === 'commit'), { kind: 'commit', hash: 'aaa' })
})

test('the structure is checked: JSON only, exactly the seven fields, the right types', () => {
  assert.deepEqual(codes('Here is the hour: {}'), ['not_json'])
  assert.deepEqual(codes('[]'), ['not_json'])
  assert.deepEqual(codes(JSON.stringify({ ...good, mood: 'good' })), ['wrong_keys'])
  assert.deepEqual(codes({ apps: 'Editor' as never }), ['wrong_type'])
  assert.deepEqual(codes({ title: '  ' }), ['wrong_type'])
  const fenced = check('```json\n' + JSON.stringify(good) + '\n```')
  assert.ok(fenced.ok)
  assert.deepEqual(fenced.warnings.map((w) => w.code), ['fenced'])
})

test('every cited ID must exist in the packet, and IDs stay out of the text', () => {
  assert.deepEqual(codes({ sources: ['i1', 'c9', 'e12'] }), ['invented_id', 'invented_id', 'outcome_without_proof'])
  assert.deepEqual(codes({ sources: [] }), ['no_sources', 'outcome_without_proof'])
  assert.deepEqual(codes({ detail: 'You edited main.ts (i1).' }), ['ids_in_text'])
  assert.deepEqual(codes({ detail: 'Nothing about an i7 laptop.' }), [], 'an ID-shaped word that is not a packet ID is fine')
})

test('apps are named exactly as the packet names them', () => {
  assert.deepEqual(codes({ apps: ['Editor', 'Slack'] }), ['unknown_app'])
  assert.deepEqual(codes({ apps: ['Dia', 'Codex'] }), [])
})

test('nothing is finished without a cited commit, in the outcome, the title or the summary', () => {
  assert.deepEqual(codes({ sources: ['i1', 'a1'] }), ['outcome_without_proof'])
  assert.deepEqual(codes({ sources: ['i1', 'p1'], outcome: 'The release notes page was published.' }), ['outcome_without_proof'], 'an open page proves nothing was done')
  assert.deepEqual(codes({ sources: ['i1'], outcome: null }), [])
  assert.equal(check({ sources: ['i1'], outcome: 'null' }).hour?.outcome, null, 'the word null means no outcome')
  assert.deepEqual(codes({ sources: ['i1'], outcome: null, title: 'Finished the payroll export' }), ['finished_without_proof'])
  assert.deepEqual(codes({ sources: ['i1', 'p1'], outcome: null, summary: 'You published the release notes.' }), ['finished_without_proof'])
  assert.deepEqual(codes({ sources: ['i1', 'p1'], outcome: null, summary: 'The release notes were open, but the record does not show whether you published them.' }), [])
  assert.deepEqual(codes({ title: 'Finished the config change' }), [], 'the cited commit proves it')
})

test("times are within the hour, unless this hour's own facts state them", () => {
  assert.deepEqual(codes({ detail: 'You came back to it at 11:30.' }), ['time_outside_hour'])
  assert.deepEqual(codes({ detail: 'Standup was scheduled 09:30 to 10:30.' }), [])
  const withText = (extra: Partial<Packet>) => validateHour(JSON.stringify({ ...good, detail: 'You picked it up again at 11:45.' }), { ...packet, ...extra }, refs).errors.map((e) => e.code)
  assert.deepEqual(withText({ previous_hour: { title: 'Planning', summary: 'You planned until 11:45.' } }), ['time_outside_hour'], 'not from the previous hour')
  assert.deepEqual(withText({ corrections: [{ hour: '11:00', field: 'summary', text: 'Back at 11:45' }] }), ['time_outside_hour'], 'not from a correction')
  assert.deepEqual(withText({ windows: [...packet.windows, { id: 'i3', app: 'Calendar', title: 'Call at 11:45', min: 1, from: '10:56', to: '10:57', times: 1 }] }), ['time_outside_hour'], 'not from a title')
  assert.deepEqual(withText({ pages: [...packet.pages, { id: 'p2', app: 'Dia', url: 'https://example.com/at/11:45', min: 1, from: '10:57', to: '10:58', times: 1 }] }), ['time_outside_hour'], 'not from an address')
  assert.deepEqual(withText({ scheduled_events: [{ id: 'k2', title: 'Review', from: '10:45', to: '11:45' }] }), [], 'a calendar entry states it')
})

test('work the packet marks as done while away is never credited to the person, whatever the words', () => {
  assert.deepEqual(codes({ detail: 'You committed the upload fix at 10:40.' }), ['away_work_credited'])
  assert.deepEqual(codes({ detail: 'You shipped stop retrying failed uploads.' }), ['away_work_credited'])
  assert.deepEqual(codes({ detail: 'At 10:35 you reviewed the diff.' }), ['away_work_credited'])
  assert.deepEqual(codes({ detail: 'You finished the refactor while locked at 10:40.' }), ['away_work_credited'], 'saying "locked" is no excuse')
  assert.deepEqual(codes({ detail: 'Codex committed the upload fix at 10:40 while you were away.' }), ['away_work_credited'], 'nor is naming an agent')
  assert.deepEqual(codes({ detail: 'You worked with Claude Code on the refactor.' }), ['away_work_credited'], 'it only worked while away')
  assert.deepEqual(codes({ detail: 'You moved the beta work along.' }), ['away_work_credited'], 'its project only had work while away')
  assert.deepEqual(codes({ detail: 'You read deploy.log.' }), ['away_work_credited'], 'it was only in front while away')
  assert.deepEqual(codes({ detail: 'While the screen was locked, Claude Code worked in beta and Codex committed the upload fix at 10:40.' }), [])
  assert.deepEqual(codes({ detail: 'You worked with Codex on alpha.' }), [], 'Codex also worked while you were there')
  assert.deepEqual(codes({ detail: 'You committed the config change at 10:15.' }), [], 'a commit made while present can be yours')
})
