export interface ObservedMemoryEntry {
  content: string
  updatedAt: number
  structuredData?: string | null
}

export interface ParsedObservedMemoryEntry extends ObservedMemoryEntry {
  kind: 'capability' | 'legacy' | 'other'
  capability?: string
  operation?: string
  toolName?: string
  argTokens: string[]
}

export interface StoredEventCoverage {
  totalStored: number
  resolvedStored: number
  identityCoverageRate: number
}

export interface IdentityCoverageMetrics {
  totalCallMemories: number
  capabilityTaggedMemories: number
  identityCoverageRate: number
}

export interface RetrievalAlignmentMetrics {
  sampleCount: number
  oldSameCapabilityTop1Rate: number
  newSameCapabilityTop1Rate: number
  oldAvgCapabilityVsLegacyGap: number
  newAvgCapabilityVsLegacyGap: number
}

export interface BiasShiftMetrics {
  sampleCount: number
  oldCapabilityTop1Rate: number
  newCapabilityTop1Rate: number
  oldLegacyTop1Rate: number
  newLegacyTop1Rate: number
}

export interface MemoryObservationReport {
  identityCoverage: IdentityCoverageMetrics
  retrievalAlignment: RetrievalAlignmentMetrics
  biasShift: BiasShiftMetrics
}

type QueryMode = 'legacy' | 'capability'

interface QueryShape {
  toolName?: string
  capability?: string
  operation?: string
  argTokens: string[]
}

export function parseObservedMemoryEntry(entry: ObservedMemoryEntry): ParsedObservedMemoryEntry {
  const structuredIdentity = parseStructuredIdentity(entry.structuredData)

  if (entry.content.startsWith('[能力调用]')) {
    const capability = firstMatch(entry.content, /\bcapability:([^\s)]+)/) ?? structuredIdentity?.capability
    const operation = firstMatch(entry.content, /\boperation:([^\s)]+)/) ?? structuredIdentity?.operation
    const toolName = firstMatch(entry.content, /\btool:([^\s)]+)/) ?? structuredIdentity?.tool
    return {
      ...entry,
      kind: 'capability',
      capability,
      operation,
      toolName,
      argTokens: extractArgTokens(entry.content),
    }
  }

  if (entry.content.startsWith('[工具调用]')) {
    const rest = entry.content.slice('[工具调用] '.length)
    const parenIdx = rest.indexOf('(')
    const arrowIdx = rest.indexOf(' →')
    const endIdx = parenIdx > 0 ? parenIdx : arrowIdx > 0 ? arrowIdx : rest.length
    return {
      ...entry,
      kind: 'legacy',
      capability: structuredIdentity?.capability,
      operation: structuredIdentity?.operation,
      toolName: rest.slice(0, endIdx).trim() || structuredIdentity?.tool,
      argTokens: extractArgTokens(entry.content),
    }
  }

  return {
    ...entry,
    kind: 'other',
    capability: structuredIdentity?.capability,
    operation: structuredIdentity?.operation,
    toolName: structuredIdentity?.tool,
    argTokens: [],
  }
}

export function analyzeStoredEventCoverage(events: Array<Record<string, unknown>>): StoredEventCoverage {
  const stored = events.filter((event) => event.event === 'memory_interceptor_stored')
  const resolvedStored = stored.filter((event) => typeof event.capability === 'string' && event.capability.length > 0)
  return {
    totalStored: stored.length,
    resolvedStored: resolvedStored.length,
    identityCoverageRate: stored.length > 0 ? resolvedStored.length / stored.length : 0,
  }
}

export function analyzeMemoryObservation(entries: ObservedMemoryEntry[]): MemoryObservationReport {
  const parsed = entries.map(parseObservedMemoryEntry)
  const callEntries = parsed.filter((entry) => entry.kind === 'capability' || entry.kind === 'legacy')
  const capabilityEntries = parsed.filter((entry) => entry.kind === 'capability' && entry.capability)

  const identityCoverage: IdentityCoverageMetrics = {
    totalCallMemories: callEntries.length,
    capabilityTaggedMemories: capabilityEntries.length,
    identityCoverageRate: callEntries.length > 0 ? capabilityEntries.length / callEntries.length : 0,
  }

  const comparison = compareQueries(capabilityEntries, callEntries)

  return {
    identityCoverage,
    retrievalAlignment: {
      sampleCount: comparison.sampleCount,
      oldSameCapabilityTop1Rate: ratio(comparison.oldSameCapabilityTop1, comparison.sampleCount),
      newSameCapabilityTop1Rate: ratio(comparison.newSameCapabilityTop1, comparison.sampleCount),
      oldAvgCapabilityVsLegacyGap: average(comparison.oldCapabilityVsLegacyGaps),
      newAvgCapabilityVsLegacyGap: average(comparison.newCapabilityVsLegacyGaps),
    },
    biasShift: {
      sampleCount: comparison.sampleCount,
      oldCapabilityTop1Rate: ratio(comparison.oldCapabilityTop1, comparison.sampleCount),
      newCapabilityTop1Rate: ratio(comparison.newCapabilityTop1, comparison.sampleCount),
      oldLegacyTop1Rate: ratio(comparison.oldLegacyTop1, comparison.sampleCount),
      newLegacyTop1Rate: ratio(comparison.newLegacyTop1, comparison.sampleCount),
    },
  }
}

