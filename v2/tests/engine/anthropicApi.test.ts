import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anthropicApi, anthropicClient, factsHour, textWriter } from '../../engine/backends.ts'
import type { Packet } from '../../engine/packet.ts'
import { fakeAnthropic } from '../support/fakeAnthropic.ts'

const packet: Packet = {
  hour: '2026-03-02 09:00-10:00',
  tz: 'Example/Town',
  away: [],
  unknown: [],
  windows: [{ id: 'i1', app: 'Editor', title: 'notes.md', min: 40, from: '09:05', to: '09:50', times: 2 }],
  pages: [],
  agents: [],
  commits: [],
  scheduled_events: [],
}

test('the writer streams one call to the API with the key, the packet as the message and no tools, and reads the hour from it', async () => {
  const hour = JSON.stringify(factsHour(packet))
  const api = await fakeAnthropic(() => ({ kind: 'text', chunks: [hour.slice(0, 20), hour.slice(20)], gapMs: 30 }))
  try {
    const r = await textWriter(anthropicApi('claude-haiku-5-5', { apiKey: 'sk-test-1', baseURL: api.url, timeoutMs: 5000 })).write(packet)
    assert.equal(r.error, null)
    assert.equal(r.text, hour)
    assert.equal(r.model, 'claude-haiku-5-5')
    assert.deepEqual(r.usage, { input: 1200, cached_input: 0, cache_write: 0, output: 300, reasoning: null })
    assert.deepEqual(r.tool_calls, [])
    assert.ok(r.first_token_ms !== null && r.first_token_ms < r.latency_ms, `${r.first_token_ms} < ${r.latency_ms}`)
    assert.equal(api.seen.length, 1)
    const [{ headers, body }] = api.seen as [(typeof api.seen)[0]]
    assert.equal(headers['x-api-key'], 'sk-test-1')
    assert.equal(body.model, 'claude-haiku-5-5')
    assert.equal(body.stream, true)
    assert.equal(body.tools, undefined)
    const messages = body.messages as { role: string; content: string }[]
    assert.equal(messages.length, 1)
    assert.ok(messages[0]!.content.includes('"hour":"2026-03-02 09:00-10:00"'))
  } finally {
    await api.close()
  }
})

test('a refusal, a cut-off answer, a refused key and a spent balance are errors; a limit and a spent balance say retrying now will not help', async () => {
  const replies = {
    refuse: { kind: 'text', chunks: ['{'], stop: 'refusal' },
    cut: { kind: 'text', chunks: ['{"title":'], stop: 'max_tokens' },
    key: { kind: 'error', status: 401, type: 'authentication_error', message: 'invalid x-api-key' },
    limit: { kind: 'error', status: 429, type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit' },
    credit: { kind: 'error', status: 400, type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' },
  } as const
  const api = await fakeAnthropic((b) => replies[(b.messages as { content: string }[])[0]!.content as keyof typeof replies])
  try {
    const call = anthropicClient('claude-sonnet-5-5', { apiKey: 'k', baseURL: api.url, timeoutMs: 5000 })
    const refuse = await call({ message: 'refuse' })
    assert.equal(refuse.text, null)
    assert.match(refuse.error!, /declined to answer \(cyber\)/)
    assert.match((await call({ message: 'cut' })).error!, /cut off/)
    const key = await call({ message: 'key' })
    assert.equal(key.error, 'the API key was refused')
    assert.equal(key.quota, false)
    // The client retries a rate limit itself before reporting it.
    const limit = await call({ message: 'limit' })
    assert.equal(limit.quota, true)
    assert.equal((await call({ message: 'credit' })).quota, true)
  } finally {
    await api.close()
  }
})

test('the API backend refuses a model it has no price for, and a missing timeout', () => {
  assert.throws(() => anthropicClient('claude-unknown', { apiKey: 'k', timeoutMs: 1000 }), /no price/)
  assert.throws(() => anthropicClient('claude-haiku-5-5', { apiKey: 'k', timeoutMs: 0 }), RangeError)
})
