import type { ToolCallRecord } from './ToolCallLogStore'
import { inferCapabilityOperation, type ToolCallIdentity } from './ToolCallIdentity'

export type ToolIdentityGapClassification = 'tagged' | 'enrichment-gap' | 'catalog-gap' | 'source-mismatch'

export interface ToolIdentityGapRow {
  toolName: string
  count: number
  loggedCapabilityCount: number
  loggedCapabilities: string[]
  sourceCapabilities: string[]
  classification: ToolIdentityGapClassification
}

export interface ToolIdentityGapReport {
  summary: {
    totalEvents: number
    capabilityTaggedEvents: number
    enrichmentGapEvents: number
    catalogGapEvents: number
    sourceMismatchEvents: number
    sourceMappedEvents: number
  }
  tools: ToolIdentityGapRow[]
}

export interface ToolIdentityGapWindowReport {
  label: 'Historical events' | 'Post-contract events'
  sinceMs?: number
  report: ToolIdentityGapReport
}

export function extractCapabilityToolMappingsFromSource(source: string): Record<string, string[]> {
  const mappings: Record<string, string[]> = {}
  const pattern = /\{\s*capability:\s*['"]([^'"]+)['"]\s*,\s*tool:\s*['"]([^'"]+)['"]\s*\}/g

  for (const match of source.matchAll(pattern)) {
    const [, capability, tool] = match
    if (!mappings[tool]) {
      mappings[tool] = []
    }
    if (!mappings[tool].includes(capability)) {
      mappings[tool].push(capability)
    }
  }

  return mappings
}

export function analyzeToolIdentityGap(records: ToolCallRecord[], sourceMappings: Record<string, string[]>): ToolIdentityGapReport {
  const grouped = new Map<string, ToolCallRecord[]>()
  for (const record of records) {
    const existing = grouped.get(record.toolName)
    if (existing) existing.push(record)
    else grouped.set(record.toolName, [record])
  }

  const tools = [...grouped.entries()]
    .map(([toolName, items]) => {
      const loggedCapabilities = [...new Set(items.map((item) => item.capability).filter((value): value is string => !!value))]
      const loggedCapabilityCount = items.filter((item) => !!item.capability).length
      const sourceCapabilities = sourceMappings[toolName] ?? []

      const classification = classifyTool(items.length, loggedCapabilityCount, loggedCapabilities, sourceCapabilities)

      return {
        toolName,
        count: items.length,
        loggedCapabilityCount,
        loggedCapabilities,
        sourceCapabilities,
        classification,
      } satisfies ToolIdentityGapRow
    })
    .sort((a, b) => b.count - a.count || a.toolName.localeCompare(b.toolName))

  const summary = {
    totalEvents: records.length,
    capabilityTaggedEvents: records.filter((record) => !!record.capability).length,
    enrichmentGapEvents: sumByClassification(tools, 'enrichment-gap'),
    catalogGapEvents: sumByClassification(tools, 'catalog-gap'),
    sourceMismatchEvents: sumByClassification(tools, 'source-mismatch'),
    sourceMappedEvents: tools.filter((tool) => tool.sourceCapabilities.length > 0).reduce((sum, tool) => sum + tool.count, 0),
  }

  return { summary, tools }
}

export function buildToolIdentityGapWindowReports(
  records: ToolCallRecord[],
  sourceMappings: Record<string, string[]>,
  sinceMs?: number,
): ToolIdentityGapWindowReport[] {
  const windows: ToolIdentityGapWindowReport[] = [
    {
      label: 'Historical events',
      report: analyzeToolIdentityGap(records, sourceMappings),
    },
  ]

  if (sinceMs !== undefined) {
    windows.push({
      label: 'Post-contract events',
      sinceMs,
      report: analyzeToolIdentityGap(
        records.filter((record) => record.timestamp >= sinceMs),
        sourceMappings,
      ),
    })
  }

  return windows
}

function classifyTool(
  count: number,
  loggedCapabilityCount: number,
  loggedCapabilities: string[],
  sourceCapabilities: string[],
): ToolIdentityGapClassification {
  const hasSourceMapping = sourceCapabilities.length > 0
  const hasLoggedCapabilities = loggedCapabilityCount > 0
  const loggedCapabilitiesMatchSource = loggedCapabilities.every((capability) => sourceCapabilities.includes(capability))

  if (!hasLoggedCapabilities) {
    return hasSourceMapping ? 'enrichment-gap' : 'catalog-gap'
  }

  if (!hasSourceMapping) {
    return 'source-mismatch'
  }

  if (!loggedCapabilitiesMatchSource) {
    return 'source-mismatch'
  }

  if (loggedCapabilityCount < count) {
    return 'enrichment-gap'
  }

  return 'tagged'
}

function sumByClassification(tools: ToolIdentityGapRow[], classification: ToolIdentityGapClassification): number {
  return tools.filter((tool) => tool.classification === classification).reduce((sum, tool) => sum + tool.count, 0)
}

export function buildToolCallIdentityBackfillResolver(
  sourceMappings: Record<string, string[]>,
): (record: ToolCallRecord) => ToolCallIdentity | undefined {
  return (record) => {
    const capabilities = sourceMappings[record.toolName]
    if (!capabilities || capabilities.length === 0) return undefined

    const capability = capabilities[0]
    return {
      capability,
      operation: inferCapabilityOperation(capability, record.args ?? {}, record.toolName),
      provider: record.provider,
    }
  }
}
