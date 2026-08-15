// The write half of the answer-evidence boundary (WO-76 / AC-AIA-002.3).
//
// WO-53 computes claim-to-evidence bindings inside the agent turn and returns
// them on `ChatAgentResult.evidence`. Those in-process types carry working
// state the person has no use for and that must not accumulate on a durable
// row — scanner offsets, raw seconds, internal fact ids, dimensions.
//
// This module is the one place that turns the in-process result into the
// inspectable record. It is a projection, not a copy: every output field is
// named and built explicitly from a known input field, so adding a field to
// the agent's evidence never silently widens what gets persisted, crosses IPC,
// and reaches the renderer. The read side (contextPacketInspection's
// projectAnswerEvidence) re-validates the same shape, because by then the row
// is untrusted JSON.
import type {
  ContextPacketAnswerEvidence,
  ContextPacketComputedFigure,
  ContextPacketSupportedClaim,
  ContextPacketUnsupportedClaim,
} from '@shared/types'
import type { DeterministicFact, DeterministicRepair } from './deterministicFacts'
import type { FactualClaim, SupportedClaim } from './evidenceCoverage'

/** The agent-turn evidence this projection reads. Structural on purpose: it
 *  states exactly which fields are consumed, so a wider `ChatAgentResult`
 *  still projects to exactly this. */
export interface AgentTurnEvidence {
  deterministicFacts: readonly DeterministicFact[]
  deterministicRepairs: readonly DeterministicRepair[]
  supportedClaims: readonly SupportedClaim[]
  unsupportedClaims: readonly FactualClaim[]
  disclosedUncertainties: readonly string[]
}

function toComputedFigure(
  fact: DeterministicFact,
  repairs: readonly DeterministicRepair[],
): ContextPacketComputedFigure {
  // A repair means the model stated a different figure and the computed one
  // replaced it. Showing what was replaced is the whole point of the row: it
  // is the difference between "checked" and "corrected".
  const repair = repairs.find((candidate) => candidate.factId === fact.id)
  return {
    subject: fact.subject,
    rendered: fact.rendered,
    identity: fact.identity,
    statement: fact.statement,
    replaced: repair ? repair.claimed : null,
  }
}

function toSupportedClaim(supported: SupportedClaim): ContextPacketSupportedClaim {
  return {
    kind: supported.claim.kind,
    text: supported.claim.text,
    identity: supported.identity,
    source: supported.kind,
    statement: supported.statement,
  }
}

function toUnsupportedClaim(claim: FactualClaim): ContextPacketUnsupportedClaim {
  return { kind: claim.kind, text: claim.text }
}

/**
 * The inspectable record of how one answer was backed.
 *
 * Everything here was derived from this exchange alone — the turn's own
 * packet, its own tool results, and figures computed from the corrected
 * activity boundary. There is deliberately no field for the provider prompt,
 * the configured key, a raw tool payload, or an earlier message, so this
 * projection cannot carry one no matter what the turn held.
 */
export function toAnswerEvidenceRecord(evidence: AgentTurnEvidence): ContextPacketAnswerEvidence {
  return {
    computedFigures: evidence.deterministicFacts.map((fact) =>
      toComputedFigure(fact, evidence.deterministicRepairs)),
    supportedClaims: evidence.supportedClaims.map(toSupportedClaim),
    unsupportedClaims: evidence.unsupportedClaims.map(toUnsupportedClaim),
    disclosedUncertainties: [...evidence.disclosedUncertainties],
  }
}
