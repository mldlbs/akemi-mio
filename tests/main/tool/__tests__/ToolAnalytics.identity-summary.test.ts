import { describe, expect, it, vi } from 'vitest'

const { getStats, query, getAllToolSummaries, getProblematicTools } = vi.hoisted(() => ({
  getStats: vi.fn(),
  query: vi.fn(),
  getAllToolSummaries: vi.fn(),
  getProblematicTools: vi.fn(),
}))

vi.mock('@akemi-mio/capabilities/tool/ToolCallLogStore', () => ({
  toolCallLogStore: { getStats, query },
}))

vi.mock('@akemi-mio/capabilities/tool/ToolStatsTracker', () => ({
  toolStatsTracker: { getAllToolSummaries, getProblematicTools },
}))

vi.mock('@akemi-mio/capabilities/tool/FailurePatternAnalyzer', () => ({
  failurePatternAnalyzer: { analyzeTool: vi.fn(() => []) },
}))

import { ToolAnalytics } from '@akemi-mio/capabilities/tool/ToolAnalytics'

function makeCalls(toolName: string, capability: string, operation: string, provider: string) {
  return Array.from({ length: 5 }, (_, index) => ({
    id: `${toolName}-${index}`,
    toolName,
    args: {},
    result: index === 0 ? 'ok' : null,
    error: index === 0 ? null : 'failed',
    durationMs: 10 + index,
    timestamp: index + 1,
    success: index === 0,
    errorType: index === 0 ? null : 'unknown',
    capability,
    operation,
    provider,
  }))
}

describe('ToolAnalytics identity summaries', () => {
  it('retains concrete tool and provider provenance across analytics reports', () => {
    const writeCalls = makeCalls('write_file', 'file.management', 'write', '@builtin/core')
    const publishCalls = makeCalls('publish_post', 'publishing', 'generate', '@fanqie/publish')
    const callsByTool = new Map([
      ['write_file', writeCalls],
      ['publish_post', publishCalls],
    ])

    getStats.mockReturnValue({
      totalRecords: 10,
      oldestTimestamp: 1,
      newestTimestamp: 5,
      byTool: {
        write_file: { total: 5, success: 1, failure: 4 },
        publish_post: { total: 5, success: 1, failure: 4 },
      },
    })
    getAllToolSummaries.mockReturnValue([
      {
        toolName: 'write_file',
        totalCalls: 5,
        successCount: 1,
        failureCount: 4,
        errorRate: 0.8,
        lastCallAt: 5,
        avgIntervalMs: 1,
        avgLatencyMs: 12,
      },
      {
        toolName: 'publish_post',
        totalCalls: 5,
        successCount: 1,
        failureCount: 4,
        errorRate: 0.8,
        lastCallAt: 5,
        avgIntervalMs: 1,
        avgLatencyMs: 12,
      },
    ])
    getProblematicTools.mockReturnValue([])
    query.mockImplementation(({ toolName }) => callsByTool.get(toolName) ?? [])

    const reports = new ToolAnalytics().analyzeAll().reports

    expect(reports.map((report) => report.identitySummary)).toEqual([
      expect.objectContaining({
        toolName: 'write_file',
        provider: '@builtin/core',
        provenance: [expect.objectContaining({ toolName: 'write_file', provider: '@builtin/core' })],
      }),
      expect.objectContaining({
        toolName: 'publish_post',
        provider: '@fanqie/publish',
        provenance: [expect.objectContaining({ toolName: 'publish_post', provider: '@fanqie/publish' })],
      }),
    ])
  })

  it('keeps legacy analytics report shape when persisted telemetry has no complete identity', () => {
    getStats.mockReturnValue({
      totalRecords: 1,
      oldestTimestamp: 1,
      newestTimestamp: 1,
      byTool: { list_files: { total: 1, success: 1, failure: 0 } },
    })
    getAllToolSummaries.mockReturnValue([
      {
        toolName: 'list_files',
        totalCalls: 1,
        successCount: 1,
        failureCount: 0,
        errorRate: 0,
        lastCallAt: 1,
        avgIntervalMs: 0,
        avgLatencyMs: 1,
      },
    ])
    getProblematicTools.mockReturnValue([])
    query.mockReturnValue([
      {
        id: 'legacy',
        toolName: 'list_files',
        args: {},
        result: 'ok',
        error: null,
        durationMs: 1,
        timestamp: 1,
        success: true,
        errorType: null,
      },
    ])

    const report = new ToolAnalytics().analyzeTool('list_files')

    expect(report).not.toHaveProperty('identitySummary')
    expect(report).toMatchObject({ toolName: 'list_files', totalCalls: 1, errorRate: 0 })
  })
})
