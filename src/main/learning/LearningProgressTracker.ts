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
 */

import { log } from '../logger/Logger'
import { WORKSPACE } from '../config'
import { join, dirname } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import type {
  LearningItem,
  LearningDifficulty,
  DifficultyCategory,
  LearningEvalSnapshot,
  LearningCategory,
  LearningProgress,
} from './types'

// ── 持久化路径 ──

const DIFFICULTIES_FILE = join(WORKSPACE.cache, 'learning-difficulties.json')
const SNAPSHOTS_FILE = join(WORKSPACE.cache, 'learning-eval-snapshots.json')

/** 保留最近 N 条难点记录 */
const MAX_DIFFICULTIES = 500
/** 保留最近 N 个评估快照 */
const MAX_SNAPSHOTS = 50
/** 评估回溯窗口（毫秒）*/
const DEFAULT_LOOKBACK_MS = 2 * 60 * 60 * 1000 // 2h

// ── 策略变更类型 ──

export type LearningStrategyType =
  | 'focus_shift'       // 调整关注领域
  | 'difficulty_change' // 调整内容难度
  | 'review_boost'      // 加大复习密度
  | 'concept_add'       // 新增知识点
  | 'pace_adjust'       // 调整学习节奏

export interface LearningStrategyChange {
  type: LearningStrategyType
  description: string
  params: Record<string, unknown>
}

// ── LearningProgressTracker ──

export class LearningProgressTracker {
  private difficulties: LearningDifficulty[] = []
  private snapshots: LearningEvalSnapshot[] = []
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
   * 设置知识点查询回调（注入 LearningVocabularyManager 的查询能力）。
   */
  setGetItemsFn(fn: () => LearningItem[]): void {
    this.getItemsFn = fn
  }

  // ==================== 初始化 ====================

  load(): void {
    if (this.loaded) return
    this.loadDifficulties()
    this.loadSnapshots()
    this.loaded = true
    log('INFO', 'learning_tracker_loaded', {
      difficulties: this.difficulties.length,
      snapshots: this.snapshots.length,
    })
  }

  private loadDifficulties(): void {
    try {
      if (!existsSync(DIFFICULTIES_FILE)) return
      const raw = readFileSync(DIFFICULTIES_FILE, 'utf-8')
      const data = JSON.parse(raw)
      if (Array.isArray(data)) this.difficulties = data
    } catch (err) {
      log('WARN', 'learning_tracker_load_difficulties_failed', { error: String(err) })
    }
  }

  private loadSnapshots(): void {
    try {
      if (!existsSync(SNAPSHOTS_FILE)) return
      const raw = readFileSync(SNAPSHOTS_FILE, 'utf-8')
      const data = JSON.parse(raw)
      if (Array.isArray(data)) this.snapshots = data
    } catch (err) {
      log('WARN', 'learning_tracker_load_snapshots_failed', { error: String(err) })
    }
  }

  private saveDifficulties(): void {
    try {
      const dir = dirname(DIFFICULTIES_FILE)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(DIFFICULTIES_FILE, JSON.stringify(this.difficulties, null, 2), 'utf-8')
    } catch (err) {
      log('WARN', 'learning_tracker_save_difficulties_failed', { error: String(err) })
    }
  }

  private saveSnapshots(): void {
    try {
      const dir = dirname(SNAPSHOTS_FILE)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(SNAPSHOTS_FILE, JSON.stringify(this.snapshots, null, 2), 'utf-8')
    } catch (err) {
      log('WARN', 'learning_tracker_save_snapshots_failed', { error: String(err) })
    }
  }

  // ==================== 困难记录（对应 AsrLogStore 的纠正记录） ====================

  /**
   * 记录一次学习困难（练习做错/概念不理解）。
   * 对应 AsrLogStore.recordCorrection()。
   */
  recordDifficulty(
    conceptId: string,
    conceptName: string,
    description: string,
    category?: DifficultyCategory,
  ): void {
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
    this.saveDifficulties()
  }

  /**
   * 获取高频难点模式（用于自适应调整学习策略）。
   * 对应 AsrLogStore.getErrorPatterns()。
   */
  getDifficultyPatterns(since?: number): LearningDifficulty[] {
    this.load()
    const relevant = since
      ? this.difficulties.filter((d) => d.lastSeen >= since)
      : this.difficulties

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

    return Array.from(clusterMap.values())
      .sort((a, b) => b.frequency - a.frequency)
  }

  /**
   * 获取学习正确率（对应 AsrLogStore.getCorrectionRate()）。
   */
  getAccuracyRate(since?: number): { rate: number; difficulties: number; totalItems: number } {
    this.load()
    const relevant = since
      ? this.difficulties.filter((d) => d.lastSeen >= since)
      : this.difficulties

    const items = this.getItemsFn?.() || []
    const totalItems = items.length
    const difficulties = relevant.length

    return {
      rate: totalItems > 0 ? Math.max(0, 1 - difficulties / Math.max(totalItems, 1)) : 1,
      difficulties,
      totalItems,
    }
  }

  // ==================== 评估快照（对应 AsrLogStore/AsrEvolutionManager 的快照机制） ====================

