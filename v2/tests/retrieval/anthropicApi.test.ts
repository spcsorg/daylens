import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ANSWER_SCHEMA } from '../../retrieval/ask.ts'
import { anthropicApi } from '../../retrieval/anthropicApi.ts'
import { fakeAnthropic } from '../support/fakeAnthropic.ts'

test('Ask through the API sends the system prompt, the record as the one message and the answer schema, and prices the call', async () => {
  const answer = JSON.stringify({ answerable: true, statements: [{ text: 'You edited notes.md.', sources: ['s1'] }] })
  const api = await fakeAnthropic((b) => {
    const m = (b.messages as { content: string }[])[0]!.content
    if (m === 'not json') return { kind: 'text', chunks: ['Sure! Here is'] }
    if (m === 'fail') return { kind: 'error', status: 401, type: 'authentication_error', message: 'invalid x-api-key' }
    return { kind: 'text', chunks: [answer.slice(0, 30), answer.slice(30)] }
  })
  try {
    const model = anthropicApi('claude-sonnet-5-5', { apiKey: 'sk-test-2', baseURL: api.url, timeoutMs: 5000 })
    const pieces: string[] = []
    const reply = await model.run({ system: 'sys', prompt: '{"question":"q"}', schema: ANSWER_SCHEMA }, (t) => pieces.push(t))
    assert.deepEqual(pieces, [answer.slice(0, 30), answer.slice(30)], 'the answer reaches Ask as it streams')
    assert.deepEqual(reply, { output: JSON.parse(answer), model: 'claude-sonnet-5-5', input_tokens: 1200, output_tokens: 300, cost_micro_usd: 1200 * 2 + 300 * 10 })
    const body = api.seen[0]!.body
    assert.equal(body.system, 'sys')
    assert.deepEqual(body.messages, [{ role: 'user', content: '{"question":"q"}' }])
    assert.deepEqual(body.output_config, { format: { type: 'json_schema', schema: ANSWER_SCHEMA } })
    assert.equal(body.tools, undefined)
    await assert.rejects(model.run({ system: 's', prompt: 'not json', schema: ANSWER_SCHEMA }), /not the JSON asked for/)
    await assert.rejects(model.run({ system: 's', prompt: 'fail', schema: ANSWER_SCHEMA }), /the API key was refused/)
  } finally {
    await api.close()
  }
})
