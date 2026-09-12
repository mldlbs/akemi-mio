import { describe, expect, expectTypeOf, it, vi } from 'vitest'

const { getRecentCalls } = vi.hoisted(() => ({ getRecentCalls: vi.fn() }))

vi.mock('@akemi-mio/intelligence/mcp/BehaviorPredictor', () => ({
  behaviorPredictor: { getRecentCalls },
}))

import { ToolStatsTracker } from '@akemi-mio/capabilities/tool/ToolStatsTracker'
import type { ToolIdentityProvenance, ToolIdentitySummary, UnresolvedToolIdentityStats } from '@akemi-mio/capabilities/tool/ToolIdentitySummary'

expectTypeOf<ToolIdentitySummary>().toEqualTypeOf<{
  toolName: string
  capability: string
  operation: string
  provider: string
  mixed: boolean
  provenance: ToolIdentityProvenance[]
}>()

expectTypeOf<UnresolvedToolIdentityStats>().toEqualTypeOf<{
  unresolvedCalls: number
  missingCapabilityCount: number
  missingOperationCount: number
  missingProviderCount: number
}>()

describe('ToolStatsTracker identity summaries', () => {
  it('surfaces complete shadow identity for a problematic tool without changing legacy problems', () => {
    getRecentCalls.mockReturnValue(
      Array.from({ length: 5 }, (_, index) => ({
        toolName: 'write_file',
        success: index === 0,
        durationMs: 10,
        timestamp: index + 1,
        capability: 'file.management',
        operation: 'write',
        provider: '@builtin/core',
      })),
    )
    const tracker = new ToolStatsTracker()

    expect(tracker.getProblematicTools()).toEqual([
      expect.objectContaining({
        toolName: 'write_file',
        errorRate: 0.8,
        totalCalls: 5,
      }),
    ])
    expect(tracker.getProblematicTools()[0]).not.toHaveProperty('identitySummary')

    expect(tracker.getProblematicToolIdentitySummaries()).toEqual([
      expect.objectContaining({
        problematicTool: expect.objectContaining({ toolName: 'write_file' }),
        identitySummary: {
          toolName: 'write_file',
          capability: 'file.management',
          operation: 'write',
          provider: '@builtin/core',
          mixed: false,
          provenance: [
            {
              toolName: 'write_file',
              capability: 'file.management',
              operation: 'write',
              provider: '@builtin/core',
            },
          ],
        },
      }),
    ])
  })

  it('marks conflicting telemetry as mixed while retaining every provenance entry', () => {
    getRecentCalls.mockReturnValue(
      Array.from({ length: 5 }, (_, index) => ({
        toolName: 'browser_navigate',
        success: false,
        durationMs: 10,
        timestamp: index + 1,
        capability: index % 2 === 0 ? 'browser.automation' : 'web.scraping',
        operation: 'navigate',
        provider: index % 2 === 0 ? '@playwright/mcp' : '@scraper/mcp',
      })),
    )

    const [summary] = new ToolStatsTracker().getProblematicToolIdentitySummaries()

    expect(summary.identitySummary).toMatchObject({ mixed: true })
    expect(summary.identitySummary?.provenance).toEqual([
      expect.objectContaining({ capability: 'browser.automation', provider: '@playwright/mcp' }),
      expect.objectContaining({ capability: 'web.scraping', provider: '@scraper/mcp' }),
    ])
  })

  it('accounts for unresolved identity without emitting a summary or changing legacy problems', () => {
    getRecentCalls.mockReturnValue(
      Array.from({ length: 5 }, (_, index) => ({
        toolName: 'list_files',
        success: false,
        durationMs: 10,
        timestamp: index + 1,
      })),
    )

    const tracker = new ToolStatsTracker()
    const [summary] = tracker.getProblematicToolIdentitySummaries()

    expect(summary).not.toHaveProperty('identitySummary')
    expect(summary.unresolvedIdentityStats).toEqual({
      unresolvedCalls: 5,
      missingCapabilityCount: 5,
      missingOperationCount: 5,
      missingProviderCount: 5,
    })
    expect(tracker.getProblematicTools()).toEqual([
      expect.objectContaining({
        toolName: 'list_files',
        errorRate: 1,
        totalCalls: 5,
      }),
    ])
  })
})
