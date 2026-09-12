export type RepeatabilityVerdict = 'repeatable_positive' | 'insufficient_evidence'

export interface RepeatabilityCaseIdentity {
  caseFamily: string
  capability: string
  operation: string
  issueType: string
  windowId: string
}

export interface RepeatabilityHistoryEntry extends RepeatabilityCaseIdentity {
  traceId: string
}

export interface RepeatabilitySummary {
  schemaVersion: 1
  generatedAt: string
  target: RepeatabilityCaseIdentity
  verdict: RepeatabilityVerdict
  comparison: {
    independentWindowCount: number
    matchedWindowIds: string[]
  }
  traceRefs: string[]
}

export function evaluateRepeatability(
  target: RepeatabilityCaseIdentity,
  history: RepeatabilityHistoryEntry[],
  generatedAt: string,
): RepeatabilitySummary {
  validateCaseIdentity(target, 'target')
  history.forEach((entry, index) => validateHistoryEntry(entry, `history[${index}]`))

  const matchedWindowIds = Array.from(
    new Set(history.filter((entry) => isSameIdentity(target, entry) && entry.windowId !== target.windowId).map((entry) => entry.windowId)),
  ).sort((left, right) => left.localeCompare(right))
  const traceRefs = history
    .filter((entry) => matchedWindowIds.includes(entry.windowId) && isSameIdentity(target, entry))
    .map((entry) => entry.traceId)
    .sort((left, right) => left.localeCompare(right))

  return {
    schemaVersion: 1,
    generatedAt,
    target,
    verdict: matchedWindowIds.length > 0 ? 'repeatable_positive' : 'insufficient_evidence',
    comparison: {
      independentWindowCount: matchedWindowIds.length,
      matchedWindowIds,
    },
    traceRefs,
  }
}

function isSameIdentity(left: RepeatabilityCaseIdentity, right: RepeatabilityCaseIdentity): boolean {
  return (
    left.caseFamily === right.caseFamily &&
    left.capability === right.capability &&
    left.operation === right.operation &&
    left.issueType === right.issueType
  )
}

function validateCaseIdentity(identity: RepeatabilityCaseIdentity, label: string): void {
  for (const field of ['caseFamily', 'capability', 'operation', 'issueType', 'windowId'] as const) {
    if (identity[field].trim() === '') {
      throw new Error(`${label}.${field} must be a non-empty string`)
    }
  }
}

function validateHistoryEntry(entry: RepeatabilityHistoryEntry, label: string): void {
  validateCaseIdentity(entry, label)

  if (entry.traceId.trim() === '') {
    throw new Error(`${label}.traceId must be a non-empty string`)
  }
}
