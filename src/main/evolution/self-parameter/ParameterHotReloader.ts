/**
 * ParameterHotReloader — 参数热更新与回滚管理器
 *
 * 职责：
 * 1. 接收参数调整提案，验证安全边界后应用
 * 2. 每次变更前自动创建快照（含所有参数当前值）
 * 3. 支持按快照回滚到任意历史状态
 * 4. 通过 EventBus 通知系统参数变更事件
 * 5. 持续跟踪最近更改的指标趋势，自动检测退化并建议回滚
 *
 * 安全机制：
 * - 每个参数变更都 clamp 到安全范围
 * - 单次调整幅度受 maxDeltaPerAdjustment 约束
 * - 快照历史最多保留 50 条
 * - 自动回滚检测（指标恶化超过 20% 触发警告）
 *
 * 集成方式：
 * - 由 ParameterSelfEvolutionExecutor 调用
 * - 持有 ParameterRegistry 引用进行实际参数更新
 * - 通过 EventBus 广播变更事件供其他模块监听
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { log } from '../../logger/Logger'
import { WORKSPACE } from '../../config'
import { eventBus } from '../../core/EventBus'
import { parameterRegistry } from './ParameterRegistry'
import { feedbackMetadataStore } from './FeedbackMetadataStore'
import type {
  ParameterAdjustmentProposal,
  ParameterSnapshot,
  RollbackRecord,
  ParameterAdjustedEvent,
  ParameterRollbackEvent,
  ParameterStoreData,
} from './types'

// ═══════════════════════════════════════════════
//  常量和默认配置
// ═══════════════════════════════════════════════

const STORE_FILE = join(WORKSPACE.evolution, 'parameter_snapshots.json')
const STORE_VERSION = 1
const MAX_SNAPSHOTS = 50

/** 指标基线恶化检测阈值 */
const DEGRADATION_THRESHOLD = 0.2 // 20% 恶化

// ═══════════════════════════════════════════════
//  ParameterHotReloader
// ═══════════════════════════════════════════════

export class ParameterHotReloader {
  private snapshots: ParameterSnapshot[] = []
  private rollbacks: RollbackRecord[] = []
  /** 最近一次应用提案前的基线（用于后续退化检测） */
  private lastBaseline: {
    timestamp: number
    satisfactionRate?: number
    successRate?: number
    interruptionRate?: number
  } | null = null

  /** 初始化：加载已持久化的快照 */
  init(): void {
    this.load()
    log('INFO', 'param_hot_reloader_init', {
      snapshots: this.snapshots.length,
      rollbacks: this.rollbacks.length,
    })
  }

  // ═══════════════════════════════════════════════
  //  参数变更
  // ═══════════════════════════════════════════════

