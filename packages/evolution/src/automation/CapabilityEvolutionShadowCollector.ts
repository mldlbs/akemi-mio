import { log } from '@akemi-mio/core/logger/Logger'
import { toolCallLogStore, type ToolCallRecord } from '@akemi-mio/capabilities/tool/ToolCallLogStore'
import type { CapabilityEvolutionShadowObservation, CapabilityEvolutionShadowRun, ShadowObservationCollector } from './types'
import { CapabilityEvolutionShadowStore } from './CapabilityEvolutionShadowStore'

type CollectorOptions = {
  store: CapabilityEvolutionShadowStore
  minIntervalMs?: number
  maxRecords?: number
  recordsProvider?: () => ToolCallRecord[]
}

type Aggregate = {
  records: ToolCallRecord[]
  tools: Set<string>
  operations: Set<string>
  providers: Set<string>
}

export class CapabilityEvolutionShadowCollector implements ShadowObservationCollector {
  readonly name = 'capability-evolution-shadow-collector'

  private readonly store: CapabilityEvolutionShadowStore
  private readonly minIntervalMs: number
  private readonly maxRecords: number
  private readonly recordsProvider: () => ToolCallRecord[]
  private lastRun = 0

  constructor(options: CollectorOptions) {
    this.store = options.store
    this.minIntervalMs = options.minIntervalMs ?? 60 * 60 * 1000
    this.maxRecords = options.maxRecords ?? 500
    this.recordsProvider = options.recordsProvider ?? (() => toolCallLogStore.query({ limit: this.maxRecords }))
  }

  shouldRun(): boolean {
    return Date.now() - this.lastRun >= this.minIntervalMs
  }

  getSkipReason(): string | undefined {
    if (this.shouldRun()) return undefined
    return 'cooldown'
  }

  async collect(): Promise<CapabilityEvolutionShadowRun> {
    this.lastRun = Date.now()
    const records = this.recordsProvider()
    const run = buildCapabilityEvolutionShadowRun(this.name, records, this.lastRun)
    this.store.save(run)
    log('INFO', 'capability_shadow_collector_collected', {
      observations: run.observations.length,
      coverageRate: run.summary.coverageRate,
      aggregationGain: run.summary.aggregationGain,
      trendCorrelation: run.summary.trendCorrelation,
    })
    return run
  }
}

export function buildCapabilityEvolutionShadowRun(
  collectorName: string,
  records: ToolCallRecord[],
  now: number = Date.now(),
): CapabilityEvolutionShadowRun {
  const capabilityRecords = records.filter((record) => typeof record.capability === 'string' && record.capability.length > 0)
  const legacyToolBuckets = new Set(capabilityRecords.map((record) => record.toolName))
  const capabilityBuckets = new Map<string, Aggregate>()

  for (const record of capabilityRecords) {
    const key = record.capability!
    const existing = capabilityBuckets.get(key)
    if (existing) {
      existing.records.push(record)
      existing.tools.add(record.toolName)
      if (record.operation) existing.operations.add(record.operation)
      if (record.provider) existing.providers.add(record.provider)
    } else {
      capabilityBuckets.set(key, {
        records: [record],
        tools: new Set([record.toolName]),
        operations: record.operation ? new Set([record.operation]) : new Set<string>(),
        providers: record.provider ? new Set([record.provider]) : new Set<string>(),
      })
    }
  }

  const observations = [...capabilityBuckets.entries()]
    .map(([capability, aggregate]) => buildObservation(capability, aggregate))
    .sort((a, b) => a.capabilityIdentity.capability.localeCompare(b.capabilityIdentity.capability))

  return {
    runId: `cap_shadow_${now}_${Math.random().toString(36).slice(2, 8)}`,
    collectorName,
    generatedAt: now,
    observations,
    summary: {
      totalToolEvents: records.length,
      capabilityEvents: capabilityRecords.length,
      coverageRate: records.length > 0 ? capabilityRecords.length / records.length : 0,
      legacyBucketCount: legacyToolBuckets.size,
      capabilityBucketCount: capabilityBuckets.size,
      aggregationGain: legacyToolBuckets.size - capabilityBuckets.size,
      aggregationGainRate: legacyToolBuckets.size > 0 ? (legacyToolBuckets.size - capabilityBuckets.size) / legacyToolBuckets.size : 0,
      trendSampleCount: observations.length,
      trendCorrelation: computeTrendCorrelation(observations),
    },
  }
}

function buildObservation(capability: string, aggregate: Aggregate): CapabilityEvolutionShadowObservation {
  const capabilityMetrics = computeMetrics(aggregate.records)
  const toolMetrics = [...aggregate.tools].map((toolName) =>
    computeMetrics(aggregate.records.filter((record) => record.toolName === toolName)),
  )

  return {
    legacyIdentity: {
      tools: [...aggregate.tools].sort(),
    },
    capabilityIdentity: {
      capability,
      operation: collapseIdentitySet(aggregate.operations),
      provider: collapseIdentitySet(aggregate.providers),
    },
    metrics: capabilityMetrics,
    legacyMetrics: averageMetrics(toolMetrics),
  }
}

function computeMetrics(records: ToolCallRecord[]): {
  count: number
  successRate: number
  errorRate: number
  avgLatencyMs: number
} {
  const count = records.length
  const successCount = records.filter((record) => record.success).length
  const totalLatency = records.reduce((sum, record) => sum + (record.durationMs > 0 ? record.durationMs : 0), 0)

  return {
    count,
    successRate: count > 0 ? successCount / count : 0,
    errorRate: count > 0 ? (count - successCount) / count : 0,
    avgLatencyMs: count > 0 ? Math.round(totalLatency / count) : 0,
  }
}

function averageMetrics(
  metrics: Array<{
    count: number
    successRate: number
    errorRate: number
    avgLatencyMs: number
  }>,
): {
  count: number
  successRate: number
  errorRate: number
  avgLatencyMs: number
} {
  if (metrics.length === 0) {
    return { count: 0, successRate: 0, errorRate: 0, avgLatencyMs: 0 }
  }

  return {
    count: Math.round(metrics.reduce((sum, item) => sum + item.count, 0) / metrics.length),
    successRate: metrics.reduce((sum, item) => sum + item.successRate, 0) / metrics.length,
    errorRate: metrics.reduce((sum, item) => sum + item.errorRate, 0) / metrics.length,
    avgLatencyMs: Math.round(metrics.reduce((sum, item) => sum + item.avgLatencyMs, 0) / metrics.length),
  }
}

function collapseIdentitySet(values: Set<string>): string | undefined {
  if (values.size === 0) return undefined
  if (values.size === 1) return [...values][0]
  return 'mixed'
}

function computeTrendCorrelation(observations: CapabilityEvolutionShadowObservation[]): number | null {
  if (observations.length < 2) return null

  const xs = observations.map((item) => item.legacyMetrics.errorRate)
  const ys = observations.map((item) => item.metrics.errorRate)
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length

  let numerator = 0
  let varianceX = 0
  let varianceY = 0

  for (let index = 0; index < xs.length; index++) {
    const deltaX = xs[index] - meanX
    const deltaY = ys[index] - meanY
    numerator += deltaX * deltaY
    varianceX += deltaX * deltaX
    varianceY += deltaY * deltaY
  }

  if (varianceX === 0 || varianceY === 0) return null
  return numerator / Math.sqrt(varianceX * varianceY)
}
