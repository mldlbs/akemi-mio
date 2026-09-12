import type { CapabilityEvolutionShadowRun } from './types'

export function formatCapabilityEvolutionShadowRun(run: CapabilityEvolutionShadowRun): string {
  const lines: string[] = []

  lines.push('============================================================')
  lines.push('M5.6 Shadow Observation')
  lines.push(`Run ID: ${run.runId}`)
  lines.push(`Collector: ${run.collectorName}`)
  lines.push(`Generated at: ${new Date(run.generatedAt).toISOString()}`)
  lines.push('============================================================')
  lines.push('')

  lines.push('1. Coverage')
  lines.push(`  Total tool events:      ${run.summary.totalToolEvents}`)
  lines.push(`  Capability events:      ${run.summary.capabilityEvents}`)
  lines.push(`  Coverage rate:         ${formatPct(run.summary.coverageRate)}`)
  lines.push('')

  lines.push('2. Aggregation Gain')
  lines.push(`  Legacy buckets:         ${run.summary.legacyBucketCount}`)
  lines.push(`  Capability buckets:     ${run.summary.capabilityBucketCount}`)
  lines.push(`  Aggregation gain:      ${run.summary.aggregationGain} (${formatPct(run.summary.aggregationGainRate)})`)
  lines.push('')

  lines.push('3. Trend Correlation')
  lines.push(`  Trend sample count:     ${run.summary.trendSampleCount}`)
  lines.push(`  Trend correlation:     ${run.summary.trendCorrelation === null ? 'n/a' : run.summary.trendCorrelation.toFixed(2)}`)
  lines.push('')

  lines.push('4. Capability Observations')
  if (run.observations.length === 0) {
    lines.push('  No capability-aware observations were captured in this run.')
  } else {
    for (const observation of run.observations) {
      lines.push(`  - ${observation.capabilityIdentity.capability}`)
      lines.push(`    tools: ${observation.legacyIdentity.tools.join(', ')}`)
      lines.push(`    operation: ${observation.capabilityIdentity.operation ?? 'n/a'}`)
      lines.push(`    provider: ${observation.capabilityIdentity.provider ?? 'n/a'}`)
      lines.push(
        `    metrics: count=${observation.metrics.count}, success=${formatPct(observation.metrics.successRate)}, error=${formatPct(observation.metrics.errorRate)}, avgLatencyMs=${observation.metrics.avgLatencyMs}`,
      )
      lines.push(
        `    legacy avg: count=${observation.legacyMetrics.count}, success=${formatPct(observation.legacyMetrics.successRate)}, error=${formatPct(observation.legacyMetrics.errorRate)}, avgLatencyMs=${observation.legacyMetrics.avgLatencyMs}`,
      )
    }
  }

  return lines.join('\n')
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}
