// Ask through the Anthropic API on the person's own key: one streamed call, no tools, structured output. The record is
// the request body; the key is sent only to the API.
import { ANTHROPIC_RATES, anthropicClient, type ApiOptions } from '../engine/backends.ts'
import type { AskModel } from './ask.ts'

export function anthropicApi(model: string, opts: ApiOptions): AskModel {
  const call = anthropicClient(model, opts)
  const rate = ANTHROPIC_RATES[model]!
  return {
    name: 'Claude',
    provider: 'anthropic',
    async run(req, onText) {
      const r = await call({ system: req.system, message: req.prompt, schema: req.schema, onText })
      if (r.error !== null || r.text === null) throw new Error(r.error ?? 'no answer')
      let output: unknown
      try {
        output = JSON.parse(r.text)
      } catch {
        throw new Error('the answer was not the JSON asked for')
      }
      const input = r.usage?.input ?? 0
      const out = r.usage?.output ?? 0
      return { output, model: r.model ?? model, input_tokens: input, output_tokens: out, cost_micro_usd: Math.round(input * rate.input + out * rate.output) }
    },
  }
}
