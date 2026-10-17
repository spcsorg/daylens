import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { measureScan } from '../../tools/agentMemory.ts'
import { claude, claudeCtx, sec, tmp } from './fixtures.ts'

test('production first read stays below 150 MB for parent and backfill child combined', { skip: process.platform === 'win32' ? 'RSS sampler uses POSIX ps' : false }, async (t) => {
  const home = tmp()
  const data = tmp()
  const c = claudeCtx()
  const dir = path.join(home, '.claude', 'projects', '-memory')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${c.session}.jsonl`)
  for (let i = 0; i < 160; i++) {
    appendFileSync(file, `${claude.prompt(c, sec(i * 10), `prompt ${i}`, { uuid: `p${i}` })}\n`)
    appendFileSync(file, `${claude.assistant(c, sec(i * 10 + 1), 'tool_use', { tools: [{ id: `t${i}`, name: 'Bash' }] })}\n`)
    appendFileSync(file, `${claude.toolResult(c, sec(i * 10 + 2), `t${i}`, 'x'.repeat(800_000))}\n`)
    appendFileSync(file, `${claude.assistant(c, sec(i * 10 + 3), 'end_turn')}\n`)
  }
  const result = await measureScan(home, data)
  t.diagnostic(JSON.stringify({ combined_peak_mb: result.combined_peak_mb, parent_at_peak_mb: result.parent_at_peak_mb, child_at_peak_mb: result.child_at_peak_mb }))
  assert.ok(result.samples_with_child > 0, 'sampler observed parent and child together')
  assert.ok(result.combined_peak_mb < 150, JSON.stringify(result))
  assert.equal(result.passes[0].table_rows.turns, 160)
  assert.equal(result.passes[1].files_read, 0)
  assert.equal(result.passes[1].bytes_read, 0)
})
