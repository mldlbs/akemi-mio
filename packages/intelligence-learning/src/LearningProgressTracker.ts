/**
 * LearningProgressTracker — 学习进度追踪器
 *
 * 从 ASR AsrEvolutionManager + AsrLogStore 中提取的核心循环：
 *
 * AsrEvolutionManager 对应：
 * 1. applyPatches() → applyLearningStrategy() — 应用学习策略变更
 * 2. evaluateAndDecide() → evaluateProgress() — 评估效果决定 keep/rollback
 * 3. deduplicatePatches() → 策略去重
 * 4. rollbackSnapshot() → 回滚策略变更
 *
 * AsrLogStore 对应：
 * 1. recordRecognition() → recordDifficulty() — 记录学习困难
 * 2. getErrorPatterns() → getDifficultyPatterns() — 获取难点模式
 * 3. createEvalSnapshot() → createSnapshot() — 创建进度快照
 * 4. evaluateSnapshot() → evaluateSnapshot() — 前后对比评估
 * 5. getCorrectionRate() → getAccuracyRate() — 获取正确率
 *
 * 重构说明：
 * - 快照基线管理委托给 SnapshotExperiment（core/experiment），
 *   消除重复的 createSnapshot → evaluate → keep/rollback 模式
 * - 保留领域特有的困难追踪和持久化逻辑
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { WORKSPACE } from '@akemi-mio/core/config'
import { join } from 'path'
import { JsonStore } from '@akemi-mio/core/core/persistence/JsonStore'
import { SnapshotManager } from '@akemi-mio/core/core/experiment/SnapshotExperiment'
import type {
  LearningItem,
  LearningDifficulty,
  DifficultyCategory,
  LearningEvalSnapshot,
  LearningCategory,
  LearningProgress,
} from './types'

// ── 持久化存储 ──

const DIFFICULTIES_STORE = new JsonStore<LearningDifficulty>(join(WORKSPACE.cache, 'learning-difficulties.json'), {
  loggerName: 'learning_difficulties',
})
const SNAPSHOTS_STORE = new JsonStore<LearningEvalSnapshot>(join(WORKSPACE.cache, 'learning-eval-snapshots.json'), {
  loggerName: 'learning_snapshots',
})

/** 保留最近 N 条难点记录 */
const MAX_DIFFICULTIES = 500
/** 保留最近 N 个评估快照 */
const MAX_SNAPSHOTS = 50
/** 评估回溯窗口（毫秒）*/
const DEFAULT_LOOKBACK_MS = 2 * 60 * 60 * 1000 // 2h

// ── 策略变更类型 ──

export type LearningStrategyType =
  | 'focus_shift' // 调整关注领域
  | 'difficulty_change' // 调整内容难度
  | 'review_boost' // 加大复习密度
  | 'concept_add' // 新增知识点
  | 'pace_adjust' // 调整学习节奏

export interface LearningStrategyChange {
  type: LearningStrategyType
  description: string
  params: Record<string, unknown>
}

/** 快照基线数据类型 */
export interface LearningBaselineData {
  mastery: number
  accuracy: number
}

// ── LearningProgressTracker ──

export class LearningProgressTracker {
  private difficulties: LearningDifficulty[] = []
  /** 持久化快照存储（与 SnapshotManager 同步） */
  private persistedSnapshots: LearningEvalSnapshot[] = []
  private changeLog: Array<{
    strategy: LearningStrategyChange
    snapshotId: string
    timestamp: number
    outcome?: 'improved' | 'worsened' | 'unchanged'
  }> = []
  private loaded = false

  /** 外部注入的知识点查询函数 */
  private getItemsFn: (() => LearningItem[]) | null = null

  /**
   * 快照基线管理 — 委托给 SnapshotExperiment（core/experiment）。
   * 处理从创建基线到评估判定（keep/rollback）的完整生命周期。
   */
  private readonly snapshotManager = new SnapshotManager<LearningBaselineData>({
    comparator: (before, after) => {
      const masteryChange = after.mastery - before.mastery
      const accuracyChange = after.accuracy - before.accuracy

      // 掌握度提升 > 5% 或 正确率提升 > 10% → 改进
      if (masteryChange > 0.05 || accuracyChange > 0.1) return 'improved'
      // 掌握度下降 > 5% 或 正确率下降 > 10% → 恶化
      if (masteryChange < -0.05 || accuracyChange < -0.1) return 'worsened'
      return 'unchanged'
    },
    loggerName: 'learning_tracker',
    maxSnapshots: MAX_SNAPSHOTS,
    minSamples: 3,
  })

