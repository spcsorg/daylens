import { test } from 'node:test'
import assert from 'node:assert/strict'
import { factsHour, noAi } from '../../engine/backends.ts'
import type { Packet, Ref } from '../../engine/packet.ts'
import { validateHour } from '../../engine/validate.ts'

const packet: Packet = {
  hour: '2026-03-02 22:00-23:00',
  tz: 'Africa/Johannesburg',
  away: [{ id: 'w1', from: '22:31', to: '22:59', why: 'locked' }],
  unknown: [{ id: 'g1', from: '22:10', to: '22:12', why: 'not recording' }],
  windows: [
    { id: 'i1', app: 'Codex', title_note: 'title unreadable', min: 12, from: '22:00', to: '22:17', times: 3 },
    { id: 'i2', app: 'Ghostty', title: 'old task', min: 4, from: '22:00', to: '22:05', times: 1, stale: 'title unchanged since at least 20:00' },
  ],
  pages: [{ id: 'p1', app: 'Dia', title: 'Project list - Example Notes', site: 'notes.example.com', min: 5, from: '22:01', to: '22:09', times: 2 }],
  agents: [{ id: 'a1', agent: 'Codex', project: 'beta', with_you_min: 14, while_away_min: 9, messages: ['22:03 prompt'] }],
  commits: [{ id: 'c1', at: '22:40', repos: ['beta'], subject: 'Cache the parsed config', while_away: 'screen locked', agents_working: ['a1'] }],
  scheduled_events: [],
}
const refs: Record<string, Ref> = {
  w1: { kind: 'away' }, g1: { kind: 'gap', ids: [1] }, i1: { kind: 'observations', ids: [2] }, i2: { kind: 'observations', ids: [3] },
  p1: { kind: 'observations', ids: [4] }, a1: { kind: 'agent', agent: 'codex', session: 's' }, c1: { kind: 'commit', hash: 'abc' },
}

test('with no AI the hour is its facts: it passes validation and never says the person made what an agent made while they were away', async () => {
  const r = await noAi.write(packet)
  const v = validateHour(r.text!, packet, refs)
  assert.deepEqual(v.errors, [])
  const h = v.hour!
  assert.equal(h.title, 'Mostly Codex')
  assert.ok(h.detail.includes('Commit at 22:40 in beta: Cache the parsed config (made while away: screen locked)'))
  assert.ok(!h.detail.includes('old task'), 'a stale title is not shown as what happened')
  assert.ok(h.detail.includes('Away 22:31–22:59'))
  assert.ok(h.detail.includes('Not recorded 22:10–22:12'))
  const empty = factsHour({ ...packet, windows: [], pages: [], agents: [], commits: [], away: [], unknown: [] })
  assert.equal(empty.title, 'Nothing recorded')
  assert.deepEqual(validateHour(JSON.stringify(empty), { ...packet, windows: [], pages: [], agents: [], commits: [] }, refs).errors, [])
})

test('the facts-only hour lists recorded time with no usable title, and the site of a page with no title', () => {
  const untitled = {
    ...packet, pages: [{ id: 'p1', app: 'Dia', site: 'notes.example.com', url: 'https://notes.example.com/x', min: 15, from: '22:30', to: '22:45', times: 1 }],
    windows: [{ id: 'i1', app: 'Editor', title_note: 'title unreadable', min: 45, from: '22:00', to: '22:45', times: 1 }, packet.windows[1]!], agents: [], commits: [], away: [], unknown: [],
  }
  const h = factsHour(untitled)
  assert.deepEqual(h.detail.split('\n'), [
    'Editor: title unreadable (45 min, 22:00–22:45)',
    'Dia: notes.example.com, page title not recorded (15 min, 22:30–22:45)',
    'Ghostty: title may not describe the work (4 min, 22:00–22:05)',
  ])
  assert.deepEqual(validateHour(JSON.stringify(h), untitled, refs).errors, [])
})

test('the facts-only hour keeps recorded items too short to round to a minute', () => {
  const short = Array.from({ length: 60 }, (_, k) => ({ id: `i${k + 1}`, app: 'Editor', title: `note ${k + 1}.md`, min: 0.3, from: '22:00', to: '22:59', times: 1 }))
  const many = { ...packet, windows: short, pages: [], agents: [], commits: [], away: [], unknown: [] }
  const h = factsHour(many)
  assert.equal(h.summary, 'Editor 18 min.')
  assert.equal(h.detail, 'Editor: 60 windows or pages under a minute each (18 min)')
  assert.equal(h.sources.length, 60)
  const one = factsHour({ ...many, windows: short.slice(0, 1) })
  assert.deepEqual([one.title, one.summary, one.detail], ['Mostly Editor', 'Editor under 1 min.', 'Editor: 1 window or page under a minute'])
  const allRefs = Object.fromEntries(short.map((w) => [w.id, { kind: 'observations' as const, ids: [1] }]))
  assert.deepEqual(validateHour(JSON.stringify(h), many, allRefs).errors, [])
})

test('the facts-only hour shows agent work whose presence was not recorded, and time an agent waited', () => {
  const only = { ...packet, windows: [], pages: [], commits: [], away: [], unknown: [{ id: 'g1', from: '22:00', to: '23:00', why: 'not recording' }], agents: [{ id: 'a1', agent: 'Codex', project: 'beta', with_you_min: 0, while_away_min: 0, unknown_min: 60, waiting_min: 5, messages: [] }] }
  const h = factsHour(only)
  assert.equal(h.title, 'Codex working')
  assert.ok(h.detail.includes('Codex in beta: 0 min working while present, 0 min while away, 60 min working with presence not recorded, 5 min waiting'), h.detail)
  assert.deepEqual(validateHour(JSON.stringify(h), only, refs).errors, [])
})
