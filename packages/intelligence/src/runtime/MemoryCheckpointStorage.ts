/**
 * MemoryCheckpointStorage — 基于 Map 的内存级 CheckpointStorage 实现。
 *
 * 用于：
 * 1. CheckpointManager 单元测试（不依赖文件系统）
 * 2. Runtime checkpoint 集成验证的初始阶段
 *
 * 不适用于生产持久化。
 */

import type { Checkpoint, CheckpointId } from './CheckpointTypes'
import type { CheckpointStorage } from './CheckpointStorage'

export class MemoryCheckpointStorage implements CheckpointStorage {
  private store = new Map<CheckpointId, Checkpoint>()
  private taskIndex = new Map<string, CheckpointId[]>()

  async save(checkpoint: Checkpoint): Promise<void> {
    this.store.set(checkpoint.id, structuredClone(checkpoint))

    const ids = this.taskIndex.get(checkpoint.taskId) ?? []
    if (!ids.includes(checkpoint.id)) {
      ids.push(checkpoint.id)
      this.taskIndex.set(checkpoint.taskId, ids)
    }
  }

  async load(id: CheckpointId): Promise<Checkpoint> {
    const cp = this.store.get(id)
    if (!cp) throw new Error(`checkpoint not found: ${id}`)
    return structuredClone(cp)
  }

  async list(taskId: string): Promise<CheckpointId[]> {
    return this.taskIndex.get(taskId) ?? []
  }

  async delete(id: CheckpointId): Promise<void> {
    const cp = this.store.get(id)
    if (cp) {
      this.store.delete(id)
      const ids = this.taskIndex.get(cp.taskId)
      if (ids) {
        this.taskIndex.set(
          cp.taskId,
          ids.filter((i) => i !== id),
        )
      }
    }
  }

  // ── 测试辅助 ──

  clear(): void {
    this.store.clear()
    this.taskIndex.clear()
  }

  count(): number {
    return this.store.size
  }
}
