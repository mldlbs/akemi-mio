/**
 * PlanOptimizerSnapshot — 快照与回滚管理器
 *
 * 在修改计划前创建快照，修改失败或用户拒绝时恢复。
 * 快照存储为 JSON 文件在 evolution_workspace/plan_optimizer/ 目录下。
 */

import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs'
import { log } from '../../logger/Logger'
import { WORKSPACE } from '../../config'
import type { DevPlan } from '../types'
import type { PlanOptimizerRollback } from './PlanOptimizerTypes'

// =============================================================================
// 配置
// =============================================================================

/** 快照存储目录 */
const SNAPSHOT_DIR = join(WORKSPACE.evolution, 'plan_optimizer', 'snapshots')

/** 快照最大保留数 */
const MAX_SNAPSHOTS = 20

/** 快照自动过期时间（7 天） */
const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000

// =============================================================================
// PlanOptimizerSnapshotManager
// =============================================================================

export class PlanOptimizerSnapshotManager {
  private snapshotDir: string

  constructor(snapshotDir?: string) {
    this.snapshotDir = snapshotDir || SNAPSHOT_DIR
    this.ensureDir()
  }

  private ensureDir(): void {
    if (!existsSync(this.snapshotDir)) {
      mkdirSync(this.snapshotDir, { recursive: true })
    }
  }

  /**
   * 创建当前所有活跃计划的快照。
   * 使用 planManager.listPlans() 的完整数据构建回滚点。
   */
  createSnapshot(plans: DevPlan[], action: string): PlanOptimizerRollback {
    this.ensureDir()
    this.pruneOldSnapshots()

    const id = `plan_opt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const snapshot = new Map<string, DevPlan>()
    for (const plan of plans) {
      snapshot.set(plan.id, JSON.parse(JSON.stringify(plan))) // deep clone
    }

    const rollback: PlanOptimizerRollback = {
      id,
      createdAt: Date.now(),
      snapshot,
      action,
      rolledBack: false,
    }

    // 持久化到 JSON 文件
    this.persistSnapshot(rollback)

    log('INFO', 'plan_optimizer_snapshot_created', {
      snapshotId: id,
      plans: plans.length,
      action,
    })

    return rollback
  }

  /**
   * 从快照恢复计划数据。
   * 返回每个计划在快照中的完整拷贝（deep clone）。
   */
  restoreSnapshot(rollback: PlanOptimizerRollback): Map<string, DevPlan> {
    const restored = new Map<string, DevPlan>()
    for (const [planId, plan] of rollback.snapshot) {
      restored.set(planId, JSON.parse(JSON.stringify(plan)))
    }

    log('INFO', 'plan_optimizer_snapshot_restored', {
      snapshotId: rollback.id,
      plans: restored.size,
    })

    return restored
  }

  /**
   * 标记快照为已回滚。
   */
  markRolledBack(rollback: PlanOptimizerRollback): void {
    rollback.rolledBack = true
    rollback.rolledBackAt = Date.now()
    this.persistSnapshot(rollback)
    log('INFO', 'plan_optimizer_rollback_marked', { snapshotId: rollback.id })
  }

  /**
   * 列出所有快照文件。
   */
  listSnapshots(): PlanOptimizerRollback[] {
    this.ensureDir()
    try {
      const files = readdirSync(this.snapshotDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse()

      const snapshots: PlanOptimizerRollback[] = []
      for (const file of files) {
        try {
          const raw = readFileSync(join(this.snapshotDir, file), 'utf-8')
          const parsed = JSON.parse(raw) as {
            id: string
            createdAt: number
            action: string
            rolledBack: boolean
            rolledBackAt?: number
            snapshot: Array<[string, DevPlan]>
          }
          // 反序列化 Map
          const snapshotMap = new Map<string, DevPlan>()
          for (const [key, value] of parsed.snapshot) {
            snapshotMap.set(key, value)
          }
          snapshots.push({
            id: parsed.id,
            createdAt: parsed.createdAt,
            snapshot: snapshotMap,
            action: parsed.action,
            rolledBack: parsed.rolledBack,
            rolledBackAt: parsed.rolledBackAt,
          })
        } catch (err) {
          log('WARN', 'plan_optimizer_snapshot_load_skipped', { file, error: String(err) })
        }
      }
      return snapshots
    } catch (err) {
      log('ERROR', 'plan_optimizer_snapshot_list_error', { error: String(err) })
      return []
    }
  }

  /** 通过 ID 查找快照 */
  findSnapshot(id: string): PlanOptimizerRollback | undefined {
    return this.listSnapshots().find((s) => s.id === id)
  }

  // ==================== 内部方法 ====================

  private persistSnapshot(rollback: PlanOptimizerRollback): void {
    try {
      // 将 Map 序列化为数组
      const data = {
        id: rollback.id,
        createdAt: rollback.createdAt,
        action: rollback.action,
        rolledBack: rollback.rolledBack,
        rolledBackAt: rollback.rolledBackAt,
        snapshot: Array.from(rollback.snapshot.entries()),
      }
      const filePath = join(this.snapshotDir, `${rollback.id}.json`)
      writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
    } catch (err) {
      log('ERROR', 'plan_optimizer_snapshot_persist_error', {
        snapshotId: rollback.id,
        error: String(err),
      })
    }
  }

  /** 清理过期和超量快照 */
  private pruneOldSnapshots(): void {
    try {
      if (!existsSync(this.snapshotDir)) return

      const files = readdirSync(this.snapshotDir)
        .filter((f) => f.endsWith('.json'))
        .sort() // 最早的在前

      const now = Date.now()
      let removed = 0

      // 过期清理
      for (const file of files) {
        try {
          const raw = readFileSync(join(this.snapshotDir, file), 'utf-8')
          const parsed = JSON.parse(raw)
          if (now - parsed.createdAt > SNAPSHOT_TTL_MS) {
            unlinkSync(join(this.snapshotDir, file))
            removed++
          }
        } catch {
          // 无法解析的文件视为过期
          try {
            unlinkSync(join(this.snapshotDir, file))
            removed++
          } catch { /* ignore */ }
        }
      }

      // 超量清理（保留最新的 MAX_SNAPSHOTS 个）
      const remaining = readdirSync(this.snapshotDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
      while (remaining.length > MAX_SNAPSHOTS) {
        const oldest = remaining.shift()
        if (oldest) {
          try {
            unlinkSync(join(this.snapshotDir, oldest))
            removed++
          } catch { /* ignore */ }
        }
      }

      if (removed > 0) {
        log('INFO', 'plan_optimizer_snapshot_pruned', { removed })
      }
    } catch (err) {
      log('WARN', 'plan_optimizer_snapshot_prune_error', { error: String(err) })
    }
  }
}

/** 全局单例 */
export const planOptimizerSnapshotManager = new PlanOptimizerSnapshotManager()