  /**
   * 创建进度评估快照（策略变更前拍下基线）。
   * 对应 AsrLogStore.createEvalSnapshot()。
   */
  createSnapshot(appliedChanges: string[], lookbackMs = DEFAULT_LOOKBACK_MS): LearningEvalSnapshot {
    this.load()

    const items = this.getItemsFn?.() || []
    const totalMastery = items.length > 0
      ? items.reduce((s, i) => s + i.mastery, 0) / items.length
      : 0
    const totalAttempts = items.reduce((s, i) => s + i.totalAttempts, 0)
    const totalCorrect = items.reduce((s, i) => s + i.correctCount, 0)
    const accuracy = totalAttempts > 0 ? totalCorrect / totalAttempts : 0

    const snapshot: LearningEvalSnapshot = {
      id: `learn_eval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      beforeMastery: Math.round(totalMastery * 100) / 100,
      beforeAccuracy: Math.round(accuracy * 100) / 100,
      appliedChanges,
      status: 'pending',
    }

    this.snapshots.push(snapshot)
    if (this.snapshots.length > MAX_SNAPSHOTS) {
      this.snapshots = this.snapshots.slice(-MAX_SNAPSHOTS)
    }
    this.saveSnapshots()

    log('INFO', 'learning_snapshot_created', {
      snapshotId: snapshot.id,
      beforeMastery: snapshot.beforeMastery,
      beforeAccuracy: snapshot.beforeAccuracy,
      changes: appliedChanges.length,
    })

    return snapshot
  }

  /**
   * 评估快照：对比当前进度与快照基线。
   * 对应 AsrLogStore.evaluateSnapshot()。
   */
  evaluateSnapshot(
    snapshotId: string,
  ): 'improved' | 'worsened' | 'unchanged' | 'not_found' {
    this.load()
    const snapshot = this.snapshots.find((s) => s.id === snapshotId)
    if (!snapshot) return 'not_found'

    const items = this.getItemsFn?.() || []
    const totalMastery = items.length > 0
      ? items.reduce((s, i) => s + i.mastery, 0) / items.length
      : 0
    const totalAttempts = items.reduce((s, i) => s + i.totalAttempts, 0)
    const totalCorrect = items.reduce((s, i) => s + i.correctCount, 0)
    const currentAccuracy = totalAttempts > 0 ? totalCorrect / totalAttempts : 0

    const afterMastery = Math.round(totalMastery * 100) / 100
    const afterAccuracy = Math.round(currentAccuracy * 100) / 100

    snapshot.afterMastery = afterMastery
    snapshot.afterAccuracy = afterAccuracy
    this.saveSnapshots()

    // 数据不足则无法判断
    if (items.length < 3) return 'unchanged'

    const masteryChange = afterMastery - snapshot.beforeMastery
    const accuracyChange = afterAccuracy - snapshot.beforeAccuracy

    // 掌握度提升 > 5% 或 正确率提升 > 10% → 改进
    if (masteryChange > 0.05 || accuracyChange > 0.1) return 'improved'
    // 掌握度下降 > 5% 或 正确率下降 > 10% → 恶化
    if (masteryChange < -0.05 || accuracyChange < -0.1) return 'worsened'
    return 'unchanged'
  }

  /**
   * 标记快照为保留或回滚。
   */
  updateSnapshotStatus(snapshotId: string, status: 'kept' | 'rolled_back'): boolean {
    const snapshot = this.snapshots.find((s) => s.id === snapshotId)
    if (!snapshot) return false
    snapshot.status = status
    this.saveSnapshots()
    return true
  }

  /**
   * 获取待评估的快照。
   */
  getPendingSnapshots(): LearningEvalSnapshot[] {
    this.load()
    return this.snapshots.filter((s) => s.status === 'pending')
  }

  /**
   * 获取所有快照。
   */
  getSnapshots(): LearningEvalSnapshot[] {
    this.load()
    return [...this.snapshots]
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
   * 对应 AsrEvolutionManager.evaluateAndDecide()。
   */
  evaluateAndDecide(snapshotId?: string): {
    verdict: 'improved' | 'worsened' | 'unchanged' | 'not_found'
    action: 'keep' | 'rollback' | 'no_action'
  } {
    // 如果没有指定 snapshotId，找最近一个 pending 的
    const targetId = snapshotId || this.findPendingSnapshotId()
    if (!targetId) {
      return { verdict: 'not_found', action: 'no_action' }
    }

    const verdict = this.evaluateSnapshot(targetId)

    let action: 'keep' | 'rollback' | 'no_action'
    switch (verdict) {
      case 'improved':
        this.updateSnapshotStatus(targetId, 'kept')
        action = 'keep'
        break
      case 'worsened':
        this.updateSnapshotStatus(targetId, 'rolled_back')
        action = 'rollback'
        break
      default:
        this.updateSnapshotStatus(targetId, 'kept')
        action = 'no_action'
        break
    }

    // 更新变更日志
    const logEntry = this.changeLog.find((c) => c.snapshotId === targetId)
    if (logEntry) {
      logEntry.outcome = verdict
    }

    log('INFO', 'learning_strategy_evaluated', {
      snapshotId: targetId,
      verdict,
      action,
    })

    return { verdict, action }
  }

  // ==================== 内部方法 ====================

  private findPendingSnapshotId(): string | null {
    const pending = this.getPendingSnapshots()
    if (pending.length === 0) return null
    return pending[0].id
  }

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
    this.difficulties = Array.from(merged.values())
      .sort((a, b) => b.frequency - a.frequency)
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
    if (removed > 0) this.saveDifficulties()
    return { removedDifficulties: removed }
  }

  /** 获取统计摘要 */
  getStats(): { totalDifficulties: number; pendingSnapshots: number; changes: number } {
    this.load()
    return {
      totalDifficulties: this.difficulties.length,
      pendingSnapshots: this.getPendingSnapshots().length,
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
