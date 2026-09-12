import { describe, expect, it, vi } from 'vitest'

const { analyzeAll, canOptimize } = vi.hoisted(() => ({
  analyzeAll: vi.fn(),
  canOptimize: vi.fn(),
}))

vi.mock('@akemi-mio/capabilities/tool/ToolAnalytics', () => ({
  toolAnalytics: { analyzeAll },
}))

vi.mock('@akemi-mio/capabilities/tool/ToolConfigManager', () => ({
  toolConfigManager: { canOptimize },
}))

import { ToolAnalyticsCollector } from '@akemi-mio/evolution/automation/ToolAnalyticsCollector'

describe('ToolAnalyticsCollector shadow metadata', () => {
  it('adds complete identity as shadow metadata without changing legacy tool candidate semantics', async () => {
    analyzeAll.mockReturnValue({
      totalCalls: 5,
      totalTools: 1,
      problematicCount: 1,
      overallErrorRate: 0.8,
      reports: [
        {
          toolName: 'write_file',
          totalCalls: 5,
          successCount: 1,
          failureCount: 4,
          errorRate: 0.8,
          latency: null,
          trend: { direction: 'stable' },
          failurePatterns: [],
          identitySummary: {
            toolName: 'write_file',
            capability: 'file.management',
            operation: 'write',
            provider: '@builtin/core',
            mixed: false,
            provenance: [{ toolName: 'write_file', capability: 'file.management', operation: 'write', provider: '@builtin/core' }],
          },
        },
      ],
    })
    canOptimize.mockReturnValue(true)

    const problems = await new ToolAnalyticsCollector().collect()

    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({
      id: expect.stringMatching(/^tool_config_opt:write_file:consider_disable:/),
      source: 'tool',
      affectedCapability: 'file.management',
      context: { metadata: { toolName: 'write_file', operation: 'write', issueType: 'consider_disable', provider: '@builtin/core' } },
    })
  })
})