  /**
   * 设置知识点查询回调（注入 LearningVocabularyManager 的查询能力）。
   */
  setGetItemsFn(fn: () => LearningItem[]): void {
    this.getItemsFn = fn
  }

  // ==================== 初始化 ====================

  load(): void {
    if (this.loaded) return
    this.difficulties = DIFFICULTIES_STORE.load()

    // 从持久化存储恢复快照到 SnapshotManager
    this.persistedSnapshots = SNAPSHOTS_STORE.load()
    const restored = this.persistedSnapshots.map((p) => ({
      id: p.id,
      timestamp: p.timestamp,
      baseline: { mastery: p.beforeMastery, accuracy: p.beforeAccuracy },
      after: p.afterMastery !== undefined ? { mastery: p.afterMastery, accuracy: p.afterAccuracy ?? p.beforeAccuracy } : undefined,
      status: p.status as 'pending' | 'kept' | 'rolled_back',
      appliedChanges: p.appliedChanges,
      verdict: undefined,
    }))
    this.snapshotManager.restoreSnapshots(restored)

    this.loaded = true
    log('INFO', 'learning_tracker_loaded', {
      difficulties: this.difficulties.length,
      snapshots: this.persistedSnapshots.length,
    })
  }

  // ==================== 快照持久化 ====================

  /**
   * 将 SnapshotManager 的快照同步到持久化存储。
   */
  private persistSnapshots(): void {
    const coreSnapshots = this.snapshotManager.getSnapshots()
    this.persistedSnapshots = coreSnapshots.map((s) => ({
      id: s.id,
      timestamp: s.timestamp,
      beforeMastery: s.baseline.mastery,
      beforeAccuracy: s.baseline.accuracy,
      afterMastery: s.after?.mastery,
      afterAccuracy: s.after?.accuracy,
      appliedChanges: s.appliedChanges,
      status: s.status,
    }))
    SNAPSHOTS_STORE.save(this.persistedSnapshots)
  }

  // ==================== 困难记录（对应 AsrLogStore 的纠正记录） ====================

  /**
   * 记录一次学习困难（练习做错/概念不理解）。
   * 对应 AsrLogStore.recordCorrection()。
   */
  recordDifficulty(conceptId: string, conceptName: string, description: string, category?: DifficultyCategory): void {
    this.load()
    this.difficulties.push({
      conceptId,
      conceptName,
      description,
      category: category || this.classifyDifficulty(description),
      frequency: 1,
      lastSeen: Date.now(),
    })
    // 合并相同知识点+描述的记录
    this.mergeDifficulties()
    if (this.difficulties.length > MAX_DIFFICULTIES) {
      this.difficulties = this.difficulties.slice(-MAX_DIFFICULTIES)
    }
    DIFFICULTIES_STORE.save(this.difficulties)
  }

  /**
   * 获取高频难点模式（用于自适应调整学习策略）。
   * 对应 AsrLogStore.getErrorPatterns()。
   */
  getDifficultyPatterns(since?: number): LearningDifficulty[] {
    this.load()
    const relevant = since ? this.difficulties.filter((d) => d.lastSeen >= since) : this.difficulties

    // 聚类合并：按 (conceptId + category) 汇总频次
    const clusterMap = new Map<string, LearningDifficulty>()
    for (const d of relevant) {
      const key = `${d.conceptId}:${d.category}`
      const existing = clusterMap.get(key)
      if (existing) {
        existing.frequency++
        existing.lastSeen = Math.max(existing.lastSeen, d.lastSeen)
      } else {
        clusterMap.set(key, { ...d })
      }
    }

    return Array.from(clusterMap.values()).sort((a, b) => b.frequency - a.frequency)
  }

  /**
   * 获取学习正确率（对应 AsrLogStore.getCorrectionRate()）。
   */
  getAccuracyRate(since?: number): { rate: number; difficulties: number; totalItems: number } {
    this.load()
    const relevant = since ? this.difficulties.filter((d) => d.lastSeen >= since) : this.difficulties

    const items = this.getItemsFn?.() || []
    const totalItems = items.length
    const difficulties = relevant.length

    return {
      rate: totalItems > 0 ? Math.max(0, 1 - difficulties / Math.max(totalItems, 1)) : 1,
      difficulties,
      totalItems,
    }
  }