function compareQueries(
  capabilityEntries: ParsedObservedMemoryEntry[],
  corpus: ParsedObservedMemoryEntry[],
): {
  sampleCount: number
  oldSameCapabilityTop1: number
  newSameCapabilityTop1: number
  oldCapabilityTop1: number
  newCapabilityTop1: number
  oldLegacyTop1: number
  newLegacyTop1: number
  oldCapabilityVsLegacyGaps: number[]
  newCapabilityVsLegacyGaps: number[]
} {
  let sampleCount = 0
  let oldSameCapabilityTop1 = 0
  let newSameCapabilityTop1 = 0
  let oldCapabilityTop1 = 0
  let newCapabilityTop1 = 0
  let oldLegacyTop1 = 0
  let newLegacyTop1 = 0
  const oldCapabilityVsLegacyGaps: number[] = []
  const newCapabilityVsLegacyGaps: number[] = []

  for (const target of capabilityEntries) {
    const peers = corpus.filter((entry) => entry !== target)
    const oldQuery = buildQuery(target, 'legacy')
    const newQuery = buildQuery(target, 'capability')
    const oldRanked = rankEntries(peers, oldQuery, 'legacy')
    const newRanked = rankEntries(peers, newQuery, 'capability')

    if (oldRanked.length === 0 && newRanked.length === 0) continue
    sampleCount++

    const oldTop = oldRanked[0]
    const newTop = newRanked[0]

    if (oldTop?.entry.kind === 'capability') oldCapabilityTop1++
    if (newTop?.entry.kind === 'capability') newCapabilityTop1++
    if (oldTop?.entry.kind === 'legacy') oldLegacyTop1++
    if (newTop?.entry.kind === 'legacy') newLegacyTop1++

    if (oldTop?.entry.capability === target.capability) oldSameCapabilityTop1++
    if (newTop?.entry.capability === target.capability) newSameCapabilityTop1++

    oldCapabilityVsLegacyGaps.push(bestKindScore(oldRanked, 'capability') - bestKindScore(oldRanked, 'legacy'))
    newCapabilityVsLegacyGaps.push(bestKindScore(newRanked, 'capability') - bestKindScore(newRanked, 'legacy'))
  }

  return {
    sampleCount,
    oldSameCapabilityTop1,
    newSameCapabilityTop1,
    oldCapabilityTop1,
    newCapabilityTop1,
    oldLegacyTop1,
    newLegacyTop1,
    oldCapabilityVsLegacyGaps,
    newCapabilityVsLegacyGaps,
  }
}

function buildQuery(entry: ParsedObservedMemoryEntry, mode: QueryMode): QueryShape {
  if (mode === 'legacy') {
    return {
      toolName: entry.toolName,
      argTokens: entry.argTokens,
    }
  }

  return {
    toolName: entry.toolName,
    capability: entry.capability,
    operation: entry.operation,
    argTokens: entry.argTokens,
  }
}

function rankEntries(entries: ParsedObservedMemoryEntry[], query: QueryShape, mode: QueryMode) {
  return entries
    .map((entry) => ({ entry, score: scoreEntry(entry, query, mode) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt)
}

function scoreEntry(entry: ParsedObservedMemoryEntry, query: QueryShape, mode: QueryMode): number {
  let score = 0

  if (mode === 'capability' && query.capability && entry.capability === query.capability) {
    score += 4
  }
  if (mode === 'capability' && query.operation && entry.operation === query.operation) {
    score += 2
  }
  if (query.toolName && entry.toolName === query.toolName) {
    score += 3
  }
  for (const token of query.argTokens) {
    if (token.length > 1 && entry.argTokens.includes(token)) {
      score += 1
    }
  }

  return score
}

function bestKindScore(ranked: Array<{ entry: ParsedObservedMemoryEntry; score: number }>, kind: 'capability' | 'legacy'): number {
  const match = ranked.find((row) => row.entry.kind === kind)
  return match?.score ?? 0
}

function extractArgTokens(content: string): string[] {
  const matches = [...content.matchAll(/([a-zA-Z0-9_]+)=([^,)]+)/g)]
  const tokens = new Set<string>()

  for (const match of matches) {
    const rawValue = match[2]?.trim()
    if (!rawValue) continue
    tokens.add(rawValue)
    const normalized = rawValue.replace(/[\\/:\n\r]+/g, ' ').trim()
    if (normalized) tokens.add(normalized)
    for (const part of normalized.split(/\s+/)) {
      if (part) tokens.add(part)
    }
  }

  return [...tokens]
}

function parseStructuredIdentity(structuredData?: string | null): {
  capability?: string
  operation?: string
  tool?: string
} | null {
  if (!structuredData) return null
  try {
    const parsed = JSON.parse(structuredData)
    return parsed?.identity ?? null
  } catch {
    return null
  }
}

function firstMatch(text: string, regex: RegExp): string | undefined {
  return text.match(regex)?.[1]
}

function average(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function ratio(value: number, total: number): number {
  return total > 0 ? value / total : 0
}
