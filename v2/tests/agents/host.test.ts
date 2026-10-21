import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { claudeSessionPid, clientApp, codexSessionPids, isKnownAgentHost, readHostOf } from '../../capture/agents/host.ts'
import { tmp } from './fixtures.ts'

const HELPER = fileURLToPath(new URL('../../native/macos/.build/release/daylens-capture-macos', import.meta.url))
const noHelper = process.platform !== 'darwin' || !existsSync(HELPER) ? 'real macOS helper not built' : false

test('only the clients that name an app give a session its app; a CLI or an editor extension does not', () => {
  assert.equal(clientApp('claude_code', 'claude-desktop', 'darwin')?.app_id, 'com.anthropic.claudefordesktop')
  assert.equal(clientApp('codex', 'Codex Desktop', 'darwin')?.app_id, 'com.openai.codex')
  assert.equal(clientApp('claude_code', 'cli', 'darwin'), null)
  assert.equal(clientApp('claude_code', 'claude-vscode', 'darwin'), null, 'VS Code and Cursor both load the extension')
  assert.equal(clientApp('codex', 'codex-tui', 'darwin'), null)
  assert.equal(clientApp('claude_code', 'claude-desktop', 'win32'), null, 'other platforms name apps differently')
  assert.ok(isKnownAgentHost('com.mitchellh.ghostty') && isKnownAgentHost('com.jetbrains.intellij') && !isKnownAgentHost('com.microsoft.excel'))
})

test("the helper's answers are read strictly; anything else is ignored", async () => {
  const dir = tmp()
  const fake = path.join(dir, 'helper.sh')
  writeFileSync(fake, `#!/bin/sh
echo '{"pid":10,"basis":"responsible","app":{"app_id":"com.mitchellh.ghostty","name":"Ghostty","path":"/Applications/Ghostty.app","pid":5}}'
echo '{"pid":11,"basis":"none","app":null}'
echo '{"pid":12,"basis":"guess","app":{"app_id":"x"}}'
echo 'not json'
`)
  chmodSync(fake, 0o755)
  const found = await readHostOf(fake, [], [10, 11, 12])
  assert.deepEqual(found.get(10), { app: { app_id: 'com.mitchellh.ghostty', name: 'Ghostty', path: '/Applications/Ghostty.app' }, basis: 'responsible' })
  assert.deepEqual(found.get(11), { app: null, basis: 'none' })
  assert.equal(found.has(12), false)
  assert.equal((await readHostOf(path.join(dir, 'missing'), [], [10])).size, 0, 'no helper, no answer')
})

test("a running Claude Code session is traced to its process only if that process started when its file says", async () => {
  const dir = tmp()
  mkdirSync(path.join(dir, 'sessions'))
  const started = Date.now() - process.uptime() * 1000
  writeFileSync(path.join(dir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'live', startedAt: started }))
  writeFileSync(path.join(dir, 'sessions', `${process.ppid}.json`), JSON.stringify({ pid: process.ppid, sessionId: 'reused', startedAt: started + 3_600_000 }))
  writeFileSync(path.join(dir, 'sessions', `${process.pid}.secret.key`), 'never read')
  assert.equal(await claudeSessionPid(dir, 'live'), process.pid)
  assert.equal(await claudeSessionPid(dir, 'reused'), null, 'a pid now used by another process')
  assert.equal(await claudeSessionPid(dir, 'absent'), null)
})

test('a running Codex session is traced to the process holding its log open', { skip: process.platform === 'win32' ? 'no lsof' : false }, async () => {
  const file = path.join(tmp(), 'rollout.jsonl')
  writeFileSync(file, '')
  const fd = openSync(file, 'r')
  try {
    assert.ok((await codexSessionPids(file)).includes(process.pid))
  } finally {
    closeSync(fd)
  }
})

test('the parent chain alone names the app a process runs in, without the private responsibility call', { skip: noHelper }, async () => {
  const found = (await readHostOf(HELPER, [], [process.pid], ['--no-responsibility'])).get(process.pid)
  assert.ok(found, 'the helper answered')
  assert.notEqual(found.basis, 'responsible')
  if (found.app) assert.equal(found.basis, 'parent')
})
