// DEV-228 guardrails through the real orchestration choke point
// (executeTextAIJob): the kill switch stops machine-initiated work without a
// provider call, budgets refuse a feature once its daily spend is gone, and
// user-initiated work is never blocked by either.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { setTestDb, clearTestDb } from './support/database-stub.mjs'
import { __resetSettings, __setSettings, setApiKey } from './support/settings-stub.mjs'
import { executeTextAIJob } from '../src/main/services/aiOrchestration.ts'
import { startAIUsageEvent, finishAIUsageEvent } from '../src/main/db/queries.ts'
import { cancelBackgroundAIJobs } from '../src/main/lib/backgroundAICancellation.ts'
import { abortError } from '../src/main/lib/aiCancellation.ts'
import { setSettings as persistSettings } from '../src/main/services/settings.ts'

async function setup(): Promise<InstanceType<typeof Database>> {
  const db = createProductionTestDatabase()
  setTestDb(db)
  __resetSettings()
  __setSettings({ aiProvider: 'anthropic', aiChatProvider: 'anthropic' })
  await setApiKey('anthropic', 'test-key')
  return db
}

function teardown(db: InstanceType<typeof Database>): void {
  clearTestDb()
  __resetSettings()
  db.close()
}

function seedSpend(db: InstanceType<typeof Database>, id: string, jobType: string, costUsd: number): void {
  const now = Date.now()
  startAIUsageEvent(db, {
    id,
    jobType: jobType as never,
    screen: 'timeline_day',
    triggerSource: 'background',
    model: 'claude-haiku-4-5-20251001',
    startedAt: now,
  })
  finishAIUsageEvent(db, { id, success: true, completedAt: now + 1, costUsd })
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

test('the kill switch refuses machine-initiated jobs without calling the provider', async () => {
  const db = await setup()
  __setSettings({ backgroundAiEnabled: false })
  try {
    let runnerCalls = 0
    await assert.rejects(
      executeTextAIJob(
        { jobType: 'block_cleanup_relabel', triggerSource: 'background', systemPrompt: 's', userMessage: 'u' },
        async () => { runnerCalls += 1; return { text: 'x' } },
      ),
      /switched off/,
    )
    assert.equal(runnerCalls, 0)
    const events = (db.prepare('SELECT COUNT(*) AS n FROM ai_usage_events').get() as { n: number }).n
    assert.equal(events, 0, 'a skip is not a call — no usage event logged')
  } finally {
    teardown(db)
  }
})

test('the kill switch also stops scheduled foreground-type jobs (evening wrap)', async () => {
  const db = await setup()
  __setSettings({ backgroundAiEnabled: false })
  try {
    let runnerCalls = 0
    await assert.rejects(
      executeTextAIJob(
        // wrapped_narrative is foreground:true in JOB_DEFINITIONS but the
        // daily notifier invokes it with triggerSource 'system' — the kill
        // switch must stop that too ("stops background AI immediately").
        { jobType: 'wrapped_narrative', triggerSource: 'system', systemPrompt: 's', userMessage: 'u' },
        async () => { runnerCalls += 1; return { text: 'x' } },
      ),
      /switched off/,
    )
    assert.equal(runnerCalls, 0)
  } finally {
    teardown(db)
  }
})

test('the kill switch never blocks user-initiated work', async () => {
  const db = await setup()
  __setSettings({ backgroundAiEnabled: false })
  try {
    let runnerCalls = 0
    const result = await executeTextAIJob(
      // A background job type explicitly run by the user (manual Analyze).
      { jobType: 'block_cleanup_relabel', triggerSource: 'user', systemPrompt: 's', userMessage: 'u' },
      async () => { runnerCalls += 1; return { text: 'labeled' } },
    )
    assert.equal(runnerCalls, 1)
    assert.equal(result.text, 'labeled')
  } finally {
    teardown(db)
  }
})

test('switching off while a job resolves prevents a stale-settings provider launch', async () => {
  const db = await setup()
  try {
    let calls = 0
    const pending = executeTextAIJob(
      { jobType: 'block_cleanup_relabel', triggerSource: 'background', systemPrompt: 's', userMessage: 'u' },
      async () => { calls += 1; return { text: 'unexpected' } },
    )
    __setSettings({ backgroundAiEnabled: false })
    await assert.rejects(pending, /switched off/)
    assert.equal(calls, 0)
  } finally {
    cancelBackgroundAIJobs()
    teardown(db)
  }
})

test('the kill switch aborts active automatic requests without aborting a manual request', async () => {
  const db = await setup()
  const started = deferred()
  const manualStarted = deferred()
  const finishManual = deferred()
  try {
    const automatic = executeTextAIJob(
      { jobType: 'wrapped_narrative', triggerSource: 'system', systemPrompt: 's', userMessage: 'u' },
      async (_config, _system, _prior, _user, options) => {
        assert.ok(options.signal)
        started.resolve()
        return new Promise((_resolve, reject) => {
          options.signal!.addEventListener('abort', () => reject(abortError()), { once: true })
        })
      },
    )
    const manual = executeTextAIJob(
      { jobType: 'block_cleanup_relabel', triggerSource: 'user', systemPrompt: 's', userMessage: 'u' },
      async (_config, _system, _prior, _user, options) => {
        manualStarted.resolve()
        await finishManual.promise
        assert.equal(options.signal?.aborted ?? false, false)
        return { text: 'manual answer' }
      },
    )
    await Promise.all([started.promise, manualStarted.promise])
    const stopped = assert.rejects(automatic, /stopped/)
    __setSettings({ backgroundAiEnabled: false })
    await persistSettings({ backgroundAiEnabled: false })
    await stopped
    finishManual.resolve()
    assert.equal((await manual).text, 'manual answer')
  } finally {
    finishManual.resolve()
    cancelBackgroundAIJobs()
    teardown(db)
  }
})

test('a feature over its daily budget is refused; other features still run', async () => {
  const db = await setup()
  __setSettings({ aiFeatureDailyBudgetUsd: 0.5 })
  seedSpend(db, 'spent-1', 'block_label_finalize', 0.6) // Timeline labeling over budget
  try {
    let runnerCalls = 0
    await assert.rejects(
      executeTextAIJob(
        { jobType: 'block_cleanup_relabel', triggerSource: 'background', systemPrompt: 's', userMessage: 'u' },
        async () => { runnerCalls += 1; return { text: 'x' } },
      ),
      /daily AI budget/,
    )
    assert.equal(runnerCalls, 0)

    // Memory writes share no spend with Timeline labeling — still allowed.
    const result = await executeTextAIJob(
      { jobType: 'memory_write', triggerSource: 'background', systemPrompt: 's', userMessage: 'u' },
      async () => { runnerCalls += 1; return { text: 'remembered' } },
    )
    assert.equal(result.text, 'remembered')
    assert.equal(runnerCalls, 1)
  } finally {
    teardown(db)
  }
})
