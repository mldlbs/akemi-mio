import { evaluatePilotExitCriteria } from '@akemi-mio/evolution/automation/CapabilityPilotHealthMonitor'
import type { CapabilityPilotRunRecord } from '@akemi-mio/evolution/automation/CapabilityPilotDecisionGate'
import type { CapabilityEvolutionShadowRun } from '@akemi-mio/evolution/automation/CapabilityShadowRunHydrator'

function makeRun(id: string, generatedAt: number, eligibilityRate = 1, coverageRate = 1): CapabilityPilotRunRecord {
  return {
    runId: id,
    generatedAt,
    decisionCount: 1,
    eligibleCount: 1,
    eligibilityRate,
    decisions: [],
    shadowRunCount: 1,
    guardrails: {
      executorAuthorityUnchanged: true,
      problemQueueUnchanged: true,
      shadowGateActive: true,
    },
  }
}

function makeShadow(coverageRate: number): CapabilityEvolutionShadowRun {
  return {
    runId: 'shadow-test',
    collectorName: 'capability-evolution-shadow-collector',
    generatedAt: Date.now(),
    observations: [],
    summary: {
      totalToolEvents: 100,
      capabilityEvents: Math.round(100 * coverageRate),
      coverageRate,
      legacyBucketCount: 2,
      capabilityBucketCount: 1,
      aggregationGain: 1,
      aggregationGainRate: 0.5,
      trendSampleCount: 1,
      trendCorrelation: null,
    },
  }
}

describe('evaluatePilotExitCriteria', () => {
  it('returns monitoring when window < 7 days', async () => {
    const runs = [makeRun('pilot-1', Date.now() - 2 * 24 * 60 * 60 * 1000)]
    const result = await evaluatePilotExitCriteria({
      pilotRuns: runs,
      shadowRuns: [makeShadow(1)],
      generatedAt: Date.now(),
    })
    expect(result.decision).toBe('monitoring')
    expect(result.triggers).toEqual([])
  })

  it('returns exit_ready after 7 consecutive days with sustained coverage & consistency', async () => {
    const base = Date.now() - 7 * 24 * 60 * 60 * 1000
    const runs = Array.from({ length: 7 }, (_, i) => makeRun(`pilot-${i}`, base + i * 24 * 60 * 60 * 1000))
    const result = await evaluatePilotExitCriteria({
      pilotRuns: runs,
      shadowRuns: [makeShadow(0.95)],
      generatedAt: Date.now(),
    })
    expect(result.decision).toBe('exit_ready')
    expect(result.window?.consecutiveDays).toBe(7)
    expect(result.metrics?.averageCoverageRate).toBeGreaterThanOrEqual(0.9)
    expect(result.metrics?.averageEligibilityRate).toBeGreaterThanOrEqual(0.9)
    expect(result.triggers).toEqual([])
  })

  it('returns rollback_required when a trigger fires', async () => {
    const runs = Array.from({ length: 5 }, (_, i) => makeRun(`pilot-${i}`, Date.now() - i * 1_000_000))
    const result = await evaluatePilotExitCriteria({
      pilotRuns: runs,
      shadowRuns: [makeShadow(0.7)],
      executorRegressionCount: 1,
      generatedAt: Date.now(),
    })
    expect(result.decision).toBe('rollback_required')
    expect(result.triggers).toContain('executor_regression')
    expect(result.triggers).toContain('coverage_drop')
  })

  it('treats a broken streak as monitoring even with enough total days', async () => {
    const runs = [
      makeRun('p0', Date.now() - 0),
      makeRun('p1', Date.now() - 1 * 24 * 60 * 60 * 1000),
      makeRun('p2', Date.now() - 2 * 24 * 60 * 60 * 1000),
      makeRun('p10', Date.now() - 10 * 24 * 60 * 60 * 1000),
      makeRun('p11', Date.now() - 11 * 24 * 60 * 60 * 1000),
    ]
    const result = await evaluatePilotExitCriteria({
      pilotRuns: runs,
      shadowRuns: [makeShadow(1)],
      generatedAt: Date.now(),
    })
    expect(result.window.spanDays).toBe(11)
    expect(result.window.consecutiveDays).toBe(3)
    expect(result.decision).toBe('monitoring')
  })

  it('triggers consistency_drop when eligibility falls below the rollback threshold', async () => {
    const runs = Array.from({ length: 7 }, (_, i) => {
      const r = makeRun(`pilot-${i}`, Date.now() - i * 24 * 60 * 60 * 1000, 0.5, 1)
      r.eligibleCount = 0
      return r
    })
    const result = await evaluatePilotExitCriteria({
      pilotRuns: runs,
      shadowRuns: [makeShadow(1)],
      generatedAt: Date.now(),
    })
    expect(result.decision).toBe('rollback_required')
    expect(result.triggers).toContain('consistency_drop')
    expect(result.metrics.ineligibleDecisionCount).toBe(7)
  })
})
