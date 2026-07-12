/**
 * ToolEvalSnapshotStore — 工具调用评估快照存储
 *
 * 模式来源：src/main/asr/AsrLogStore.ts + AsrEvolutionManager.ts
 *
 * ASR 架构中，AsrLogStore 提供 createEvalSnapshot() / evaluateSnapshot()
 * 用于在配置变更前后对比纠错率指标，帮助做出 keep/rollback 决策。
 * AsrEvolutionManager 协调补丁应用 → 评估 → 决策的完整周期。
 *
 * 本模块将此模式迁移到 Agent 工具领域：
 * - 在工具配置/行为变更前创建评估快照（捕获当前成功率基线）
 * - 变更后对比当前指标与基线，检测改进或退化
 * - 提供 keep/rollback 决策支持
 *
 * 集成点：
 * - 读取 ToolCallLogStore 中的工具调用记录计算指标
 * - 供 ToolEvolutionExecutor 在执行优化前/后使用
 * - 供运营工具（自检工具）查询快照状态
 */

import { log } from '../logger/Logger'
import { toolCallLogStore } from './ToolCallLogStore'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { WORKSPACE } from '../config'

// =============================================================================
// 类型定义
// =============================================================================

/** 单工具指标快照 */
export interface ToolMetricSnapshot {
  /** 工具名 */
  toolName: string
  /** 总调用次数 */
  totalCalls: number
  /** 成功次数 */
  successCount: number
  /** 失败次数 */
  failureCount: number
  /** 成功率 (0–1) */
  successRate: number
  /** 平均延迟（毫秒，仅成功调用） */
  avgLatencyMs: number
}

/** 工具评估快照 */
export interface ToolEvalSnapshot {
  /** 唯一标识 */
  id: string
  /** 创建时间戳 */
  timestamp: number
  /** 快照描述 */
  description: string
  /** 基线（快照创建时）的各工具指标 */
  beforeMetrics: {
    /** 总体数据 */
    overall: {
      totalCalls: number
      successCount: number
      failureCount: number
      successRate: number
    }
    /** 按工具分组统计 */
    byTool: ToolMetricSnapshot[]
  }
  /** 已应用的变更描述列表 */
  appliedChanges: string[]
  /** 评估状态 */
  status: 'pending' | 'kept' | 'rolled_back'
}

/** 评估结果 */
export type EvalVerdict = 'improved' | 'worsened' | 'unchanged' | 'not_found'

/** 决策结果 */
export interface EvalDecision {
  verdict: EvalVerdict
  action: 'keep' | 'rollback' | 'no_action'
  details?: {
    /** 总体成功率变化（正值 = 改进） */
    overallRateDelta: number
    /** 指标不足的工具数 */
    insufficientSamples: number
    /** 显著改进的工具数 */
    improvedTools: number
    /** 显著退化的工具数 */
    worsenedTools: number
  }
}

// =============================================================================
// 配置常量
// =============================================================================

/** 评估快照保留数上限 */
const MAX_SNAPSHOTS = 50

/** 评估快照持久化路径 */
const SNAPSHOTS_FILE = join(WORKSPACE.cache, 'tool-eval-snapshots.json')

/** 最少样本数：工具调用少于该数不做评估 */
const MIN_SAMPLES_THRESHOLD = 5

/** 改进/退化判定阈值：成功率变化超过 ±10% 视为显著 */
const RATE_CHANGE_THRESHOLD = 0.1

/** 数据不足时的回退判定：新调用数小于此值视为 insufficient */
const MIN_RECENT_CALLS = 5

// =============================================================================
// ToolEvalSnapshotStore
// =============================================================================

export class ToolEvalSnapshotStore {
  private snapshots: ToolEvalSnapshot[] = []
  private loaded = false

  // ==================== 初始化 ====================

  /** 从磁盘懒加载快照数据 */
  private ensureLoaded(): void {
    if (this.loaded) return
    try {
      if (existsSync(SNAPSHOTS_FILE)) {
        const raw = readFileSync(SNAPSHOTS_FILE, 'utf-8')
        const data = JSON.parse(raw)
        if (Array.isArray(data)) {
          this.snapshots = data as ToolEvalSnapshot[]
        }
      }
    } catch (err) {
      log('WARN', 'tool_eval_snapshot_load_failed', { error: String(err) })
    }
    this.loaded = true
  }

  /** 持久化到磁盘 */
  private persist(): void {
    try {
      const dir = dirname(SNAPSHOTS_FILE)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(SNAPSHOTS_FILE, JSON.stringify(this.snapshots, null, 2), 'utf-8')
    } catch (err) {
      log('WARN', 'tool_eval_snapshot_persist_failed', { error: String(err) })
    }
  }

  // ==================== 快照创建 ====================

