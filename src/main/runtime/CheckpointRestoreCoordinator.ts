/**
 * CheckpointRestoreCoordinator — restore orchestration for CheckpointableComponent.
 *
 * Scope: pure component restore orchestration.
 * NOT responsible for: RuntimeTask creation, lifecycle, AgentService wiring.
 *
 * Strategy (phase 1): fail-fast — any component restore failure aborts the restore.
 * see docs/runtime-restore-architecture.md §4
 */

import type { Checkpoint, ComponentDescriptor, CheckpointableComponent, RestoreResult, VersionedState } from './CheckpointTypes'
import type { ComponentRegistry } from './ComponentRegistry'

export interface CheckpointRestoreCoordinator {
  restore(checkpoint: Checkpoint): Promise<RestoreResult>
  /** 返回本次 restore 中成功恢复的 component 实例 */
  getRestoredComponents(): CheckpointableComponent[]
}

export class CheckpointRestoreCoordinatorImpl implements CheckpointRestoreCoordinator {
  private restoredInstances: CheckpointableComponent[] = []

  constructor(private registry: ComponentRegistry) {}

  getRestoredComponents(): CheckpointableComponent[] {
    return [...this.restoredInstances]
  }

  async restore(checkpoint: Checkpoint): Promise<RestoreResult> {
    this.restoredInstances = []
    const errors: string[] = []
    const degradedComponents: string[] = []

    const entries = checkpoint.componentStates
      ? Object.entries(checkpoint.componentStates)
      : []

    for (const [componentId, state] of entries) {
      // 1. resolve descriptor
      const descriptor = this.registry.resolve(componentId)
      if (!descriptor) {
        errors.push(`CheckpointRestoreCoordinator: descriptor not found for '${componentId}'`)
        return { status: 'failed', taskId: checkpoint.taskId, errors, degradedComponents }
      }

      // 2. create component instance (isolated per restore)
      let component: CheckpointableComponent
      try {
        component = descriptor.create()
      } catch (e: any) {
        errors.push(`CheckpointRestoreCoordinator: create failed for '${componentId}': ${e.message ?? String(e)}`)
        return { status: 'failed', taskId: checkpoint.taskId, errors, degradedComponents }
      }

      // 3. restore
      try {
        await component.restore(state)
        this.restoredInstances.push(component)
      } catch (e: any) {
        errors.push(`CheckpointRestoreCoordinator: restore failed for '${componentId}': ${e.message ?? String(e)}`)
        return { status: 'failed', taskId: checkpoint.taskId, errors, degradedComponents }
      }
    }

    return {
      status: 'ok',
      taskId: checkpoint.taskId,
      errors: [],
      degradedComponents: [],
    }
  }
}
