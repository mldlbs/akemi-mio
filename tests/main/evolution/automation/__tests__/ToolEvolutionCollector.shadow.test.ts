import { describe, expect, it, vi } from 'vitest'

const { getProblematicTools, getProblematicToolIdentitySummaries, analyzeTool } = vi.hoisted(() => ({
  getProblematicTools: vi.fn(),
  getProblematicToolIdentitySummaries: vi.fn(),
  analyzeTool: vi.fn(),
}))

vi.mock('@akemi-mio/capabilities/tool/ToolStatsTracker', () => ({
  toolStatsTracker: { getProblematicTools, getProblematicToolIdentitySummaries },
}))

vi.mock('@akemi-mio/capabilities/tool/FailurePatternAnalyzer', () => ({
  failurePatternAnalyzer: { analyzeTool },
}))

import { ToolEvolutionCollector } from '@akemi-mio/evolution/automation/ToolEvolutionCollector'

describe('ToolEvolutionCollector shadow metadata', () => {
  it('adds complete identity as shadow metadata without changing legacy problem ids, source, or order', async () => {
    const problematicTools = [
      { toolName: 'write_file', errorRate: 0.8, totalCalls: 5, reason: 'write failures', suggestion: 'general' as const },
      { toolName: 'legacy_tool', errorRate: 0.6, totalCalls: 5, reason: 'legacy failures', suggestion: 'general' as const },
    ]
    getProblematicTools.mockReturnValue(problematicTools)
    getProblematicToolIdentitySummaries.mockReturnValue([
      {
        problematicTool: problematicTools[0],
        identitySummary: {
          toolName: 'write_file',
          capability: 'file.management',
          operation: 'write',
          provider: '@builtin/core',
          mixed: false,
          provenance: [{ toolName: 'write_file', capability: 'file.management', operation: 'write', provider: '@builtin/core' }],
        },
      },
      {
        problematicTool: problematicTools[1],
        unresolvedIdentityStats: {
          unresolvedCalls: 5,
          missingCapabilityCount: 5,
          missingOperationCount: 5,
          missingProviderCount: 5,
        },
      },
    ])
    analyzeTool.mockReturnValue([])

    const problems = await new ToolEvolutionCollector().collect()

    expect(problems.map((problem) => ({ id: problem.id, source: problem.source }))).toEqual([
      { id: 'tool:write_file:error_rate', source: 'tool' },
      { id: 'tool:legacy_tool:error_rate', source: 'tool' },
    ])
    expect(problems[0]).toMatchObject({
      affectedCapability: 'file.management',
      context: { metadata: { toolName: 'write_file', operation: 'write', issueType: 'error_rate', provider: '@builtin/core' } },
    })
    expect(problems[1]).not.toHaveProperty('affectedCapability')
    expect(problems[1].context.metadata).toMatchObject({
      toolName: 'legacy_tool',
      unresolvedIdentityStats: JSON.stringify({
        unresolvedCalls: 5,
        missingCapabilityCount: 5,
        missingOperationCount: 5,
        missingProviderCount: 5,
      }),
    })
  })
})
