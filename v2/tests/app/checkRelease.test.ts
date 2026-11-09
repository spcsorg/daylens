// The release check's own parts: what counts as tool code in app.asar, and what counts as a run of the app.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { benchRun, toolCode } from '../../app/package/checkRelease.ts'

test('tool code in an app.asar listing is found, and nothing else', () => {
  const listing = ['/package.json', '/build/app/app/main/main.js', '/build/app/app/reader/main.js', '/build/app/app/tools/seed.js', '/build/app/app/tools/world.js', '/build/app/capture/service.js', '/node_modules/better-sqlite3/lib/index.js']
  assert.deepEqual(toolCode(listing), ['/build/app/app/tools/seed.js', '/build/app/app/tools/world.js'])
  assert.deepEqual(toolCode(['\\build\\app\\app\\tools\\demoHelper.js', '/build/app/demo-helper.sh']), ['\\build\\app\\app\\tools\\demoHelper.js', '/build/app/demo-helper.sh'])
})

const RUN = { now_ms: 1, data_dir: 'data', shell_dir: 'shell' }
// Stands in for the app: prints its bench line, then ends as told.
const app = (end: string) => benchRun(process.execPath, ['-e', `console.log('DAYLENS_BENCH_RUN ' + ${JSON.stringify(JSON.stringify(RUN))}); ${end}`], process.env)

test('a run counts only when the app prints its bench line and exits cleanly', async () => {
  assert.deepEqual(await app(''), RUN)
  await assert.rejects(app('process.exitCode = 9'), /code 9/)
  await assert.rejects(app(`process.kill(process.pid, 'SIGKILL')`), /exited with/)
  await assert.rejects(benchRun(process.execPath, ['-e', ''], process.env), /without its bench line/)
})