  /**
   * 应用一组参数调整提案。
   * 1. 创建变更前快照
   * 2. 逐个验证提案的安全边界
   * 3. 应用验证通过的变更
   * 4. 广播变更事件
   *
   * @returns 实际应用的变更列表
   */
  applyProposals(proposals: ParameterAdjustmentProposal[]): Array<{
    key: string
    oldValue: number
    newValue: number
    reason: string
    confidence: number
  }> {
    if (proposals.length === 0) return []

    // 过滤无效提案
    const validProposals = proposals.filter((p) => {
      const param = parameterRegistry.get(p.parameterKey)
      if (!param) {
        log('WARN', 'param_hot_reload_unknown_param', { key: p.parameterKey })
        return false
      }
      if (!p.withinSafeBounds) {
        log('WARN', 'param_hot_reload_unsafe', { key: p.parameterKey, proposedValue: p.proposedValue })
        return false
      }
      const delta = Math.abs(p.proposedValue - p.currentValue)
      if (delta > param.maxDeltaPerAdjustment) {
        log('WARN', 'param_hot_reload_delta_exceeded', {
          key: p.parameterKey,
          delta,
          maxDelta: param.maxDeltaPerAdjustment,
        })
        return false
      }
      return true
    })

    if (validProposals.length === 0) return []

    // 记录基线（当前指标状态，用于后续退化检测）
    this.recordBaseline()

    // 创建快照（变更前）
    const snapshotValues = parameterRegistry.getSnapshotValues()
    const snapshot: ParameterSnapshot = {
      id: `param_snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      values: snapshotValues,
      reason: `自动应用 ${validProposals.length} 个参数调整`,
      isAutoApplied: true,
    }
    this.snapshots.push(snapshot)
    if (this.snapshots.length > MAX_SNAPSHOTS) {
      this.snapshots.shift()
    }

    // 应用变更
    const appliedChanges: Array<{ key: string; oldValue: number; newValue: number; reason: string; confidence: number }> = []
    for (const p of validProposals) {
      const oldValue = parameterRegistry.get(p.parameterKey)?.currentValue ?? p.currentValue
      parameterRegistry.updateCurrentValue(p.parameterKey, p.proposedValue)
      appliedChanges.push({
        key: p.parameterKey,
        oldValue,
        newValue: p.proposedValue,
        reason: p.reason,
        confidence: p.confidence,
      })
    }

    // 持久化
    this.save()

    // 广播事件
    const event: ParameterAdjustedEvent = {
      changes: appliedChanges.map((c) => ({
        key: c.key,
        oldValue: c.oldValue,
        newValue: c.newValue,
        reason: c.reason,
      })),
      confidence: validProposals.reduce((s, p) => s + p.confidence, 0) / validProposals.length,
      snapshotId: snapshot.id,
      timestamp: Date.now(),
    }
    eventBus.emit('parameter.adjusted', event)

    log('INFO', 'param_hot_reload_applied', {
      changes: appliedChanges.length,
      snapshotId: snapshot.id,
      changesDetail: appliedChanges.map((c) => `${c.key}: ${c.oldValue} → ${c.newValue}`).join(', '),
    })

    return appliedChanges
  }

  // ═══════════════════════════════════════════════
  //  退化检测与回滚建议
  // ═══════════════════════════════════════════════

  /**
   * 记录当前指标状态作为基线（在应用变更前调用）。
   * 供后续退化检测使用。
   */
  private recordBaseline(): void {
    const analyses = feedbackMetadataStore.analyzeMetrics()
    const satisfaction = analyses.find((a) => a.category === 'user_satisfaction')
    const success = analyses.find((a) => a.category === 'task_success')
    const interruption = analyses.find((a) => a.category === 'interruption')

    this.lastBaseline = {
      timestamp: Date.now(),
      satisfactionRate: satisfaction?.currentValue,
      successRate: success?.currentValue,
      interruptionRate: interruption?.currentValue,
    }
  }

  /**
   * 检查最近一次变更后的指标是否恶化。
   * 如果检测到显著退化，建议回滚。
   *
   * @returns 回滚建议文本（空表示无需回滚）
   */
  checkDegradation(): string {
    if (!this.lastBaseline) return ''

    const analyses = feedbackMetadataStore.analyzeMetrics()
    const satisfaction = analyses.find((a) => a.category === 'user_satisfaction')
    const success = analyses.find((a) => a.category === 'task_success')
    const interruption = analyses.find((a) => a.category === 'interruption')

    const issues: string[] = []

    if (
      this.lastBaseline.satisfactionRate !== undefined &&
      satisfaction?.currentValue !== undefined &&
      satisfaction.currentValue < this.lastBaseline.satisfactionRate * (1 - DEGRADATION_THRESHOLD)
    ) {
      issues.push(
        `满意度: ${(this.lastBaseline.satisfactionRate * 100).toFixed(1)}% → ${(satisfaction.currentValue * 100).toFixed(1)}% (↓${(((this.lastBaseline.satisfactionRate - satisfaction.currentValue) / this.lastBaseline.satisfactionRate) * 100).toFixed(0)}%)`,
      )
    }

    if (
      this.lastBaseline.successRate !== undefined &&
      success?.currentValue !== undefined &&
      success.currentValue < this.lastBaseline.successRate * (1 - DEGRADATION_THRESHOLD)
    ) {
      issues.push(
        `成功率: ${(this.lastBaseline.successRate * 100).toFixed(1)}% → ${(success.currentValue * 100).toFixed(1)}%`,
      )
    }

    if (
      this.lastBaseline.interruptionRate !== undefined &&
      interruption?.currentValue !== undefined &&
      interruption.currentValue > this.lastBaseline.interruptionRate * (1 + DEGRADATION_THRESHOLD)
    ) {
      issues.push(
        `中断率: ${(this.lastBaseline.interruptionRate * 100).toFixed(1)}% → ${(interruption.currentValue * 100).toFixed(1)}% (↑${(((interruption.currentValue - this.lastBaseline.interruptionRate) / this.lastBaseline.interruptionRate) * 100).toFixed(0)}%)`,
      )
    }

    if (issues.length === 0) return ''

    const suggestion = [
      '⚠️ 检测到参数调整后指标恶化：',
      ...issues.map((i) => `  - ${i}`),
      '',
      '建议回滚到最近一次快照。',
    ].join('\n')

    log('WARN', 'param_hot_reload_degradation_detected', {
      issues: issues.length,
      details: issues.join('; '),
    })

    return suggestion
  }

  // ═══════════════════════════════════════════════
  //  回滚
  // ═══════════════════════════════════════════════

  /**
   * 回滚到最近一次快照。
   * @returns 回滚摘要文本，或 null（无可回滚快照）
   */
  rollback(): string | null {
    if (this.snapshots.length === 0) {
      log('WARN', 'param_hot_reload_no_snapshots')
      return null
    }

    const snapshot = this.snapshots.pop()!
    const restoredCount = parameterRegistry.restoreValues(snapshot.values)

    // 记录回滚
    const rollbackRecord: RollbackRecord = {
      id: `rollback_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      snapshotId: snapshot.id,
      reason: snapshot.reason.includes('自动') ? '自动检测到指标恶化' : '用户手动回滚',
      restoredValues: { ...snapshot.values },
    }
    this.rollbacks.push(rollbackRecord)

    // 持久化
    this.save()

    // 广播事件
    const event: ParameterRollbackEvent = {
      snapshotId: snapshot.id,
      reason: rollbackRecord.reason,
      affectedParams: restoredCount,
      timestamp: Date.now(),
    }
    eventBus.emit('parameter.rollback', event)

    log('INFO', 'param_hot_reload_rollback', {
      snapshotId: snapshot.id,
      restoredCount,
      reason: rollbackRecord.reason,
    })

    return `✅ 已回滚${restoredCount}个参数到快照 ${snapshot.id.slice(-12)}（${new Date(snapshot.timestamp).toLocaleString('zh-CN')}）`
  }

