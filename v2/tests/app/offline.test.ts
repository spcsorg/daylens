// With no network, Ask and the key form say the person is offline, from the SDK's own connection failure.
import assert from 'node:assert/strict'
import { createServer, type Socket } from 'node:net'
import path from 'node:path'
import { test } from 'node:test'
import { askFailure, keyCheckFailure } from '../../app/shared/ai.ts'
import { DB_FILE } from '../../capture/store.ts'
import { checkKey } from '../../engine/backends.ts'
import { anthropicApi } from '../../retrieval/anthropicApi.ts'
import { ask, type AskLog } from '../../retrieval/ask.ts'
import { AssistantStore } from '../../retrieval/assistantStore.ts'
import { Reader } from '../../retrieval/reader.ts'
import { HOUR, rig, T0 } from '../storage/support.ts'
import { day } from '../retrieval/support.ts'

process.env.TZ = 'Etc/GMT+5'

// A name that never resolves: the lookup fails the way it does with the network cut.
const OFFLINE_URL = 'http://daylens-test.invalid'

// A port nothing listens on: the connection is refused, which is not the same as being offline.
async function refusedUrl(): Promise<string> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as { port: number }
  await new Promise<void>((done) => server.close(() => done()))
  return `http://127.0.0.1:${port}`
}

test('offline, saving or testing a key says so instead of the raw connection error', async () => {
  const text = keyCheckFailure(await checkKey({ apiKey: 'sk-test', baseURL: OFFLINE_URL, timeoutMs: 5000 }))
  assert.match(text ?? '', /offline/i)
  assert.doesNotMatch(text ?? '', /Connection error|no status/)
})

test('a refused connection says Anthropic couldn’t be reached, not that you’re offline', async () => {
  const text = keyCheckFailure(await checkKey({ apiKey: 'sk-test', baseURL: await refusedUrl(), timeoutMs: 5000 }))
  assert.equal(text, 'Couldn’t reach Anthropic. Check your connection and try again.')
})

test('a key check that times out says Anthropic couldn’t be reached, without the raw error', async () => {
  const sockets = new Set<Socket>()
  const server = createServer((s) => sockets.add(s))
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  try {
    const { port } = server.address() as { port: number }
    const text = keyCheckFailure(await checkKey({ apiKey: 'sk-test', baseURL: `http://127.0.0.1:${port}`, timeoutMs: 200 }))
    assert.equal(text, 'Couldn’t reach Anthropic. Check your connection and try again.')
  } finally {
    for (const s of sockets) s.destroy()
    await new Promise<void>((done) => server.close(() => done()))
  }
})

test('offline, Ask says so instead of saying Claude couldn’t answer', async () => {
  const r = rig()
  day(r)
  r.storage.writeHour({ start_wall_ms: T0, tz: 'Example/Town', status: 'written', title: 'Budget review', summary: 'Went through Q4 numbers.', sources: [{ app_id: 'com.example.editor' }] }, r.storage.hourBasis(T0))
  const reader = Reader.open(path.join(r.dir, DB_FILE))
  const store = AssistantStore.open(path.join(r.dir, DB_FILE), () => r.clock.t)
  const log: AskLog = { recordRead: (x, mark) => store.recordRead(x, mark), recordUsage: (u) => r.storage.recordUsage(u) }
  try {
    const model = anthropicApi('claude-opus-5-5', { apiKey: 'sk-test', baseURL: OFFLINE_URL, timeoutMs: 5000 })
    const failed = await ask('budget yesterday', { reader, model, log, now: () => T0 + 24 * HOUR }, { maxHours: 5, maxSources: 10, perGroup: 5 }).then(
      () => assert.fail('Ask answered with no connection'),
      (e: Error) => e,
    )
    assert.match(askFailure(failed.message), /offline/i)
  } finally {
    reader.close()
    store.close()
    r.close()
  }
})
