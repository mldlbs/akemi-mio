import { buildCapabilityProblemIdentityKey, normalizeCapabilityProblemIdentity } from './CapabilityProblemIdentity'
import type { CapabilityMigrationComparisonReport, CapabilityProblemCandidate, Problem } from './types'

export function buildCapabilityProblemShadowArtifacts(input: { runId: string; generatedAt: number; legacyProblems: Problem[] }): {
  legacyCandidates: Problem[]
  capabilityCandidates: CapabilityProblemCandidate[]
  comparison: CapabilityMigrationComparisonReport
} {
  const eligible = input.legacyProblems.filter(
    (problem) =>
      Boolean(problem.affectedCapability) && Boolean(problem.context.metadata?.operation) && Boolean(problem.context.metadata?.issueType),
  )
  const buckets = new Map<
    string,
    {
      candidate: CapabilityProblemCandidate
      representative: Problem
    }
  >()

  for (const problem of eligible) {
    const metadata = problem.context.metadata!
    const identity = normalizeCapabilityProblemIdentity({
      capability: problem.affectedCapability!,
      operation: metadata.operation,
      issueType: metadata.issueType,
    })
    const key = buildCapabilityProblemIdentityKey(identity)
    const toolName = metadata.toolName ?? 'unknown'
    const provider = metadata.provider ?? 'unknown'
    const current = buckets.get(key)

    if (current) {
      const candidate = current.candidate
      candidate.affectedTools = mergeSortedUnique(candidate.affectedTools, toolName)
      candidate.providers = mergeSortedUnique(candidate.providers, provider)
      candidate.legacyProblemIds = mergeSortedUnique(candidate.legacyProblemIds, problem.id)
      candidate.legacyToolNames = mergeSortedUnique(candidate.legacyToolNames, toolName)
      candidate.legacyEvidence = mergeLegacyEvidence(candidate.legacyEvidence, problem, toolName, provider)
      candidate.occurrenceCount += problem.occurrenceCount
      candidate.lastSeen = Math.max(candidate.lastSeen, problem.lastSeen)

      if (compareRepresentativeProblems(problem, current.representative) < 0) {
        current.representative = problem
        applyRepresentativeFields(candidate, problem)
      }
      continue
    }

    buckets.set(key, {
      representative: problem,
      candidate: {
        identity,
        title: problem.title,
        description: problem.description,
        severity: problem.severity,
        source: problem.source,
        affectedTools: [toolName],
        providers: [provider],
        legacyProblemIds: [problem.id],
        legacyToolNames: [toolName],
        legacyEvidence: [toLegacyEvidence(problem, toolName, provider)],
        occurrenceCount: problem.occurrenceCount,
        lastSeen: problem.lastSeen,
      },
    })
  }

  const capabilityCandidates = [...buckets.values()]
    .map((entry) => entry.candidate)
    .sort((left, right) =>
      buildCapabilityProblemIdentityKey(left.identity).localeCompare(buildCapabilityProblemIdentityKey(right.identity)),
    )

  return {
    legacyCandidates: input.legacyProblems,
    capabilityCandidates,
    comparison: {
      runId: input.runId,
      generatedAt: input.generatedAt,
      eligibleLegacyCount: eligible.length,
      capabilityCandidateCount: capabilityCandidates.length,
      legacyOnlyProblemCount: input.legacyProblems.length - eligible.length,
      matchedProblemCount: eligible.length,
      decisionConsistencyRate: 0,
      fragmentationReduction: eligible.length - capabilityCandidates.length,
      fragmentationReductionRate: eligible.length === 0 ? 0 : (eligible.length - capabilityCandidates.length) / eligible.length,
    },
  }
}

function mergeLegacyEvidence(
  evidence: CapabilityProblemCandidate['legacyEvidence'],
  problem: Problem,
  toolName: string,
  provider: string,
): NonNullable<CapabilityProblemCandidate['legacyEvidence']> {
  const entries = new Map((evidence ?? []).map((entry) => [entry.legacyProblemId, entry]))
  entries.set(problem.id, toLegacyEvidence(problem, toolName, provider))

  return [...entries.values()].sort((left, right) => left.legacyProblemId.localeCompare(right.legacyProblemId))
}

function toLegacyEvidence(problem: Problem, toolName: string, provider: string) {
  return {
    legacyProblemId: problem.id,
    toolName,
    provider,
    raw: problem.context.raw,
  }
}

function mergeSortedUnique(values: string[], nextValue: string): string[] {
  return [...new Set([...values, nextValue])].sort()
}

function applyRepresentativeFields(candidate: CapabilityProblemCandidate, problem: Problem): void {
  candidate.title = problem.title
  candidate.description = problem.description
  candidate.severity = problem.severity
  candidate.source = problem.source
}

function compareRepresentativeProblems(left: Problem, right: Problem): number {
  const severityDelta = compareSeverity(left.severity, right.severity)
  if (severityDelta !== 0) return severityDelta

  return compareStableStrings(
    [left.title, left.description, left.source, left.id],
    [right.title, right.description, right.source, right.id],
  )
}

function compareSeverity(left: Problem['severity'], right: Problem['severity']): number {
  return severityRank(right) - severityRank(left)
}

function severityRank(value: Problem['severity']): number {
  switch (value) {
    case 'error':
      return 3
    case 'warning':
      return 2
    case 'info':
      return 1
  }
}

function compareStableStrings(left: string[], right: string[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index].localeCompare(right[index])
    if (delta !== 0) {
      return delta
    }
  }

  return 0
}