  /** 获取快照列表 */
  getSnapshots(): ParameterSnapshot[] {
    return [...this.snapshots]
  }

  /** 获取回滚记录 */
  getRollbacks(): RollbackRecord[] {
    return [...this.rollbacks]
  }

  /** 获取最后基线 */
  getLastBaseline() {
    return this.lastBaseline ? { ...this.lastBaseline } : null
  }

  // ═══════════════════════════════════════════════
  //  持久化
  // ═══════════════════════════════════════════════

  private load(): void {
    try {
      if (!existsSync(STORE_FILE)) return
      const raw = readFileSync(STORE_FILE, 'utf-8')
      const data: ParameterStoreData = JSON.parse(raw)
      if (Array.isArray(data.snapshots)) {
        this.snapshots = data.snapshots
      }
      if (Array.isArray(data.rollbacks)) {
        this.rollbacks = data.rollbacks
      }
      log('INFO', 'param_hot_reloader_loaded', {
        snapshots: this.snapshots.length,
        rollbacks: this.rollbacks.length,
      })
    } catch (err: any) {
      log('WARN', 'param_hot_reloader_load_failed', { error: err.message })
    }
  }

  private save(): void {
    try {
      const dir = dirname(STORE_FILE)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const data: ParameterStoreData = {
        version: STORE_VERSION,
        updatedAt: Date.now(),
        snapshots: this.snapshots,
        rollbacks: this.rollbacks,
      }
      writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf-8')
    } catch (err: any) {
      log('WARN', 'param_hot_reloader_save_failed', { error: err.message })
    }
  }
}

/** 全局单例 */
export const parameterHotReloader = new ParameterHotReloader()
