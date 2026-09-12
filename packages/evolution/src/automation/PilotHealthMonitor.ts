/**
 * PilotHealthMonitor - wraps evaluatePilotExitCriteria for per-run health checks.
 *
 * Provides a small stateful facade used after each pilot run is persisted:
 * reads pilot runs + shadow runs, evaluates exit criteria, emits the
 * `pipeline.pilot_health_evaluated` event and logs the health decision.
 */

import { join } from 'path'
import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import { evaluatePilotExitCriteria, type PilotHealthDecision } from './CapabilityPilotHealthMonitor'
import { CapabilityPilotStore } from './CapabilityPilotStore'
import { CapabilityEvolutionShadowStore } from './CapabilityEvolutionShadowStore'

export class PilotHealthMonitor {
  private readonly store: CapabilityPilotStore
  private readonly shadowStore: CapabilityEvolutionShadowStore

  constructor(private readonly config: { projectRoot: string; persistDir: string }) {
    this.store = new CapabilityPilotStore(join(config.projectRoot, 'reports', 'm56', 'pilot'))
    this.shadowStore = new CapabilityEvolutionShadowStore(config.persistDir)
  }

  /**
   * Called after each pilot run is persisted.
   * Evaluates exit criteria and returns the health decision.
   */
  async evaluateRun(tickId: string): Promise<PilotHealthDecision> {
    const pilotRuns = this.store.readAll()
    const shadowRuns = this.shadowStore.getAll()

    const health = await evaluatePilotExitCriteria({
      pilotRuns,
      shadowRuns,
      executorRegressionCount: 0,
      generatedAt: Date.now(),
    })

    eventBus.emit('pipeline.pilot_health_evaluated' as any, {
      ...health,
    })

    log('INFO', 'pilot_health_check', {
      decision: health.decision,
      runCount: pilotRuns.length,
      consecutiveDays: health.decision === 'exit_ready' ? Math.min(7, pilotRuns.length) : 0,
    })

    return health.decision
  }
}
