import { buildCapabilityProblemIdentityKey, normalizeCapabilityProblemIdentity } from './CapabilityProblemIdentity'
import type { CapabilityDecisionCandidate, CapabilityMigrationComparisonReport, CapabilityProblemCandidate, Problem } from './types'

export function buildLegacyDecisionCandidates(legacyProblems: Problem[]): CapabilityDecisionCandidate[] {
  return legacyProblems
    .filter(
      (problem) =>
        Boolean(problem.affectedCapability) && Boolean(problem.context.metadata?.operation) && Boolean(problem.context.metadata?.issueType),
    )
    .map((problem) => {
      const identity = normalizeCapabilityProblemIdentity({
        capability: problem.affectedCapability!,
        operation: problem.context.metadata!.operation,
        issueType: problem.context.metadata!.issueType,
      })

      return {
        identity,
        capabilityKey: buildCapabilityProblemIdentityKey(identity),
        score: scoreProblem(problem),
        affectedTools: [problem.context.metadata?.toolName ?? 'unknown'],
        supportingProblemIds: [problem.id],
      }
    })
    .sort(compareDecisionCandidates)
}

export function buildCapabilityDecisionCandidates(candidates: CapabilityProblemCandidate[]): CapabilityDecisionCandidate[] {
  return candidates
    .map((candidate) => ({
      identity: candidate.identity,
      capabilityKey: buildCapabilityProblemIdentityKey(candidate.identity),
      score: scoreCandidate(candidate),
      affectedTools: candidate.affectedTools,
      supportingProblemIds: candidate.legacyProblemIds,
    }))
    .sort(compareDecisionCandidates)
}

export function buildDecisionDiffReport(input: {
  legacyDecisions: CapabilityDecisionCandidate[]
  capabilityDecisions: CapabilityDecisionCandidate[]
}): {
  matchedKeys: string[]
  legacyOnlyKeys: string[]
  capabilityOnlyKeys: string[]
  consistencyRate: number
} {
  const legacyKeys = new Set(input.legacyDecisions.map((candidate) => candidate.capabilityKey))
  const capabilityKeys = new Set(input.capabilityDecisions.map((candidate) => candidate.capabilityKey))
  const matchedKeys = [...legacyKeys].filter((key) => capabilityKeys.has(key)).sort()
  const legacyOnlyKeys = [...legacyKeys].filter((key) => !capabilityKeys.has(key)).sort()
  const capabilityOnlyKeys = [...capabilityKeys].filter((key) => !legacyKeys.has(key)).sort()

  return {
    matchedKeys,
    legacyOnlyKeys,
    capabilityOnlyKeys,
    consistencyRate: legacyKeys.size > 0 ? matchedKeys.length / legacyKeys.size : 1,
  }
}

export function buildCapabilityMigrationComparisonReport(input: {
  runId: string
  generatedAt: number
  legacyProblems: Problem[]
  capabilityCandidates: CapabilityProblemCandidate[]
  decisionConsistencyRate: number
}): CapabilityMigrationComparisonReport {
  const eligibleLegacyCount = input.legacyProblems.filter(
    (problem) =>
      Boolean(problem.affectedCapability) && Boolean(problem.context.metadata?.operation) && Boolean(problem.context.metadata?.issueType),
  ).length
  const capabilityCandidateCount = input.capabilityCandidates.length
  const legacyOnlyProblemCount = input.legacyProblems.length - eligibleLegacyCount
  const matchedProblemCount = eligibleLegacyCount

  return {
    runId: input.runId,
    generatedAt: input.generatedAt,
    eligibleLegacyCount,
    capabilityCandidateCount,
    legacyOnlyProblemCount,
    matchedProblemCount,
    decisionConsistencyRate: input.decisionConsistencyRate,
    fragmentationReduction: eligibleLegacyCount - capabilityCandidateCount,
    fragmentationReductionRate: eligibleLegacyCount === 0 ? 0 : (eligibleLegacyCount - capabilityCandidateCount) / eligibleLegacyCount,
  }
}

function scoreProblem(problem: Problem): number {
  return problem.occurrenceCount * (problem.severity === 'error' ? 2 : 1)
}

function scoreCandidate(candidate: CapabilityProblemCandidate): number {
  return candidate.occurrenceCount * (candidate.severity === 'error' ? 2 : 1)
}

function compareDecisionCandidates(left: CapabilityDecisionCandidate, right: CapabilityDecisionCandidate): number {
  const scoreDelta = right.score - left.score
  if (scoreDelta !== 0) return scoreDelta

  return left.capabilityKey.localeCompare(right.capabilityKey)
}