  // ==================== 获取当前基线数据 ====================

  /**
   * 从 LearningVocabularyManager 获取当前掌握度和正确率。
   */
  private getCurrentBaselineData(): LearningBaselineData {
    const items = this.getItemsFn?.() || []
    const totalMastery = items.length > 0 ? items.reduce((s, i) => s + i.mastery, 0) / items.length : 0
    const totalAttempts = items.reduce((s, i) => s + i.totalAttempts, 0)
    const totalCorrect = items.reduce((s, i) => s + i.correctCount, 0)
    const accuracy = totalAttempts > 0 ? totalCorrect / totalAttempts : 0

    return {
      mastery: Math.round(totalMastery * 100) / 100,
      accuracy: Math.round(accuracy * 100) / 100,
    }
  }

  // ==================== 评估快照（对应 AsrLogStore/AsrEvolutionManager 的快照机制） ====================

  /**
   * 创建进度评估快照（策略变更前拍下基线）。
   * 委托给 SnapshotManager，同时持久化到 JsonStore。
   * 对应 AsrLogStore.createEvalSnapshot()。
   */
  createSnapshot(appliedChanges: string[], _lookbackMs = DEFAULT_LOOKBACK_MS): LearningEvalSnapshot {
    this.load()
    const data = this.getCurrentBaselineData()
    const coreSnap = this.snapshotManager.createSnapshot(data, appliedChanges)

    this.persistSnapshots()

    // 转换为 LearningEvalSnapshot 保持对外接口兼容
    return {
      id: coreSnap.id,
      timestamp: coreSnap.timestamp,
      beforeMastery: data.mastery,
      beforeAccuracy: data.accuracy,
      appliedChanges,
      status: 'pending',
    }
  }

  /**
   * 评估快照：对比当前进度与快照基线。
   * 委托给 SnapshotManager 的 comparator。
   * 对应 AsrLogStore.evaluateSnapshot()。
   */
  evaluateSnapshot(snapshotId: string): 'improved' | 'worsened' | 'unchanged' | 'not_found' {
    this.load()
    const data = this.getCurrentBaselineData()
    const result = this.snapshotManager.evaluate(snapshotId, data)

    if (result.verdict === 'not_found') return 'not_found'

    this.persistSnapshots()
    return result.verdict
  }

  /**
   * 标记快照为保留或回滚。
   * 委托给 SnapshotManager。
   */
  updateSnapshotStatus(snapshotId: string, status: 'kept' | 'rolled_back'): boolean {
    const ok = this.snapshotManager.updateSnapshotStatus(snapshotId, status)
    if (ok) this.persistSnapshots()
    return ok
  }

  /**
   * 获取待评估的快照。
   */
  getPendingSnapshots(): LearningEvalSnapshot[] {
    this.load()
    const pending = this.snapshotManager.getPendingSnapshots()
    return pending.map((s) => this.toEvalSnapshot(s))
  }

  /**
   * 获取所有快照。
   */
  getSnapshots(): LearningEvalSnapshot[] {
    this.load()
    return this.snapshotManager.getSnapshots().map((s) => this.toEvalSnapshot(s))
  }

  /**
   * 将 SnapshotManager 的快照转换为外部 LearningEvalSnapshot 格式。
   */
  private toEvalSnapshot(s: {
    id: string
    timestamp: number
    baseline: LearningBaselineData
    after?: LearningBaselineData
    status: string
    appliedChanges: string[]
  }): LearningEvalSnapshot {
    return {
      id: s.id,
      timestamp: s.timestamp,
      beforeMastery: s.baseline.mastery,
      beforeAccuracy: s.baseline.accuracy,
      afterMastery: s.after?.mastery,
      afterAccuracy: s.after?.accuracy,
      appliedChanges: s.appliedChanges,
      status: s.status as LearningEvalSnapshot['status'],
    }
  }

  // ==================== 策略变更（对应 AsrEvolutionManager.applyPatches） ====================

