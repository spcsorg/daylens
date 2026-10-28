// Ask through the Anthropic API on the person's own key: one streamed call, no tools, structured output. The record is
// the request body; the key is sent only to the API.
import { ANTHROPIC_RATES, anthropicClient, type ApiOptions } from '../engine/backends.ts'
import { ModelError, type AskModel } from './ask.ts'

// Ask answers while the person waits. Sonnet 5.5 at low effort shows its first statement in about 2 s and the whole
// answer in about 3, against 5 and 7 at its default (docs/engine.md, Choosing the models).
export const ASK_MODEL = 'claude-sonnet-5-5'
export const ASK_EFFORT = 'low'

export function anthropicApi(model: string, opts: ApiOptions): AskModel {
  const call = anthropicClient(model, opts)
  const rate = ANTHROPIC_RATES[model]!
  return {
    name: 'Claude',
    provider: 'anthropic',
    async run(req, onText) {
      const r = await call({ system: req.system, message: req.prompt, schema: req.schema, onText })
      // A refused, cut-off or malformed answer was still billed.
      const billed = r.usage && {
        model: r.model ?? model,
        input_tokens: r.usage.input,
        output_tokens: r.usage.output,
        cost_micro_usd: Math.round(r.usage.input * rate.input + r.usage.output * rate.output),
      }
      if (r.error !== null || r.text === null) throw new ModelError(r.error ?? 'no answer', billed)
      let output: unknown
      try {
        output = JSON.parse(r.text)
      } catch {
        throw new ModelError('the answer was not the JSON asked for', billed)
      }
      return { output, ...billed! }
    },
  }
}
