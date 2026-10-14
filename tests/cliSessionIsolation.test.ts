import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { interpretSearchIntent } from '../src/main/jobs/aiService.ts'
import { runClaudeCodeChat } from '../src/main/agent/claudeCodeChat.ts'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { setTestDb, clearTestDb } from './support/database-stub.mjs'
import { __resetSettings, __setSettings } from './support/settings-stub.mjs'

test('real CLI launches are ephemeral, and chat follow-ups use Daylens history', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-cli-isolation-'))
  const bin = path.join(root, '.local', 'bin')
  fs.mkdirSync(bin, { recursive: true })
  const mcp = path.join(root, 'packages', 'mcp-server')
  fs.mkdirSync(path.join(mcp, 'src'), { recursive: true })
  fs.writeFileSync(path.join(mcp, 'loader.mjs'), '')
  fs.writeFileSync(path.join(mcp, 'src', 'index.ts'), '')
  t.mock.method(app, 'getAppPath', () => root)
  const log = path.join(root, 'calls.jsonl')
  const leakedSession = path.join(root, 'external-session.jsonl')
  const script = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('--ephemeral --sandbox --config --output-last-message'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (!args.includes('--no-session-persistence') && !args.includes('--ephemeral')) fs.writeFileSync(${JSON.stringify(leakedSession)}, 'leaked');
const answer = JSON.stringify({terms:['foldplan'],intent:'Foldplan work'});
const output = args.indexOf('--output-last-message');
if (output >= 0) fs.writeFileSync(args[output + 1], answer);
if (args.includes('stream-json')) console.log(JSON.stringify({type:'result',result:'Follow-up answer',session_id:'external-session'}));
else if (args.includes('exec')) console.log(answer);
else { process.stdin.resume(); process.stdin.on('end', () => console.log(answer)); }
`
  for (const name of ['claude', 'codex']) {
    fs.writeFileSync(path.join(bin, name), script, { mode: 0o755 })
  }
  t.mock.method(os, 'homedir', () => root)
  const db = createProductionTestDatabase()
  setTestDb(db)
  __resetSettings()
  try {
    for (const provider of ['claude-cli', 'codex-cli'] as const) {
      __setSettings({ aiProvider: provider, aiChatProvider: provider })
      assert.deepEqual(await interpretSearchIntent('Find Foldplan'), { terms: ['foldplan'], intent: 'Foldplan work' })
    }
    await runClaudeCodeChat({
      question: 'Where did I leave off?',
      prior: [{ role: 'user', content: 'I was building Foldplan.' }, { role: 'assistant', content: 'You were connecting Drive.' }],
      systemPrompt: 'Answer from the supplied history.',
      model: null,
      executablePath: path.join(bin, 'claude'),
    })
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[])
    assert.equal(calls.length, 3)
    assert.ok(calls[0].includes('--no-session-persistence'))
    assert.ok(calls[0].includes('--tools'))
    assert.ok(calls[0].includes('--strict-mcp-config'))
    assert.ok(calls[1].includes('--ephemeral'))
    assert.ok(calls[2].includes('--no-session-persistence'))
    assert.equal(calls[2].includes('--resume'), false)
    const question = calls[2][calls[2].indexOf('-p') + 1]
    assert.match(question, /I was building Foldplan/)
    assert.match(question, /You were connecting Drive/)
    assert.match(question, /Where did I leave off/)
    assert.equal(fs.existsSync(leakedSession), false)
  } finally {
    clearTestDb()
    __resetSettings()
    db.close()
    t.mock.restoreAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
