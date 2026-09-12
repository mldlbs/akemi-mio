import { describe, expect, it } from 'vitest'

import { formatCapabilityEvolutionShadowRun } from '@akemi-mio/evolution/automation/CapabilityEvolutionShadowReport'
import type { CapabilityEvolutionShadowRun } from '@akemi-mio/evolution/automation/types'

describe('CapabilityEvolutionShadowReport', () => {
  it('formats a readable observation report for the latest shadow run', () => {
    const report = formatCapabilityEvolutionShadowRun({
      runId: 'cap_shadow_demo',
      collectorName: 'capability-evolution-shadow-collector',
      generatedAt: Date.UTC(2026, 6, 29, 5, 0, 0),
      observations: [
        {
          legacyIdentity: { tools: ['edit_file', 'write_file'] },
          capabilityIdentity: { capability: 'file.management', operation: 'mixed', provider: '@builtin/core' },
          metrics: { count: 12, successRate: 0.75, errorRate: 0.25, avgLatencyMs: 42 },
          legacyMetrics: { count: 6, successRate: 0.7, errorRate: 0.3, avgLatencyMs: 39 },
        },
      ],
      summary: {
        totalToolEvents: 20,
        capabilityEvents: 18,
        coverageRate: 0.9,
        legacyBucketCount: 4,
        capabilityBucketCount: 2,
        aggregationGain: 2,
        aggregationGainRate: 0.5,
        trendSampleCount: 2,
        trendCorrelation: 0.98,
      },
    } satisfies CapabilityEvolutionShadowRun)

    expect(report).toContain('M5.6 Shadow Observation')
    expect(report).toContain('Coverage rate:         90.0%')
    expect(report).toContain('Aggregation gain:      2 (50.0%)')
    expect(report).toContain('Trend correlation:     0.98')
    expect(report).toContain('file.management')
    expect(report).toContain('edit_file, write_file')
  })
})
