import { describe, expect, it } from 'vitest'

import type { ToolCallRecord } from '@akemi-mio/capabilities/tool/ToolCallLogStore'
import {
  analyzeToolIdentityGap,
  buildToolIdentityGapWindowReports,
  extractCapabilityToolMappingsFromSource,
} from '@akemi-mio/capabilities/tool/ToolCallIdentityGapAnalyzer'

function makeRecord(overrides: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: 'rec-1',
    toolName: 'list_files',
    args: {},
    result: 'ok',
    error: null,
    durationMs: 10,
    timestamp: 1,
    success: true,
    errorType: null,
    capability: undefined,
    operation: undefined,
    provider: undefined,
    ...overrides,
  }
}

describe('extractCapabilityToolMappingsFromSource', () => {
  it('extracts capability -> tool pairs from AppRuntime-style source', () => {
    const source = `
      dependencies: [
        { capability: 'file.management', tool: 'read_file' },
        { capability: 'search.retrieval', tool: 'grep' },
        { capability: 'system.execution', tool: 'run_command' },
        { capability: 'browser.automation', tool: 'browser_navigate' },
        { capability: 'web.scraping', tool: 'browser_navigate' },
      ]
    `

    const mappings = extractCapabilityToolMappingsFromSource(source)

    expect(mappings).toEqual({
      read_file: ['file.management'],
      grep: ['search.retrieval'],
      run_command: ['system.execution'],
      browser_navigate: ['browser.automation', 'web.scraping'],
    })
  })
})

describe('analyzeToolIdentityGap', () => {
  it('splits events into tagged, enrichment-gap, and catalog-gap buckets', () => {
    const report = analyzeToolIdentityGap(
      [
        makeRecord({ toolName: 'read_file', capability: 'file.management' }),
        makeRecord({ id: 'rec-2', toolName: 'read_file' }),
        makeRecord({ id: 'rec-3', toolName: 'grep' }),
        makeRecord({ id: 'rec-4', toolName: 'grep_search' }),
      ],
      {
        read_file: ['file.management'],
        grep: ['search.retrieval'],
      },
    )

    expect(report.summary.totalEvents).toBe(4)
    expect(report.summary.capabilityTaggedEvents).toBe(1)
    expect(report.summary.enrichmentGapEvents).toBe(3)
    expect(report.summary.catalogGapEvents).toBe(1)

    expect(report.tools).toEqual([
      expect.objectContaining({
        toolName: 'read_file',
        count: 2,
        loggedCapabilityCount: 1,
        sourceCapabilities: ['file.management'],
        classification: 'enrichment-gap',
      }),
      expect.objectContaining({
        toolName: 'grep',
        count: 1,
        loggedCapabilityCount: 0,
        sourceCapabilities: ['search.retrieval'],
        classification: 'enrichment-gap',
      }),
      expect.objectContaining({
        toolName: 'grep_search',
        count: 1,
        loggedCapabilityCount: 0,
        sourceCapabilities: [],
        classification: 'catalog-gap',
      }),
    ])
  })

  it('treats a tool as tagged when logged capability matches one of multiple source capabilities', () => {
    const report = analyzeToolIdentityGap(
      [
        makeRecord({ toolName: 'browser_navigate', capability: 'browser.automation' }),
        makeRecord({ id: 'rec-2', toolName: 'browser_navigate', capability: 'web.scraping' }),
      ],
      {
        browser_navigate: ['browser.automation', 'web.scraping'],
      },
    )

    expect(report.summary.capabilityTaggedEvents).toBe(2)
    expect(report.summary.enrichmentGapEvents).toBe(0)
    expect(report.summary.sourceMismatchEvents).toBe(0)
    expect(report.tools).toEqual([
      expect.objectContaining({
        toolName: 'browser_navigate',
        count: 2,
        loggedCapabilityCount: 2,
        loggedCapabilities: ['browser.automation', 'web.scraping'],
        sourceCapabilities: ['browser.automation', 'web.scraping'],
        classification: 'tagged',
      }),
    ])
  })

  it('builds historical and post-contract windows when since is provided', () => {
    const windows = buildToolIdentityGapWindowReports(
      [
        makeRecord({ id: 'rec-1', toolName: 'read_file', timestamp: 100 }),
        makeRecord({ id: 'rec-2', toolName: 'read_file', capability: 'file.management', timestamp: 200 }),
        makeRecord({ id: 'rec-3', toolName: 'grep_search', timestamp: 300 }),
      ],
      {
        read_file: ['file.management'],
      },
      150,
    )

    expect(windows).toHaveLength(2)
    expect(windows[0]).toMatchObject({
      label: 'Historical events',
      report: {
        summary: {
          totalEvents: 3,
          capabilityTaggedEvents: 1,
          enrichmentGapEvents: 2,
          catalogGapEvents: 1,
        },
      },
    })
    expect(windows[1]).toMatchObject({
      label: 'Post-contract events',
      sinceMs: 150,
      report: {
        summary: {
          totalEvents: 2,
          capabilityTaggedEvents: 1,
          enrichmentGapEvents: 0,
          catalogGapEvents: 1,
        },
      },
    })
  })
})
