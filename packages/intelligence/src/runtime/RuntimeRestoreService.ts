/**
 * RuntimeRestoreService — restore entry point.
 *
 * Coordinates checkpoint load → validate → component restore → activation.
 *
 * Two-phase protocol:
 *   Phase 1 (restore):  load checkpoint, validate, restore components (no side effects)
 *   Phase 2 (activate): if Phase 1 succeeds, activate recovery plans (scheduler side effects)
 *
 * Boundaries:
 * - NOT responsible for: RuntimeTask creation (caller creates task from RestorePlan)
 * - NOT responsible for: AgentService wiring, lifecycle hooks
 * - Delegates component restore to CheckpointRestoreCoordinator
 * - Delegates checkpoint load/validate to CheckpointManager
 * - Delegates activation to injected RecoveryActivator
 *
 * On success, returns a RuntimeRestoreResult containing both the component
 * restore outcome and a RestorePlan. The caller (AgentService) uses the
 * plan to build the RuntimeTask with correct identity and execution state.
 */
import type { CheckpointId, RestoreResult, RecoveryActivator } from './CheckpointTypes'
import type { CheckpointManager } from './CheckpointManager'
import type { ComponentRegistry } from './ComponentRegistry'
import type { CheckpointRestoreCoordinator } from './CheckpointRestoreCoordinator'
import type { RestorePlan } from './RuntimeCheckpointAdapter'
import { CheckpointRestoreCoordinatorImpl } from './CheckpointRestoreCoordinator'
import { planRestore } from './RuntimeCheckpointAdapter'

/**
 * Extended restore result that includes the RestorePlan.
 * The caller uses restorePlan to create a RuntimeTask.
 */
export interface RuntimeRestoreResult extends RestoreResult {
  /** Restore plan for building a RuntimeTask on success.
   *  Undefined when status is 'failed'. */
  restorePlan?: RestorePlan
}

export interface RuntimeRestoreService {
  restore(checkpointId: CheckpointId): Promise<RuntimeRestoreResult>
  /** Caller injects the activator before calling restore().
   *  Must be set after construction but before the first restore call. */
  setActivator(activator: RecoveryActivator): void
}

export class RuntimeRestoreServiceImpl implements RuntimeRestoreService {
  private inFlight = new Set<CheckpointId>()
  private activator: RecoveryActivator | null = null

  constructor(
    private checkpointManager: CheckpointManager,
    private registry: ComponentRegistry,
  ) {}

  setActivator(activator: RecoveryActivator): void {
    this.activator = activator
  }

  async restore(checkpointId: CheckpointId): Promise<RuntimeRestoreResult> {
    // ── Guard: prevent concurrent restore of same checkpoint ──
    if (this.inFlight.has(checkpointId)) {
      return {
        status: 'failed',
        taskId: '',
        errors: [`RuntimeRestoreService: restore already in-flight for '${checkpointId}'`],
        degradedComponents: [],
      }
    }
    this.inFlight.add(checkpointId)

    try {
      // 1. load
      let checkpoint
      try {
        checkpoint = await this.checkpointManager.load(checkpointId)
      } catch (e: any) {
        return {
          status: 'failed',
          taskId: '',
          errors: [`RuntimeRestoreService: load failed: ${e.message ?? String(e)}`],
          degradedComponents: [],
        }
      }

      // 2. validate
      const validation = this.checkpointManager.validate(checkpoint)
      if (!validation.ok) {
        return {
          status: 'failed',
          taskId: checkpoint.taskId,
          errors: validation.errors,
          degradedComponents: [],
        }
      }

      // 3. generate RestorePlan
      const rp = planRestore(checkpoint)

      // 4. component restore via coordinator
      const coordinator = new CheckpointRestoreCoordinatorImpl(this.registry)
      const componentResult = await coordinator.restore(checkpoint)
      if (componentResult.status === 'failed') {
        return componentResult
      }

      // 5. Phase 2: activate recovery plans (only on success)
      if (this.activator) {
        try {
          const plans = collectRecoveryPlans(coordinator)
          await this.activator.activate(plans)
        } catch (e: any) {
          // Activation failure does NOT fail the restore — the components
          // are restored and the data is intact. The caller can retry activation.
          return {
            status: 'degraded',
            taskId: checkpoint.taskId,
            errors: [`RuntimeRestoreService: activation failed: ${e.message ?? String(e)}`],
            degradedComponents: componentResult.degradedComponents,
            restorePlan: rp,
          }
        }
      }

      return {
        status: componentResult.status,
        taskId: checkpoint.taskId,
        errors: [],
        degradedComponents: componentResult.degradedComponents,
        restorePlan: rp,
      }
    } finally {
      this.inFlight.delete(checkpointId)
    }
  }
}

/** Collect recovery plans from all restored WorkflowRuntimeCheckpointableComponent instances. */
function collectRecoveryPlans(coordinator: CheckpointRestoreCoordinator): import('./CheckpointTypes').WorkflowRecoveryPlan[] {
  const all: import('./CheckpointTypes').WorkflowRecoveryPlan[] = []
  for (const instance of coordinator.getRestoredComponents()) {
    if ('getRecoveryPlans' in instance && typeof (instance as any).getRecoveryPlans === 'function') {
      const plans = (instance as any).getRecoveryPlans() as import('./CheckpointTypes').WorkflowRecoveryPlan[]
      all.push(...plans)
    }
  }
  return all
}
