import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claudeCli, cleanEnv, cliWriter, codexCli, factsHour, noAi, parseClaude, parseCodex, runProcess, type RunResult, type Runner } from '../../engine/backends.ts'
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

const ran = (stdout: string, code = 0, stderr = ''): RunResult => ({ stdout, stderr, code, ms: 1234.4 })

test('claude -p output gives the text, all input tokens, the reported cost and the exact model', () => {
  const r = parseClaude(ran(JSON.stringify({
    type: 'result', is_error: false, result: '{"title":"x"}', num_turns: 1, total_cost_usd: 0.0123,
    usage: { input_tokens: 2, cache_creation_input_tokens: 5000, cache_read_input_tokens: 100, output_tokens: 700 },
    modelUsage: { 'claude-haiku-5-5': {} },
  })))
  assert.equal(r.text, '{"title":"x"}')
  assert.equal(r.error, null)
  assert.deepEqual(r.usage, { input: 5102, cached_input: 100, cache_write: 5000, output: 700, reasoning: null })
  assert.equal(r.reported_cost_usd, 0.0123)
  assert.equal(r.model, 'claude-haiku-5-5')
  assert.equal(r.latency_ms, 1234)
  assert.deepEqual(r.tool_calls, [])
})

test('a claude -p failure is an error, and a usage limit says so', () => {
  const limit = parseClaude(ran(JSON.stringify({ is_error: true, result: "You've hit your session limit · resets 5pm" }), 1))
  assert.equal(limit.text, null)
  assert.ok(limit.error?.includes('session limit'))
  assert.equal(limit.quota, true)
  const credits = parseClaude(ran(JSON.stringify({ is_error: true, result: 'This model requires usage credits. Switch to another model to continue.' }), 1))
  assert.equal(credits.quota, true, 'a model the plan does not include will not start working on a retry')
  const garbage = parseClaude(ran('not json', 1, 'boom'))
  assert.ok(garbage.error?.startsWith('unreadable output'))
  assert.equal(garbage.quota, false)
})

test('codex exec events give the last message, usage, and any tool the run used', () => {
  const lines = [
    { type: 'thread.started', thread_id: 't' },
    { type: 'item.completed', item: { type: 'reasoning', text: '...' } },
    { type: 'item.completed', item: { type: 'command_execution', command: 'ls' } },
    { type: 'item.completed', item: { type: 'agent_message', text: '{"title":"y"}' } },
    { type: 'turn.completed', usage: { input_tokens: 9000, cached_input_tokens: 2000, output_tokens: 300, reasoning_output_tokens: 50 } },
  ]
  const r = parseCodex(ran(lines.map((l) => JSON.stringify(l)).join('\n')), 'gpt-6-luna')
  assert.equal(r.text, '{"title":"y"}')
  assert.deepEqual(r.usage, { input: 9000, cached_input: 2000, cache_write: 0, output: 300, reasoning: 50 })
  assert.deepEqual(r.tool_calls, ['command_execution'])
  assert.equal(r.model, 'gpt-6-luna')
  const failed = parseCodex(ran(JSON.stringify({ type: 'turn.failed', error: { message: 'You have reached your usage limit' } }), 1), 'gpt-6-luna')
  assert.equal(failed.text, null)
  assert.equal(failed.quota, true)
})

test('the CLIs run in the given empty folder with tools off, and never see API keys or the parent session settings', async () => {
  const calls: { cmd: string; args: string[]; input: string; cwd: string; env: NodeJS.ProcessEnv }[] = []
  const run: Runner = async (cmd, args, input, o) => {
    calls.push({ cmd, args, input, cwd: o.cwd, env: o.env })
    return cmd === 'claude' ? ran(JSON.stringify({ is_error: false, result: 'ok', usage: {}, modelUsage: {} })) : ran(JSON.stringify({ type: 'turn.completed', usage: {} }))
  }
  const env = cleanEnv({ PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', CLAUDE_EFFORT: 'high', ANTHROPIC_BASE_URL: 'x', CLAUDECODE: '1' })
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h' })
  await cliWriter(claudeCli('claude-haiku-5-5', { cwd: '/empty', run, env })).write(packet)
  await codexCli('gpt-6.1-sol', 'low', { cwd: '/empty', instructionsFile: '/i.txt', run, env, allowFileReads: true }).call('hi')
  const [c, x] = calls
  assert.equal(c!.cwd, '/empty')
  assert.deepEqual(c!.args.slice(c!.args.indexOf('--tools'), c!.args.indexOf('--tools') + 2), ['--tools', ''])
  assert.ok(c!.args.includes('--strict-mcp-config') && c!.args.includes('--no-session-persistence'))
  assert.ok(c!.input.includes('"hour":"2026-03-02 22:00-23:00"'))
  assert.equal(x!.cmd, 'codex')
  assert.deepEqual(x!.args.slice(x!.args.indexOf('-s'), x!.args.indexOf('-s') + 2), ['-s', 'read-only'])
  for (const f of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use', 'computer_use']) assert.ok(x!.args.join(' ').includes(`--disable ${f}`), f)
  assert.ok(x!.args.includes('model_reasoning_effort=low'))
  assert.equal(x!.args.at(-1), '-', 'the message goes through stdin')
  for (const k of calls) assert.deepEqual(k.env, { PATH: '/bin', HOME: '/h' })
})

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
  assert.equal(r.reported_cost_usd, 0)
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

test('codex exec refuses to run unless the evaluation explicitly allows its file reads', () => {
  const run: Runner = async () => {
    throw new Error('must not run')
  }
  assert.throws(() => codexCli('gpt-6.1-sol', 'low', { cwd: '/empty', instructionsFile: '/i.txt', run }), /--allow-codex-file-reads/)
  assert.throws(() => codexCli('gpt-6.1-sol', 'low', { cwd: '/empty', instructionsFile: '/i.txt', run, allowFileReads: false }), /--allow-codex-file-reads/)
  assert.doesNotThrow(() => codexCli('gpt-6.1-sol', 'low', { cwd: '/empty', instructionsFile: '/i.txt', run, allowFileReads: true }))
})

test('a process that exits before reading its input is a failed run, not a crash', async () => {
  const r = await runProcess(process.execPath, ['-e', 'process.stdin.destroy(); process.exit(3)'], 'x'.repeat(1 << 20), { cwd: process.cwd(), env: cleanEnv(), timeoutMs: 30_000 })
  assert.equal(r.code, 3)
})

test('a run whose input was not fully delivered is a failed call even if it exits cleanly', async () => {
  const r = await runProcess(process.execPath, ['-e', 'process.stdin.destroy(); setTimeout(() => process.exit(0), 200)'], 'x'.repeat(1 << 22), { cwd: process.cwd(), env: cleanEnv(), timeoutMs: 30_000 })
  assert.equal(r.code, 0)
  assert.match(r.input_error ?? '', /EPIPE|ECONNRESET|destroyed|closed/)
  const ok = JSON.stringify({ type: 'result', is_error: false, result: '{"title":"x"}', num_turns: 1, usage: {}, modelUsage: {} })
  assert.match(parseClaude({ ...ran(ok), input_error: 'write EPIPE' }).error ?? '', /input/)
  assert.match(parseCodex({ ...ran('{"type":"turn.completed","usage":{}}'), input_error: 'write EPIPE' }, 'm').error ?? '', /input/)
})
