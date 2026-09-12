/**
 * CapabilityShadowRunHydrator ? hydrate legacy Problem[] from persisted
 * capability shadow observation runs.
 *
 * Shared by the migration report CLI and the M5.6.5 capability-led pilot gate
 * so both consume the same shadow observation window.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

import type { CapabilityEvolutionShadowRun, Problem } from './types'

const SHADOW_RUNS_FILE = 'capability_evolution_shadow_runs.json'

export function deriveIssueTypeFromShadowMetrics(input: { errorRate: number; avgLatencyMs: number }): 'error_rate' | 'latency' | 'general' {
  if (input.errorRate >= 0.2) return 'error_rate'
  if (input.avgLatencyMs >= 10_000) return 'latency'
  return 'general'
}

export function buildLegacyProblemsFromShadowRuns(runs: CapabilityEvolutionShadowRun[]): Problem[] {
  const problems: Problem[] = []
  const seen = new Set<string>()

  for (const run of runs) {
    for (const observation of run.observations ?? []) {
      const capability = observation.capabilityIdentity?.capability
      const operation = observation.capabilityIdentity?.operation ?? 'unknown'
      const provider = observation.capabilityIdentity?.provider ?? 'unknown'
      const issueType = deriveIssueTypeFromShadowMetrics(observation.metrics)
      const tools = observation.legacyIdentity?.tools ?? []

      for (const toolName of tools) {
        const id = `shadow:${run.runId}:${toolName}:${operation}:${issueType}`
        if (seen.has(id)) continue
        seen.add(id)

        const eventCount = Math.max(1, observation.metrics?.count ?? 1)
        problems.push({
          id,
          source: 'tool',
          severity: observation.metrics?.errorRate != null && observation.metrics.errorRate >= 0.2 ? 'error' : 'warning',
          title: `工具 "${toolName}" 能力身份观测: ${capability ?? 'unknown'} ${operation}`,
          description: `${toolName} → ${capability ?? 'unknown'} ${operation} (${issueType})`,
          estimatedCostChars: eventCount * 10,
          lastSeen: run.generatedAt,
          occurrenceCount: eventCount,
          context: {
            raw: [
              `shadow observation run=${run.runId}`,
              `tool=${toolName}`,
              `capability=${capability ?? 'unknown'}`,
              `operation=${operation}`,
              `provider=${provider}`,
              `issueType=${issueType}`,
              `count=${observation.metrics?.count ?? 0}`,
              `errorRate=${observation.metrics?.errorRate ?? 0}`,
              `avgLatencyMs=${observation.metrics?.avgLatencyMs ?? 0}`,
            ].join('\n'),
            metadata: {
              toolName,
              provider,
              operation,
              issueType,
              capability: capability ?? '',
              shadowRunId: run.runId,
              shadowRunGeneratedAt: String(run.generatedAt),
              observedEventCount: String(observation.metrics?.count ?? 0),
              observedErrorRate: String(observation.metrics?.errorRate ?? 0),
              observedAvgLatencyMs: String(observation.metrics?.avgLatencyMs ?? 0),
            },
          },
          affectedCapability: capability,
        })
      }
    }
  }

  return problems
}

export function loadShadowObservationRuns(persistDir: string): CapabilityEvolutionShadowRun[] {
  const runsPath = join(persistDir, SHADOW_RUNS_FILE)
  if (!existsSync(runsPath)) return []

  try {
    const parsed: unknown = JSON.parse(readFileSync(runsPath, 'utf-8'))
    if (!Array.isArray(parsed)) return []

    return parsed.filter(
      (run): run is CapabilityEvolutionShadowRun =>
        typeof run === 'object' &&
        run !== null &&
        typeof (run as CapabilityEvolutionShadowRun).runId === 'string' &&
        Array.isArray((run as CapabilityEvolutionShadowRun).observations),
    )
  } catch {
    console.warn(`Failed to parse shadow runs at ${runsPath}; returning empty window`)
    return []
  }
}
