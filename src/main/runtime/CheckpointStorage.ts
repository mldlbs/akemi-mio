/**
 * CheckpointStorage — 检查点持久化抽象。
 *
 * 独立于 CheckpointManager，使存储实现可替换。
 * CheckpointManager 依赖此接口，不直接操作文件或数据库。
 */

import type { Checkpoint, CheckpointId } from './CheckpointTypes'

export interface CheckpointStorage {
  /** 保存 checkpoint。如果已存在相同 id，覆盖。 */
  save(checkpoint: Checkpoint): Promise<void>

  /** 按 ID 加载。不存在时抛出错误。 */
  load(id: CheckpointId): Promise<Checkpoint>

  /** 按 taskId 列出所有 checkpoint。返回空数组如果不存。 */
  list(taskId: string): Promise<CheckpointId[]>

  /** 删除指定 checkpoint。静默忽略不存在。 */
  delete(id: CheckpointId): Promise<void>
}
