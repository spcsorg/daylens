// Wrapped narrative — structured AI gloss on top of deterministic facts.
// Fail-closed per briefs-wraps spec: no provider → no wrap; no template fallback.

import type { AIWrappedNarrative, DayTimelinePayload } from '@shared/types'
import {
  executeTextAIJob,
  type ResolvedProviderConfig,
  type AITextJobExecutionOptions,
  type ProviderTextResponse,
} from './aiOrchestration'
import {
  buildWrappedFactsFromPayload,
  buildWrappedPrompts,
  computeFactsHash,
  validateWrappedNarrativeResponse,
  wrappedNarrativeCacheKey,
} from '../lib/wrappedNarrative'
import { recordDayRecapGenerated } from '../lib/dayRecap'
import { freezeWrapSnapshotForDate } from './wrapSnapshots'
import { getDb } from './database'
import { getSettingsAsync, getApiKey } from './settings'

const narrativeCache = new Map<string, AIWrappedNarrative>()

interface ProviderRunner {
  (
    config: ResolvedProviderConfig,
    systemPrompt: string,
    prior: Array<{ role: 'user' | 'assistant'; content: string }>,
    userMessage: string,
    options?: AITextJobExecutionOptions,
  ): Promise<ProviderTextResponse>
}

let providerRunner: ProviderRunner | null = null

export function registerWrappedNarrativeProvider(runner: ProviderRunner): void {
  providerRunner = runner
}

const NARRATIVE_TIMEOUT_MS = 12_000

function attachFactsMeta(
  narrative: AIWrappedNarrative,
  facts: ReturnType<typeof buildWrappedFactsFromPayload>,
): AIWrappedNarrative {
  return {
    ...narrative,
    isLeisureDay: facts.kindBreakdown?.isLeisureDay ?? false,
  }
}

export type WrappedNarrativeResult =
  | { status: 'ready'; narrative: AIWrappedNarrative }
  | { status: 'non_ai'; narrative: AIWrappedNarrative }
  | { status: 'unavailable'; reason: 'no_provider' | 'provider_error' | 'validation_failed' }

export async function canRunWrappedNarrative(): Promise<boolean> {
  const settings = await getSettingsAsync()
  const provider = settings.aiProvider ?? 'anthropic'
  if (provider === 'claude-cli' || provider === 'codex-cli') return true
  const apiKey = await getApiKey(provider)
  return Boolean(apiKey?.trim())
}

export async function getWrappedNarrative(
  payload: DayTimelinePayload,
): Promise<WrappedNarrativeResult> {
  const facts = buildWrappedFactsFromPayload(payload)
  const factsHash = computeFactsHash(facts)
  const cacheKey = wrappedNarrativeCacheKey(facts, factsHash)

  const cached = narrativeCache.get(cacheKey)
  if (cached) return { status: 'ready', narrative: cached }

  // Empty/too-early days are not AI wraps — honest non-AI states only.
  if (facts.quality === 'empty' || facts.quality === 'tooEarly') {
    const narrative = attachFactsMeta({
      lead: facts.quality === 'empty'
        ? 'Daylens did not see enough activity yet to tell a story about this day.'
        : 'The day is still warming up — a few more minutes of activity and a real recap will surface.',
      peakInsight: null,
      nudge: null,
      slides: { scale: null, focus: null, topApp: null, switching: null, identity: null, closing: null },
      source: 'fallback',
      factsHash,
    }, facts)
    narrativeCache.set(cacheKey, narrative)
    return { status: 'non_ai', narrative }
  }

  if (!providerRunner || !(await canRunWrappedNarrative())) {
    return { status: 'unavailable', reason: 'no_provider' }
  }

  const { systemPrompt, userMessage } = buildWrappedPrompts(facts)

  try {
    const { text } = await withTimeout(
      executeTextAIJob(
        {
          jobType: 'wrapped_narrative',
          screen: 'timeline_day',
          triggerSource: 'system',
          systemPrompt,
          userMessage,
        },
        providerRunner,
      ),
      NARRATIVE_TIMEOUT_MS,
      'wrapped_narrative timed out',
    )

    const parsed = validateWrappedNarrativeResponse(text, facts, factsHash)
    if (!parsed) {
      return { status: 'unavailable', reason: 'validation_failed' }
    }
    const narrative = attachFactsMeta(parsed, facts)
    narrativeCache.set(cacheKey, narrative)
    recordDayRecapGenerated(facts.date)
    try {
      freezeWrapSnapshotForDate(getDb(), facts.date, null)
    } catch (error) {
      console.warn(`[wrap] failed to freeze snapshot for ${facts.date}:`, error)
    }
    return { status: 'ready', narrative }
  } catch (error) {
    console.warn(`[ai] wrapped_narrative failed for ${facts.date}:`, error)
    return { status: 'unavailable', reason: 'provider_error' }
  }
}

/** Back-compat helper for callers expecting AIWrappedNarrative | null. */
export async function getWrappedNarrativeOrNull(
  payload: DayTimelinePayload,
): Promise<AIWrappedNarrative | null> {
  const result = await getWrappedNarrative(payload)
  if (result.status === 'unavailable') return null
  return result.narrative
}

export function warmWrappedNarrative(payload: DayTimelinePayload): void {
  void getWrappedNarrative(payload).catch(() => undefined)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

export function clearWrappedNarrativeCache(): void {
  narrativeCache.clear()
}
