import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { measureScan } from '../../tools/agentMemory.ts'
import { claude, claudeCtx, sec, tmp } from './fixtures.ts'

test('capture and backfill stay below 135 MB in Electron Node mode over three runs', { skip: process.platform !== 'darwin' ? '1 ms sampler uses macOS proc_pid_rusage' : false }, async (t) => {
  const home = tmp()
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
  for (let run = 1; run <= 3; run++) {
    const result = await measureScan(home, tmp())
    t.diagnostic(JSON.stringify({ run, combined_peak_mb: result.combined_peak_mb, wall_ms: result.passes[0].wall_ms, mean_sample_interval_ms: result.mean_sample_interval_ms }))
    assert.equal(result.runtime.electron, '44.5.1')
    assert.ok(result.entrypoint.endsWith('build/js/tools/agentScan.js'))
    assert.equal(result.sample_interval_ms, 1)
    assert.ok(result.samples > 0, 'sampler observes RSS for the process including all worker threads')
    assert.ok(result.combined_peak_mb <= 135, JSON.stringify(result))
    assert.equal(result.passes[0].backfill_child.children, 1)
    assert.ok(result.passes[0].backfill_child.max_slice_bytes <= 4 << 20)
    assert.ok(result.passes[0].backfill_child.child.entrypoint.endsWith('backfillMain.js'))
    assert.equal(result.passes[0].table_rows.turns, 160)
    assert.equal(result.passes[1].files_read, 0)
    assert.equal(result.passes[1].bytes_read, 0)
  }
})
