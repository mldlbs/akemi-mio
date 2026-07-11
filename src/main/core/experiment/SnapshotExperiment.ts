/**
 * SnapshotExperiment — 通用快照实验框架
 *
 * 核心抽象：在变更前拍下基线快照 → 执行变更 → 评估效果 → 决定保留/回滚。
 * 替代各模块中重复的 createSnapshot → evaluateSnapshot → evaluateAndDecide 模式。
 *
 * 用法：
 *   const manager = new SnapshotManager({
 *     comparator: (before, after) => {
 *       if (after.score - before.score > 0.05) return 'improved'
 *       if (before.score - after.score > 0.05) return 'worsened'
 *       return 'unchanged'
 *     },
 *   })
 *   const snap = manager.createSnapshot({ score: 0.5 })
 *   // ... apply change externally ...
 *   const result = manager.evaluate(snap.id, { score: 0.7 })
 *   // result.verdict === 'improved', result.action === 'keep'
 *
 * 设计原则：
 * - 无偏见：比较器由调用方注入，框架只负责生命周期
 * - 可观测：每次评估记录前后数据、判定结果、动作
 * - 可配置：最大快照数、评估窗口等可调
 *
 * 来源分析（PiperTTS + Plan:TypeScript）：
 * - TtsExperimentHook — 参数随机化实验，A/B 分组，前后对比
 * - LearningProgressTracker — 掌握度快照 + 策略评估 + keep/rollback
 */
import { log } from '../../logger/Logger'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 快照状态 */
export type SnapshotStatus = 'pending' | 'kept' | 'rolled_back'

/** 评估判定 */
export type EvaluationVerdict = 'improved' | 'worsened' | 'unchanged' | 'not_found'

/** 建议动作 */
export type EvaluationAction = 'keep' | 'rollback' | 'no_action'

/** 单次基线快照 */
export interface Snapshot<TBaseline = unknown> {
  /** 唯一标识 */
  id: string
  /** 创建时间戳 */
  timestamp: number
  /** 基线数据（变更前的状态） */
  baseline: TBaseline
  /** 变更后数据（评估时回填） */
  after?: TBaseline
  /** 快照状态 */
  status: SnapshotStatus
  /** 关联的变更描述列表 */
  appliedChanges: string[]
  /** 评估判定（评估后回填） */
  verdict?: EvaluationVerdict
  /** 自定义标签 */
  tags?: string[]
}

/** 评估配置 */
export interface SnapshotEvaluatorOptions<TBaseline> {
  /**
   * 比较函数：输入变更前后的数据，返回判定结果。
   * 调用方注入领域特定的比较逻辑。
   */
  comparator: (before: TBaseline, after: TBaseline) => EvaluationVerdict

  /** 日志分类名前缀 */
  loggerName?: string

  /** 最大快照保留数（默认 50） */
  maxSnapshots?: number

  /** 最小样本数，低于此值视为 'unchanged'（默认 0） */
  minSamples?: number
}

/** 评估结果 */
export interface EvaluationResult<TBaseline = unknown> {
  /** 快照 ID */
  snapshotId: string
  /** 评估判定 */
  verdict: EvaluationVerdict
  /** 建议动作 */
  action: EvaluationAction
  /** 基线数据 */
  baseline: TBaseline
  /** 当前数据 */
  current: TBaseline
  /** 评估时间戳 */
  timestamp: number
}

/** 实验组（用于 A/B 测试场景） */
export interface ExperimentGroup<TBaseline = unknown> {
  /** 实验组 ID */
  id: string
  /** 实验组创建时间 */
  createdAt: number
  /** 组内所有快照 */
  snapshots: Snapshot<TBaseline>[]
  /** 组标签 */
  label?: string
  /** 实验参数描述 */
  description?: string
}

// ══════════════════════════════════════════
//  默认配置
// ══════════════════════════════════════════

const DEFAULT_MAX_SNAPSHOTS = 50

// ══════════════════════════════════════════
//  SnapshotManager
// ══════════════════════════════════════════

export class SnapshotManager<TBaseline = unknown> {
  private readonly snapshots: Snapshot<TBaseline>[] = []
  private readonly evaluatorOptions: SnapshotEvaluatorOptions<TBaseline>
  private readonly loggerName: string
  private readonly maxSnapshots: number

  /** 实验组管理 */
  private readonly experimentGroups = new Map<string, ExperimentGroup<TBaseline>>()
  private currentGroupId: string | null = null

  constructor(options: SnapshotEvaluatorOptions<TBaseline>) {
    this.evaluatorOptions = options
    this.loggerName = options.loggerName ?? 'snapshot_experiment'
    this.maxSnapshots = options.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS
  }

  // ════════════════════════════════════════
  //  快照管理
  // ════════════════════════════════════════

