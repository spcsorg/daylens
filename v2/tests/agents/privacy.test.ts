import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ClaudeParser } from '../../capture/agents/claude.ts'
import { CodexParser } from '../../capture/agents/codex.ts'
import { AgentReader, homeRoots } from '../../capture/agents/reader.ts'
import { AgentStore } from '../../capture/agents/store.ts'
import { Store } from '../../capture/store.ts'
import { claude, claudeCtx, codex, codexCtx, sec, tmp } from './fixtures.ts'

const CANARIES = {
  prompt: 'CANARY-prompt-7f3a',
  queued: 'CANARY-queued-91bc',
  output: 'CANARY-tool-output-2d4e',
  reply: 'CANARY-reply-5a1f',
  title: 'CANARY-title-c0de',
  codexPrompt: 'CANARY-codex-prompt-44aa',
  codexOutput: 'CANARY-codex-output-77ee',
}

test('no prompt, reply, title or tool output reaches the database or its sidecar files', async () => {
  const home = tmp()
  const data = tmp()
  const c = claudeCtx()
  const cdir = path.join(home, '.claude', 'projects', '-p')
  mkdirSync(cdir, { recursive: true })
  writeFileSync(
    path.join(cdir, `${c.session}.jsonl`),
    [
      claude.queue(c, sec(0), 'enqueue', CANARIES.prompt),
      claude.prompt(c, sec(0), CANARIES.prompt),
      claude.assistant(c, sec(1), 'tool_use', { text: CANARIES.reply, tools: [{ id: 't', name: 'Bash' }] }),
      claude.queue(c, sec(2), 'enqueue', CANARIES.queued),
      claude.toolResult(c, sec(3), 't', CANARIES.output),
      claude.queuedCommand(c, sec(2), CANARIES.queued),
      claude.assistant(c, sec(4), 'end_turn', { text: CANARIES.reply }),
      claude.meta(c, 'last-prompt', { lastPrompt: CANARIES.prompt }),
      claude.meta(c, 'custom-title', { customTitle: CANARIES.title }),
      claude.meta(c, 'ai-title', { aiTitle: CANARIES.title }),
    ].join('\n') + '\n',
  )
  const x = codexCtx()
  const xdir = path.join(home, '.codex', 'sessions', '2031', '03', '04')
  mkdirSync(xdir, { recursive: true })
  writeFileSync(
    path.join(xdir, `rollout-2031-03-04T20-00-00-${x.id}.jsonl`),
    [
      codex.meta(x, sec(0)),
      codex.started(sec(1), 't', 'composer'),
      codex.userItem(sec(1), CANARIES.codexPrompt, ['user.text']),
      codex.userCompleted(sec(1), 't', CANARIES.codexPrompt, 'client'),
      codex.toolCall(sec(2), CANARIES.codexOutput),
      codex.assistant(sec(3), CANARIES.reply),
      codex.complete(sec(4), 't', sec(1), sec(4)),
    ].join('\n') + '\n',
  )
  const store = new Store(data)
  const reader = new AgentReader(new AgentStore(store.database), homeRoots(home, {}), { reconcileMs: 3_600_000 })
  await reader.start()
  await reader.stop()
  assert.ok((store.query<{ n: number }>('SELECT count(*) AS n FROM agent_events')[0]!.n) >= 3, 'the acts themselves were recorded')
  const check = () => {
    for (const f of readdirSync(data)) {
      const bytes = readFileSync(path.join(data, f))
      for (const [what, canary] of Object.entries(CANARIES)) assert.equal(bytes.includes(canary), false, `${what} leaked into ${f}`)
    }
  }
  check()
  store.close()
  check()
})