  /**
   * 创建评估快照，捕获当前工具调用指标基线。
   *
   * 在应用工具配置/行为变更前调用，记录当前成功率等指标。
   *
   * @param appliedChanges 已应用的变更描述列表（供回溯时参考）
   * @param description 快照描述
   * @returns 创建的评估快照
   *
   * 对应 ASR AsrLogStore.createEvalSnapshot():
   * - ASR 捕获纠错率 (correctionRate) 作为基线
   * - 本版本捕获工具成功率 (successRate) 作为基线
   */
  createEvalSnapshot(
    appliedChanges: string[],
    description?: string,
  ): ToolEvalSnapshot {
    this.ensureLoaded()

    const stats = toolCallLogStore.getStats()
    const byTool: ToolMetricSnapshot[] = []

    let totalCalls = 0
    let totalSuccess = 0
    let totalFailure = 0

    for (const [toolName, toolStats] of Object.entries(stats.byTool)) {
      byTool.push({
        toolName,
        totalCalls: toolStats.total,
        successCount: toolStats.success,
        failureCount: toolStats.failure,
        successRate: toolStats.total > 0
          ? toolStats.success / toolStats.total
          : 0,
        avgLatencyMs: 0, // ToolCallLogStore.getStats 不包含延迟，置零
      })
      totalCalls += toolStats.total
      totalSuccess += toolStats.success
      totalFailure += toolStats.failure
    }

    const snapshot: ToolEvalSnapshot = {
      id: `teval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      description: description || `工具调用指标基线 (${totalCalls} 次调用)`,
      beforeMetrics: {
        overall: {
          totalCalls,
          successCount: totalSuccess,
          failureCount: totalFailure,
          successRate: totalCalls > 0 ? totalSuccess / totalCalls : 0,
        },
        byTool,
      },
      appliedChanges,
      status: 'pending',
    }

    this.snapshots.push(snapshot)

    // 轮转超出上限的旧快照
    if (this.snapshots.length > MAX_SNAPSHOTS) {
      this.snapshots = this.snapshots.slice(-MAX_SNAPSHOTS)
    }

    this.persist()

    log('INFO', 'tool_eval_snapshot_created', {
      snapshotId: snapshot.id,
      totalCalls,
      successRate: (snapshot.beforeMetrics.overall.successRate * 100).toFixed(1) + '%',
      appliedChanges: appliedChanges.length,
      toolsTracked: byTool.length,
    })

    return snapshot
  }

  // ==================== 快照评估 ====================

  /**
   * 评估快照：对比当前工具调用指标与快照基线。
   *
   * 在变更应用一段时间后（如 2 小时）调用，判断变更效果。
   *
   * @param snapshotId 要评估的快照 ID
   * @returns 评估结论
   *
   * 对应 ASR AsrLogStore.evaluateSnapshot():
   * - ASR 对比纠错率变化（降低 = 改进）
   * - 本版本对比成功率变化（提升 = 改进）
   */
  evaluateSnapshot(snapshotId: string): EvalVerdict {
    this.ensureLoaded()

    const snapshot = this.snapshots.find((s) => s.id === snapshotId)
    if (!snapshot) return 'not_found'

    // 计算当前指标
    const currentStats = toolCallLogStore.getStats()

    // 只考虑快照创建后有新调用记录的工具
    const relevantTools = snapshot.beforeMetrics.byTool
      .filter((bt) => {
        const current = currentStats.byTool[bt.toolName]
        return current && (current.total - bt.totalCalls) >= MIN_RECENT_CALLS
      })

    // 数据不足 → 无法判断
    if (relevantTools.length === 0) {
      log('INFO', 'tool_eval_snapshot_insufficient_data', {
        snapshotId,
        note: 'no tools with sufficient new calls since snapshot',
      })
      return 'unchanged'
    }

    let improvedCount = 0
    let worsenedCount = 0
    const details: EvalDecision['details'] = {
      overallRateDelta: 0,
      insufficientSamples: snapshot.beforeMetrics.byTool.length - relevantTools.length,
      improvedTools: 0,
      worsenedTools: 0,
    }

    for (const bt of relevantTools) {
      const current = currentStats.byTool[bt.toolName]
      const currentRate = current.total > 0 ? current.success / current.total : 0
      const rateDelta = currentRate - bt.successRate

      if (rateDelta > RATE_CHANGE_THRESHOLD) {
        improvedCount++
      } else if (rateDelta < -RATE_CHANGE_THRESHOLD) {
        worsenedCount++
      }
    }

    details.improvedTools = improvedCount
    details.worsenedTools = worsenedCount
    details.overallRateDelta = currentStats.totalRecords > snapshot.beforeMetrics.overall.totalCalls
      ? (currentStats.byTool
        ? Object.values(currentStats.byTool).reduce((s, t) => s + t.success, 0) /
          Math.max(Object.values(currentStats.byTool).reduce((s, t) => s + t.total, 0), 1)
        : 0) - snapshot.beforeMetrics.overall.successRate
      : 0

    // 判定规则（与 ASR 的 evaluateSnapshot 逻辑对齐）：
    // - 显著改进的工具数 > 退化数 → improved
    // - 显著退化的工具数 > 改进数 → worsened
    // - 持平 → unchanged
    let verdict: EvalVerdict
    if (improvedCount > worsenedCount && improvedCount >= 1) {
      verdict = 'improved'
    } else if (worsenedCount > improvedCount && worsenedCount >= 1) {
      verdict = 'worsened'
    } else {
      verdict = 'unchanged'
    }

    log('INFO', 'tool_eval_snapshot_evaluated', {
      snapshotId,
      verdict,
      improvedTools: improvedCount,
      worsenedTools: worsenedCount,
      insufficientSamples: details.insufficientSamples,
    })

    return verdict
  }

  // ==================== 决策与状态管理 ====================

  /**
   * 根据评估结果做出决策。
   *
   * 对应 ASR AsrEvolutionManager.evaluateAndDecide():
   * - improved → 保持变更并标记快照为 kept
   * - worsened → 标记快照为 rolled_back（调用方应执行回滚）
   * - unchanged → 保持现状，标记为 kept
   * - not_found → 无操作
   */
  decide(snapshotId: string): EvalDecision {
    this.ensureLoaded()

    const snapshot = this.snapshots.find((s) => s.id === snapshotId)
    if (!snapshot) {
      return { verdict: 'not_found', action: 'no_action' }
    }

    const verdict = this.evaluateSnapshot(snapshotId)
    let action: EvalDecision['action']
    let details: EvalDecision['details'] | undefined

    switch (verdict) {
      case 'improved':
        this.updateSnapshotStatus(snapshotId, 'kept')
        action = 'keep'
        break
      case 'worsened':
        this.updateSnapshotStatus(snapshotId, 'rolled_back')
        action = 'rollback'
        break
      default:
        // unchanged / not_found → 不做回滚，标记为 kept
        this.updateSnapshotStatus(snapshotId, 'kept')
        action = 'no_action'
        break
    }

    log('INFO', 'tool_eval_snapshot_decision', {
      snapshotId,
      verdict,
      action,
    })

    return { verdict, action, details }
  }

  /**
   * 标记快照为保留或回滚。
   *
   * 对应 ASR AsrLogStore.updateSnapshotStatus().
   */
  updateSnapshotStatus(snapshotId: string, status: 'kept' | 'rolled_back'): boolean {
    this.ensureLoaded()
    const snapshot = this.snapshots.find((s) => s.id === snapshotId)
    if (!snapshot) return false
    snapshot.status = status
    this.persist()
    log('INFO', 'tool_eval_snapshot_status_updated', {
      snapshotId,
      status,
    })
    return true
  }

  // ==================== 查询接口 ====================

  /**
   * 获取所有评估快照。
   */
  getSnapshots(): ToolEvalSnapshot[] {
    this.ensureLoaded()
    return [...this.snapshots]
  }

  /**
   * 获取指定 ID 的快照。
   */
  getSnapshot(snapshotId: string): ToolEvalSnapshot | undefined {
    this.ensureLoaded()
    return this.snapshots.find((s) => s.id === snapshotId)
  }

  /**
   * 获取所有待评估的快照（pending 状态）。
   * 按创建时间升序排列（先进先出）。
   */
  getPendingSnapshots(): ToolEvalSnapshot[] {
    this.ensureLoaded()
    return this.snapshots
      .filter((s) => s.status === 'pending')
      .sort((a, b) => a.timestamp - b.timestamp)
  }

  /**
   * 获取快照统计信息。
   */
  getStats(): {
    total: number
    pending: number
    kept: number
    rolledBack: number
  } {
    this.ensureLoaded()
    return {
      total: this.snapshots.length,
      pending: this.snapshots.filter((s) => s.status === 'pending').length,
      kept: this.snapshots.filter((s) => s.status === 'kept').length,
      rolledBack: this.snapshots.filter((s) => s.status === 'rolled_back').length,
    }
  }

  /**
   * 清除所有快照（用于测试或重置）。
   */
  clear(): void {
    this.snapshots = []
    this.persist()
    log('INFO', 'tool_eval_snapshot_store_cleared')
  }
}

// =============================================================================
// 全局单例
// =============================================================================

/** 全局单例，供 ToolEvolutionExecutor、自检工具等共享 */
export const toolEvalSnapshotStore = new ToolEvalSnapshotStore()