  /**
   * 创建基线快照。
   * 在变更发生前调用，记录当前状态。
   *
   * @param currentData 当前基线数据
   * @param changes 关联的变更描述（可选）
   * @param tags 自定义标签（可选）
   * @returns 创建的快照
   */
  createSnapshot(
    currentData: TBaseline,
    changes?: string[],
    tags?: string[],
  ): Snapshot<TBaseline> {
    const snapshot: Snapshot<TBaseline> = {
      id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      baseline: this.cloneData(currentData),
      status: 'pending',
      appliedChanges: changes ?? [],
      tags,
    }

    this.snapshots.push(snapshot)

    // 限制快照数
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.splice(0, this.snapshots.length - this.maxSnapshots)
    }

    // 关联到当前实验组（如果有）
    if (this.currentGroupId) {
      const group = this.experimentGroups.get(this.currentGroupId)
      if (group) {
        group.snapshots.push(snapshot)
      }
    }

    log('INFO', `${this.loggerName}_snapshot_created`, {
      snapshotId: snapshot.id,
      changes: changes?.length ?? 0,
      totalSnapshots: this.snapshots.length,
    })

    return snapshot
  }

  /**
   * 评估快照：对比当前数据与快照基线。
   *
   * @param snapshotId 快照 ID
   * @param currentData 当前数据
   * @returns 评估结果，如果快照不存在返回 verdict='not_found'
   */
  evaluate(snapshotId: string, currentData: TBaseline): EvaluationResult<TBaseline> {
    const snapshot = this.snapshots.find((s) => s.id === snapshotId)
    if (!snapshot) {
      return {
        snapshotId,
        verdict: 'not_found',
        action: 'no_action',
        baseline: null as unknown as TBaseline,
        current: currentData,
        timestamp: Date.now(),
      }
    }

    // 回填变更后数据
    snapshot.after = this.cloneData(currentData)

    const verdict = this.evaluateSnapshot(snapshot, currentData)
    snapshot.verdict = verdict

    const action = this.verdictToAction(verdict)
    if (action === 'keep') {
      snapshot.status = 'kept'
    } else if (action === 'rollback') {
      snapshot.status = 'rolled_back'
    }

    log('INFO', `${this.loggerName}_evaluated`, {
      snapshotId,
      verdict,
      action,
      changes: snapshot.appliedChanges.length,
    })

    return {
      snapshotId,
      verdict,
      action,
      baseline: snapshot.baseline,
      current: currentData,
      timestamp: Date.now(),
    }
  }

  /**
   * 评估快照并决定保留/回滚。
   * 相当于 evaluate() + 自动更新快照状态的便捷方法。
   *
   * @param snapshotId 快照 ID（可选，未指定时评估最近的一个 pending 快照）
   * @param currentData 当前数据（可选，未指定时使用快照的 after 数据或基线数据）
   * @returns 评估结果
   */
  evaluateAndDecide(
    snapshotId?: string,
    currentData?: TBaseline,
  ): EvaluationResult<TBaseline> {
    const targetId = snapshotId ?? this.findPendingSnapshotId()
    if (!targetId) {
      return {
        snapshotId: 'none',
        verdict: 'not_found',
        action: 'no_action',
        baseline: null as unknown as TBaseline,
        current: currentData as unknown as TBaseline,
        timestamp: Date.now(),
      }
    }

    const snapshot = this.snapshots.find((s) => s.id === targetId)
    if (!snapshot) {
      return {
        snapshotId: targetId,
        verdict: 'not_found',
        action: 'no_action',
        baseline: null as unknown as TBaseline,
        current: currentData as unknown as TBaseline,
        timestamp: Date.now(),
      }
    }

    const data = currentData !== undefined ? currentData : snapshot.after ?? snapshot.baseline
    return this.evaluate(targetId, data)
  }

  // ════════════════════════════════════════
  //  实验组管理（可选，用于 A/B 分组）
  // ════════════════════════════════════════

  /**
   * 创建新的实验组。后续的 createSnapshot 自动关联到此组。
   */
  startExperimentGroup(label?: string, description?: string): string {
    const groupId = `exp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    this.experimentGroups.set(groupId, {
      id: groupId,
      createdAt: Date.now(),
      snapshots: [],
      label,
      description,
    })
    this.currentGroupId = groupId

    log('INFO', `${this.loggerName}_group_started`, {
      groupId,
      label,
    })

    return groupId
  }

  /** 获取当前实验组 ID */
  getCurrentGroupId(): string | null {
    return this.currentGroupId
  }

  /**
   * 获取指定实验组的所有快照。
   */
  getGroupSnapshots(groupId: string): Snapshot<TBaseline>[] {
    const group = this.experimentGroups.get(groupId)
    return group ? [...group.snapshots] : []
  }

  /**
   * 获取所有实验组。
   */
  getExperimentGroups(): Map<string, ExperimentGroup<TBaseline>> {
    return new Map(this.experimentGroups)
  }

  // ════════════════════════════════════════
  //  查询接口
  // ════════════════════════════════════════

  /** 获取所有快照 */
  getSnapshots(): Snapshot<TBaseline>[] {
    return [...this.snapshots]
  }

  /** 获取指定 ID 的快照 */
  getSnapshot(id: string): Snapshot<TBaseline> | undefined {
    return this.snapshots.find((s) => s.id === id)
  }

  /** 获取所有待评估的快照 */
  getPendingSnapshots(): Snapshot<TBaseline>[] {
    return this.snapshots.filter((s) => s.status === 'pending')
  }

  /** 手动更新快照状态 */
  updateSnapshotStatus(snapshotId: string, status: SnapshotStatus): boolean {
    const snapshot = this.snapshots.find((s) => s.id === snapshotId)
    if (!snapshot) return false
    snapshot.status = status
    return true
  }

  /** 获取快照总数 */
  getCount(): number {
    return this.snapshots.length
  }

  /** 清理过期快照 */
  prune(maxAgeDays = 30): number {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    const before = this.snapshots.length
    const remaining = this.snapshots.filter((s) => s.timestamp >= cutoff)
    this.snapshots.length = 0
    this.snapshots.push(...remaining)
    return before - remaining
  }

  /**
   * 从持久化数据恢复快照。
   * 用于启动时加载之前持久化的快照。
   *
   * @param snapshots 要恢复的快照列表（必须在创建新快照之前调用）
   */
  restoreSnapshots(snapshots: Array<Snapshot<TBaseline>>): void {
    if (this.snapshots.length > 0) {
      log('WARN', `${this.loggerName}_restore_after_init`, {
        existing: this.snapshots.length,
        restoring: snapshots.length,
      })
    }
    for (const snap of snapshots) {
      this.snapshots.push({ ...snap, baseline: this.cloneData(snap.baseline) })
    }
    log('INFO', `${this.loggerName}_restored`, { count: snapshots.length })
  }

  /** 重置所有数据 */
  reset(): void {
    this.snapshots.length = 0
    this.experimentGroups.clear()
    this.currentGroupId = null
  }

  // ════════════════════════════════════════
  //  内部方法
  // ════════════════════════════════════════

  /**
   * 执行实际的比较逻辑。
   * 检查样本数要求后，委托给注入的 comparator。
   */
  private evaluateSnapshot(snapshot: Snapshot<TBaseline>, current: TBaseline): EvaluationVerdict {
    // 样本数不足 → 无法判断
    if (this.evaluatorOptions.minSamples && this.snapshots.length < this.evaluatorOptions.minSamples) {
      return 'unchanged'
    }

    return this.evaluatorOptions.comparator(snapshot.baseline, current)
  }

  /**
   * 将判定结果映射为建议动作。
   */
  private verdictToAction(verdict: EvaluationVerdict): EvaluationAction {
    switch (verdict) {
      case 'improved':
        return 'keep'
      case 'worsened':
        return 'rollback'
      case 'unchanged':
        return 'no_action'
      case 'not_found':
        return 'no_action'
    }
  }

  /**
   * 找到最近一个 pending 状态的快照 ID。
   */
  private findPendingSnapshotId(): string | null {
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      if (this.snapshots[i].status === 'pending') {
        return this.snapshots[i].id
      }
    }
    return null
  }

  /**
   * 克隆基线数据（浅拷贝 + 结构化克隆兜底）。
   * 确保快照不被外部变更影响。
   */
  private cloneData(data: TBaseline): TBaseline {
    if (data === null || data === undefined) return data
    if (typeof data === 'object') {
      try {
        return JSON.parse(JSON.stringify(data))
      } catch {
        return { ...data } as unknown as TBaseline
      }
    }
    return data
  }
}

// ══════════════════════════════════════════
//  便捷工厂
// ══════════════════════════════════════════

/**
 * 创建数值型的 SnapshotManager（最常见的场景：比较单个数值的变化）。
 *
 * 示例：
 *   const manager = createNumericSnapshotManager({
 *     minDelta: 0.05,
 *     label: 'mastery_tracker',
 *     minSamples: 3,
 *   })
 *
 *   manager.createSnapshot({ score: 0.5 })
 *   const result = manager.evaluate('...', { score: 0.55 })
 *   // result.verdict === 'unchanged' (change 0.05 <= minDelta 0.05)
 */
export function createNumericSnapshotManager(options?: {
  /** 最小变化阈值，低于此值视为 unchanged（默认 0.05） */
  minDelta?: number
  /** 日志分类名 */
  label?: string
  /** 最小样本数默认值 */
  minSamples?: number
  /** 最大快照数 */
  maxSnapshots?: number
}): SnapshotManager<{ value: number }> {
  const minDelta = options?.minDelta ?? 0.05

  return new SnapshotManager<{ value: number }>({
    comparator: (before, after) => {
      const diff = after.value - before.value
      if (diff > minDelta) return 'improved'
      if (diff < -minDelta) return 'worsened'
      return 'unchanged'
    },
    loggerName: options?.label,
    minSamples: options?.minSamples,
    maxSnapshots: options?.maxSnapshots,
  })
}