test('tool output is never parsed: tool result lines are recognized from their first bytes', () => {
  const c = claudeCtx()
  const p = new ClaudeParser(c.session, null, null)
  const line = claude.toolResult(c, sec(1), 'toolu_1', CANARIES.output)
  const parse = JSON.parse
  const seen: string[] = []
  JSON.parse = ((text: string, reviver?: Parameters<typeof parse>[1]) => {
    seen.push(text)
    return parse(text, reviver)
  }) as typeof JSON.parse
  try {
    p.line(line, line.slice(0, 8192), line.slice(-8192))
  } finally {
    JSON.parse = parse
  }
  assert.equal(seen.some((s) => s.includes(CANARIES.output)), false)

  const x = new CodexParser('s', null)
  const out = codex.toolCall(sec(1), CANARIES.codexOutput)
  JSON.parse = ((text: string, reviver?: Parameters<typeof parse>[1]) => {
    seen.push(text)
    return parse(text, reviver)
  }) as typeof JSON.parse
  try {
    x.line(out, out.slice(0, 8192), out.slice(-8192))
  } finally {
    JSON.parse = parse
  }
  assert.equal(seen.some((s) => s.includes(CANARIES.codexOutput)), false)

  // A reply is classified from its first bytes too: its text is never decoded or parsed.
  const reply = codex.assistant(sec(2), CANARIES.reply)
  let decoded = false
  x.line(() => ((decoded = true), reply), reply.slice(0, 8192), reply.slice(-8192))
  assert.equal(decoded, false)
})

// The fingerprint this reader persisted before fingerprints were keyed.
function unkeyed(s: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193)
    h2 = Math.imul(h2 ^ c, 0x5bd1e995)
  }
  return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)
}

test('persisted message fingerprints are keyed per install, owner-only, and cleared with the session', async () => {
  const home = tmp()
  const c = claudeCtx()
  const cdir = path.join(home, '.claude', 'projects', '-p')
  mkdirSync(cdir, { recursive: true })
  writeFileSync(path.join(cdir, `${c.session}.jsonl`), [claude.prompt(c, sec(0), 'go'), claude.assistant(c, sec(1), 'tool_use', { tools: [{ id: 't', name: 'Bash' }] }), claude.queue(c, sec(2), 'enqueue', 'yes')].join('\n') + '\n')
  const x = codexCtx()
  const xdir = path.join(home, '.codex', 'sessions', '2031', '03', '04')
  mkdirSync(xdir, { recursive: true })
  const xfile = path.join(xdir, `rollout-2031-03-04T20-00-00-${x.id}.jsonl`)
  writeFileSync(xfile, [codex.meta(x, sec(0)), codex.started(sec(1), 't', 'composer'), codex.userItem(sec(1), 'yes', ['user.text'])].join('\n') + '\n')
  const read = async (data: string) => {
    const store = new Store(data)
    const agents = new AgentStore(store.database)
    const reader = new AgentReader(agents, homeRoots(home, {}), { reconcileMs: 3_600_000, followUpMs: 3_600_000 })
    await reader.start()
    await reader.stop()
    const state = (agent: string) => JSON.parse(store.query<{ state: string }>('SELECT state FROM agent_sources WHERE agent = ?', agent)[0]!.state)
    return { store, agents, codex: state('codex').recentUsers as string[], claude: Object.keys(state('claude_code').queued) }
  }
  const data = tmp()
  const a = await read(data)
  const b = await read(tmp())
  assert.equal(a.codex.length, 1)
  assert.equal(a.claude.length, 1)
  assert.notEqual(a.codex[0], unkeyed('yes'))
  assert.notEqual(a.claude[0], unkeyed('yes'))
  assert.notEqual(a.codex[0], b.codex[0], 'another install fingerprints the same words differently')
  if (process.platform !== 'win32') assert.equal(statSync(path.join(data, 'agent-fingerprint.key')).mode & 0o777, 0o600)
  a.store.close()
  b.store.close()
  appendFileSync(xfile, [codex.tokens(sec(2)), codex.tokens(sec(3)), codex.userCompleted(sec(4), 't', 'yes', 'client')].join('\n') + '\n')
  const again = await read(data)
  assert.equal(again.store.query<{ n: number }>(`SELECT count(*) AS n FROM agent_events WHERE kind = 'user' AND agent = 'codex'`)[0]!.n, 1, 'the key survives a restart, so the copy still matches')
  again.agents.deleteSession('codex', x.id)
  again.agents.deleteSession('claude_code', c.session)
  const states = again.store.query<{ agent: string; state: string }>('SELECT agent, state FROM agent_sources').map((r) => [r.agent, JSON.parse(r.state)])
  for (const [agent, s] of states) assert.deepEqual(agent === 'codex' ? s.recentUsers : s.queued, agent === 'codex' ? [] : {})
  again.store.close()
})
