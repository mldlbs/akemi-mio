import { describe, expect, it } from 'vitest'
import {
  analyzeMemoryObservation,
  analyzeStoredEventCoverage,
  parseObservedMemoryEntry,
  type ObservedMemoryEntry,
} from '@akemi-mio/intelligence/mcp/MemoryObservationAnalyzer'

describe('MemoryObservationAnalyzer', () => {
  it('parses capability-aware memory entries with identity tokens', () => {
    const parsed = parseObservedMemoryEntry({
      content:
        '[能力调用] capability:file.management operation:create tool:write_file (operation=create, path=docs/spec.md) → 成功: created docs/spec.md',
      updatedAt: 10,
      structuredData: JSON.stringify({
        identity: {
          capability: 'file.management',
          operation: 'create',
          tool: 'write_file',
        },
      }),
    })

    expect(parsed.kind).toBe('capability')
    expect(parsed.capability).toBe('file.management')
    expect(parsed.operation).toBe('create')
    expect(parsed.toolName).toBe('write_file')
    expect(parsed.argTokens).toContain('create')
    expect(parsed.argTokens).toContain('docs/spec.md')
  })

  it('computes identity coverage from stored runtime log events', () => {
    const coverage = analyzeStoredEventCoverage([
      { event: 'memory_interceptor_stored', tool: 'write_file', capability: 'file.management' },
      { event: 'memory_interceptor_stored', tool: 'grep_search', capability: 'search.retrieval' },
      { event: 'memory_interceptor_stored', tool: 'my_custom_tool' },
      { event: 'other_event' },
    ])

    expect(coverage.totalStored).toBe(3)
    expect(coverage.resolvedStored).toBe(2)
    expect(coverage.identityCoverageRate).toBeCloseTo(2 / 3, 6)
  })

  it('shows retrieval alignment and bias shift from legacy hits toward capability hits', () => {
    const entries: ObservedMemoryEntry[] = [
      {
        content:
          '[能力调用] capability:file.management operation:create tool:write_file (operation=create, path=target.ts) → 成功: created target.ts',
        updatedAt: 100,
        structuredData: JSON.stringify({
          identity: {
            capability: 'file.management',
            operation: 'create',
            tool: 'write_file',
          },
        }),
      },
      {
        content:
          '[能力调用] capability:file.management operation:create tool:write_file (operation=create, path=another.ts) → 成功: created another.ts',
        updatedAt: 90,
        structuredData: JSON.stringify({
          identity: {
            capability: 'file.management',
            operation: 'create',
            tool: 'write_file',
          },
        }),
      },
      {
        content: '[工具调用] write_file(operation=create, path=target.ts) → 成功: created target.ts',
        updatedAt: 95,
      },
      {
        content: '[工具调用] grep_search(pattern=TODO) → 成功: 2 results',
        updatedAt: 80,
      },
    ]

    const report = analyzeMemoryObservation(entries)

    expect(report.identityCoverage.totalCallMemories).toBe(4)
    expect(report.identityCoverage.capabilityTaggedMemories).toBe(2)
    expect(report.retrievalAlignment.sampleCount).toBeGreaterThan(0)
    expect(report.retrievalAlignment.newSameCapabilityTop1Rate).toBeGreaterThan(report.retrievalAlignment.oldSameCapabilityTop1Rate)
    expect(report.biasShift.newCapabilityTop1Rate).toBeGreaterThan(report.biasShift.oldCapabilityTop1Rate)
    expect(report.biasShift.newLegacyTop1Rate).toBeLessThan(report.biasShift.oldLegacyTop1Rate)
  })
})
