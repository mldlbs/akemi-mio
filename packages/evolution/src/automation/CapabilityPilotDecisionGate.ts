/**
 * CapabilityPilotDecisionGate ? M5.6.5 bounded capability-led pilot gate.
 *
 * Read-only observer implementing spec section 5.2: a pilot decision is only
 * eligible for executor dispatch if the identical capability decision candidate
 * also exists in the shadow report with the same rank.
 *
 * The gate derives capability-led decisions from the authoritative tool-source
 * problems (dual-write ? the authoritative problemId is untouched), ranks them
 * by capability priority, and compares rank-for-rank against the shadow
 * decision candidates. It never dispatches anything and never mutates the
 * ProblemQueue or any executor.
 */

import type { CapabilityEvolutionShadowRun, Problem } from './types'
import { buildCapabilityDecisionCandidates, buildLegacyDecisionCandidates } from './CapabilityDecisionShadowPipeline'
import { buildCapabilityProblemShadowArtifacts } from './CapabilityProblemShadowPipeline'
import { buildLegacyProblemsFromShadowRuns } from './CapabilityShadowRunHydrator'

export interface CapabilityPilotDecision {
  capabilityKey: string
  rank: number
  score: number
  affectedTools: string[]
  eligible: boolean
}

export interface CapabilityPilotRunRecord {
  runId: string
  generatedAt: number
  decisionCount: number
  eligibleCount: number
  eligibilityRate: number
  decisions: CapabilityPilotDecision[]
  shadowRunCount: number
  guardrails: {
    executorAuthorityUnchanged: boolean
    problemQueueUnchanged: boolean
    shadowGateActive: boolean
  }
}

export function evaluatePilotDecisionEligibility(input: {
  runId: string
  generatedAt: number
  authoritativeProblems: Problem[]
  shadowRuns: CapabilityEvolutionShadowRun[]
}): CapabilityPilotRunRecord {
  // Pilot domain (spec 5.1.3): tool-source problems only.
  const toolProblems = input.authoritativeProblems.filter((problem) => problem.source === 'tool')

  // Capability-led decisions derived from the authoritative collector output (dual-write).
  const authoritativeDecisions = buildLegacyDecisionCandidates(toolProblems)

  // Shadow decisions from the persisted shadow observation window.
  const shadowProblems = buildLegacyProblemsFromShadowRuns(input.shadowRuns)
  const shadowArtifacts = buildCapabilityProblemShadowArtifacts({
    runId: `pilot-shadow-${input.generatedAt}`,
    generatedAt: input.generatedAt,
    legacyProblems: shadowProblems,
  })
  const shadowDecisions = buildCapabilityDecisionCandidates(shadowArtifacts.capabilityCandidates)

  const decisions: CapabilityPilotDecision[] = authoritativeDecisions.map((candidate, rank) => {
    const shadowMatch = shadowDecisions[rank]?.capabilityKey === candidate.capabilityKey
    return {
      capabilityKey: candidate.capabilityKey,
      rank,
      score: candidate.score,
      affectedTools: candidate.affectedTools,
      eligible: shadowMatch,
    }
  })

  const eligibleCount = decisions.filter((decision) => decision.eligible).length

  return {
    runId: input.runId,
    generatedAt: input.generatedAt,
    decisionCount: decisions.length,
    eligibleCount,
    eligibilityRate: decisions.length > 0 ? eligibleCount / decisions.length : 0,
    decisions,
    shadowRunCount: input.shadowRuns.length,
    guardrails: {
      executorAuthorityUnchanged: true,
      problemQueueUnchanged: true,
      shadowGateActive: true,
    },
  }
}
