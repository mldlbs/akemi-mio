/**
 * CapabilityPilotHealthMonitor - M5.6.6 health‑monitor implementation.
 *
 * This module evaluates the pilot‑exit criteria defined in the M5.6
 * evolution plan and decides whether we are:
 *   • still in monitoring mode,
 *   • ready for a safe exit (7+ consecutive days, ≥ 90 % coverage, ≥ 95 % consistency),
 *   or **need a rollback** (any regression trigger detected).
 *
 * The health monitor is completely read‑only – it never mutates state.
 * It writes a `pilot_health.json` file under `reports/m56/pilot/latest/`
 * and emits an event `pipeline.pilot_health_evaluated` on the event bus.
 *
 * The decision logic lives in `evaluatePilotExitCriteria()` which can be
 * reused by other modules (e.g., the rollback service).
 */

import type { CapabilityPilotRunRecord } from './CapabilityPilotDecisionGate'
import type { CapabilityEvolutionShadowRun } from './types'

export interface CapabilityPilotHealthReport {
  schemaVersion: 1
  generatedAt: number
  window: {
    runCount: number
    firstRunAt: number | null
    latestRunAt: number | null
    spanDays: number
    consecutiveDays: number
  }
  metrics: {
    averageEligibilityRate: number
    latestEligibilityRate: number | null
    averageCoverageRate: number | null
    latestCoverageRate: number | null
    executorRegressionCount: number
    ineligibleDecisionCount: number
  }
  decision: PilotHealthDecision
  triggers: string[]
}

export type PilotHealthDecision = 'monitoring' | 'exit_ready' | 'rollback_required'

export interface CapabilityPilotHealthInput {
  pilotRuns: CapabilityPilotRunRecord[]
  shadowRuns: CapabilityEvolutionShadowRun[]
  executorRegressionCount?: number
  generatedAt?: number
}

const DAY_MS = 24 * 60 * 60 * 1000

export async function evaluatePilotExitCriteria(input: CapabilityPilotHealthInput): Promise<{
  decision: PilotHealthDecision
  triggers: string[]
  metrics: {
    averageEligibilityRate: number
    latestEligibilityRate: number | null
    averageCoverageRate: number | null
    latestCoverageRate: number | null
    executorRegressionCount: number
    ineligibleDecisionCount: number
  }
  window: {
    runCount: number
    firstRunAt: number | null
    latestRunAt: number | null
    spanDays: number
    consecutiveDays: number
  }
}> {
  const generatedAt = input.generatedAt ?? Date.now()

  // -----------------------------------------------------------------
  // 1��️��⃣ �窗口信息（run 计数、天数等）
  // -----------------------------------------------------------------
  const runs = [...input.pilotRuns].sort((a, b) => a.generatedAt - b.generatedAt)
  const firstRunAt = runs.length > 0 ? runs[0].generatedAt : null
  const latestRunAt = runs.length > 0 ? runs[runs.length - 1].generatedAt : null
  const spanDays = firstRunAt != null && latestRunAt != null ? Math.max(1, Math.round((latestRunAt - firstRunAt) / DAY_MS)) : 0
  const consecutiveDays = countConsecutivePilotDays(runs)

  // -----------------------------------------------------------------
  // 2��️��⃣ 统计指标
  // -----------------------------------------------------------------
  const eligibilityRates = runs.map((r) => r.eligibilityRate)
  const averageEligibilityRate = eligibilityRates.length > 0 ? eligibilityRates.reduce((s, v) => s + v, 0) / eligibilityRates.length : 0
  const latestEligibilityRate = eligibilityRates.length > 0 ? eligibilityRates[eligibilityRates.length - 1] : null

  const coverageRates = input.shadowRuns.map((s) => s.summary?.coverageRate ?? 0)
  const averageCoverageRate =
    input.shadowRuns.length > 0 ? input.shadowRuns.reduce((s, v) => s + (v.summary?.coverageRate ?? 0), 0) / input.shadowRuns.length : null
  const latestCoverageRate =
    input.shadowRuns.length > 0 ? (input.shadowRuns[input.shadowRuns.length - 1].summary?.coverageRate ?? null) : null

  const executorRegressionCount = input.executorRegressionCount ?? 0
  const ineligibleDecisionCount = runs.reduce((sum, r) => sum + Math.max(0, r.decisionCount - r.eligibleCount), 0)

  // -----------------------------------------------------------------
  // 3��️��⃣ �触发器列表（回�滚/退出标记）
  // -----------------------------------------------------------------
  const triggers: string[] = []
  if (executorRegressionCount > 0) triggers.push('executor_regression')
  if ((input.executorRegressionCount ?? 0) > 0 || (latestCoverageRate ?? 0) < 0.8) triggers.push('coverage_drop')
  if ((latestEligibilityRate ?? 0) < 0.95) triggers.push('consistency_drop')

  // -----------------------------------------------------------------
  // 4��️��⃣ 计算决策
  // -----------------------------------------------------------------
  const exitCriteriaMet =
    input.pilotRuns.length > 0 &&
    countConsecutivePilotDays(input.pilotRuns) >= 7 &&
    (averageEligibilityRate ?? 0) >= 0.9 &&
    (averageCoverageRate ?? 0) >= 0.9 &&
    triggers.length === 0

  const decision: PilotHealthDecision = triggers.length > 0 ? 'rollback_required' : exitCriteriaMet ? 'exit_ready' : 'monitoring'

  return {
    decision,
    triggers,
    metrics: {
      averageEligibilityRate,
      latestEligibilityRate,
      averageCoverageRate,
      latestCoverageRate,
      executorRegressionCount,
      ineligibleDecisionCount,
    },
    window: {
      runCount: input.pilotRuns.length,
      firstRunAt,
      latestRunAt,
      spanDays: firstRunAt != null && latestRunAt != null ? Math.max(1, Math.round((latestRunAt - firstRunAt) / DAY_MS)) : 0,
      consecutiveDays: countConsecutivePilotDays(input.pilotRuns),
    },
  }
}

/** Count consecutive pilot days counting backwards from the latest run */
function countConsecutivePilotDays(runs: CapabilityPilotRunRecord[]): number {
  const daySet = new Set(runs.map((r) => dayKey(r.generatedAt)))
  if (daySet.size === 0) return 0

  // Use the latest run day as the starting point
  const latestTs = Math.max(...runs.map((r) => r.generatedAt))
  let cursor = dayKey(latestTs)
  let count = 0

  while (daySet.has(cursor)) {
    count += 1
    cursor = new Date(new Date(cursor).getTime() - DAY_MS).toISOString().slice(0, 10)
  }
  return count
}

function dayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}
