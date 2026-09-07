// Pure helpers for the daily Wrapped narrative: facts hash, prompt building,
// AI-output validation, and the deterministic fallback. Kept out of the service
// module so tests can exercise it without the AI orchestration / settings chain.
//
// The wrap is a DECK: `planDayWrapSlides` (renderer/lib/wrapDeck.ts) computes
// the slides deterministically from `DayWrapFacts`, and the model writes one
// line per slide id, plus one curious question and a closing reflection. A line
// that invents a number, grades, or breaks the voice dies alone — its slide
// falls back to the deterministic line; the deck never collapses wholesale.

import { createHash } from 'node:crypto'
import { INTERPRETATION_DIRECTIVES } from '@shared/activityDescription'
import { VOICE_SYSTEM_PROMPT } from '../ai/voiceContract'
import type { AIWrappedNarrative, DayEnrichment } from '@shared/types'
import {
  formatHm,
  gapKindPhrase,
  lowerName,
  workActionPhrase,
  type DayWrapFacts,
} from '../../renderer/lib/dayWrapScenes'
import { planDayWrapSlides, type WrapSlideSpec } from '../../renderer/lib/wrapDeck'
import {
  DECK_JSON_CONTRACT,
  EVIDENCE_HONESTY_DIRECTIVES,
  buildRepairUserMessage,
  deckPromptSection,
  durationTokensIn,
  enforceDeckEmojiBudget,
  guardContextPercents,
  guardContextTimes,
  stripCodeFence,
  validateDeckLinesDetailed,
  wrapQuestionViolation,
  wrapReflectionViolation,
  type LineGuardContext,
  type WrapLineRejection,
} from './wrapNarrativeShared'
import { groundingFormsForRuntime, type WrapFactTable } from './wrapFactTable'

// PLACEHOLDER_TRUNCATED_FOR_TEST