  /**
   * 应用一次学习策略变更。
   * 对应 AsrEvolutionManager.applyPatches()。
   *
   * 流程：创建基线快照 → 应用策略 → 记录变更日志
   *
   * @returns 变更日志条目（含 snapshotId 用于后续评估）
   */
  applyLearningStrategy(strategy: LearningStrategyChange): { snapshotId: string } | null {
    this.load()

    // 创建评估快照
    const snapshot = this.createSnapshot([strategy.description])

    // 记录变更日志
    this.changeLog.push({
      strategy,
      snapshotId: snapshot.id,
      timestamp: Date.now(),
    })

    log('INFO', 'learning_strategy_applied', {
      type: strategy.type,
      description: strategy.description,
      snapshotId: snapshot.id,
    })

    return { snapshotId: snapshot.id }
  }

  /**
   * 评估上一次策略变更的效果并决定保留还是回滚。
   * 委托给 SnapshotManager 的 evaluateAndDecide。
   * 对应 AsrEvolutionManager.evaluateAndDecide()。
   */
  evaluateAndDecide(snapshotId?: string): {
    verdict: 'improved' | 'worsened' | 'unchanged' | 'not_found'
    action: 'keep' | 'rollback' | 'no_action'
  } {
    this.load()
    const data = this.getCurrentBaselineData()
    const result = this.snapshotManager.evaluateAndDecide(snapshotId, data)

    this.persistSnapshots()

    // 更新变更日志
    if (result.verdict !== 'not_found') {
      const logEntry = this.changeLog.find((c) => c.snapshotId === result.snapshotId)
      if (logEntry) {
        logEntry.outcome = result.verdict
      }
    }

    log('INFO', 'learning_strategy_evaluated', {
      snapshotId: result.snapshotId,
      verdict: result.verdict,
      action: result.action,
    })

    return {
      verdict: result.verdict,
      action: result.action,
    }
  }

  // ==================== 内部方法 ====================

  /**
   * 合并相同知识点+描述的困难记录（去重 + 累加频次）。
   */
  private mergeDifficulties(): void {
    const merged = new Map<string, LearningDifficulty>()
    for (const d of this.difficulties) {
      const key = `${d.conceptId}|${d.description}`
      const existing = merged.get(key)
      if (existing) {
        existing.frequency++
        existing.lastSeen = Math.max(existing.lastSeen, d.lastSeen)
      } else {
        merged.set(key, { ...d })
      }
    }
    this.difficulties = Array.from(merged.values()).sort((a, b) => b.frequency - a.frequency)
  }

  /**
   * 根据描述内容自动分类困难类型。
   * 对应 AsrLogStore.classifyErrorPattern()。
   */
  private classifyDifficulty(description: string): DifficultyCategory {
    const lower = description.toLowerCase()
    if (/type.*mismatch|不匹配|类型错误/.test(lower)) return 'type_mismatch'
    if (/syntax|语法/.test(lower)) return 'syntax_error'
    if (/generic.*constraint|extends.*bound|约束/.test(lower)) return 'generic_bound'
    if (/conditional|条件.*逻辑/.test(lower)) return 'conditional_logic'
    if (/mapped|映射.*transform/.test(lower)) return 'mapped_transform'
    if (/infer|推断/.test(lower)) return 'inference_failure'
    if (/understand|理解|confus/.test(lower)) return 'concept_misunderstanding'
    return 'unknown'
  }

  /**
   * 清理过期记录。
   */
  prune(maxAgeDays = 30): { removedDifficulties: number } {
    this.load()
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    const before = this.difficulties.length
    this.difficulties = this.difficulties.filter((d) => d.lastSeen >= cutoff)
    const removed = before - this.difficulties.length
    if (removed > 0) {
      DIFFICULTIES_STORE.save(this.difficulties)
    }
    return { removedDifficulties: removed }
  }

  /** 获取统计摘要 */
  getStats(): { totalDifficulties: number; pendingSnapshots: number; changes: number } {
    this.load()
    return {
      totalDifficulties: this.difficulties.length,
      pendingSnapshots: this.snapshotManager.getPendingSnapshots().length,
      changes: this.changeLog.length,
    }
  }

  /** 获取变更日志 */
  getChangeLog(): Array<{ strategy: LearningStrategyChange; outcome?: string }> {
    return this.changeLog.map((c) => ({
      strategy: c.strategy,
      outcome: c.outcome,
    }))
  }
}

/** 全局单例 */
export const learningProgressTracker = new LearningProgressTracker()
