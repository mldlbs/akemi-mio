/**
 * MockCheckpointManager — 语义正确的 CheckpointManager 最小实现。
 *
 * 用于 contract tests 和 integration tests，验证接口设计是否能通过契约约束。
 * 用 real implementation 替代后，测试可继续复用。
 */

import type { Checkpoint, CheckpointId, ValidationResult, RestoreResult, StatefulComponent } from './CheckpointTypes'
import type { CheckpointManager } from './CheckpointManager'

let nextId = 0

export class MockCheckpointManager implements CheckpointManager {
  private store = new Map<CheckpointId, Checkpoint>()

  async create(context: any): Promise<Checkpoint> {
    const id = `cp_${++nextId}`
    return {
      id,
      taskId: context.taskId,
      schemaVersion: '1.0',
      runtimeCompatibility: { min: '2.0', max: '2.x' },
      taskState: {
        name: context.taskName,
        metadata: context.taskMetadata,
        createdAt: context.taskCreatedAt,
      },
      executionState: {
        workerId: context.executionState?.workerId ?? 'unknown',
        goal: context.executionState?.goal ?? 'unknown',
        step: context.executionState?.step ?? 0,
        lastSafePoint: context.executionState?.lastSafePoint ?? 'before_llm',
        conversationContext: { type: 'reference' as const, messageCount: 0, refId: '', tokenEstimate: 0 },
        pendingToolCalls: [],
      },
      createdAt: Date.now(),
    }
  }

  async save(checkpoint: Checkpoint): Promise<void> {
    this.store.set(checkpoint.id, structuredClone(checkpoint))
  }

  async load(id: CheckpointId): Promise<Checkpoint> {
    const cp = this.store.get(id)
    if (!cp) throw new Error(`checkpoint not found: ${id}`)
    return structuredClone(cp)
  }

  validate(checkpoint: Checkpoint): ValidationResult {
    const errors: string[] = []
    const warnings: string[] = []

    if (!checkpoint.schemaVersion) errors.push('schemaVersion is required')
    if (!checkpoint.runtimeCompatibility?.min) errors.push('runtimeCompatibility.min is required')
    if (!checkpoint.taskState?.name) errors.push('taskState.name is required')
    if (!checkpoint.executionState?.workerId) errors.push('executionState.workerId is required')
    if (!checkpoint.id) errors.push('id is required')

    return { ok: errors.length === 0, errors, warnings }
  }

  async restore(checkpoint: Checkpoint, components?: StatefulComponent[]): Promise<RestoreResult> {
    const validation = this.validate(checkpoint)
    if (!validation.ok) {
      return { status: 'failed', taskId: checkpoint.taskId, errors: validation.errors, degradedComponents: [] }
    }

    const degradedComponents: string[] = []
    if (components) {
      for (const comp of components) {
        try {
          const state = await comp.snapshot()
          await comp.restore(state)
        } catch {
          if ((comp as any).capabilities?.allowDegradedOnRestoreFail) {
            degradedComponents.push((comp as any).name ?? 'unknown')
          } else {
            return {
              status: 'failed',
              taskId: checkpoint.taskId,
              errors: [`component ${(comp as any).name ?? 'unknown'} restore failed`],
              degradedComponents: [],
            }
          }
        }
      }
    }

    return {
      status: degradedComponents.length > 0 ? 'degraded' : 'ok',
      taskId: checkpoint.taskId,
      errors: [],
      degradedComponents,
    }
  }

  clear(): void {
    this.store.clear()
    nextId = 0
  }
}
