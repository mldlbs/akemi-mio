/**
 * MemoryOptimizationConfig — 记忆优化可调参数与统计分析
 *
 * 提供一组可通过 Evolution 自适应调整的记忆参数，以及用于决策的统计数据。
 * 所有带有版本号的变更可以被回滚。
 *
 * 集成点：
 * 1. MemoryService 通过 updateTunableConfig() 替换内部硬编码常量
 * 2. MemoryOptimizationCollector 读取 getOptimizationStats() 生成优化建议
 * 3. MemoryOptimizationExecutor 通过 updateTunableConfig() 应用优化变更
 * 4. 每次变更创建快照，支持回滚
 */

import { log } from '@akemi-mio/core/logger/Logger'

// ═══════════════════════════════════════════════
//  可调参数类型
// ═══════════════════════════════════════════════

export interface MemoryTunableConfig {
  /** ── 行为得分参数 ── */
  /** 每天未访问的衰减量 (0-0.1) */
  behaviorScoreDailyDecay: number
  /** 每次访问的加分 (0-0.2) */
  behaviorScoreAccessBoost: number
  /** 明确要求记住的加分 (0-0.3) */
  behaviorScoreExplicitRememberBoost: number
  /** 行为得分在综合评分中的权重 (0-1) */
  behaviorWeight: number

  /** ── 效用跟踪参数 ── */
  /** 效用每日衰减率 (0-0.1) */
  utilityDailyDecay: number
  /** Agent 引用加分 (0-0.2) */
  utilityAgentReferenceBoost: number
  /** 用户确认加分 (0-0.3) */
  utilityUserConfirmBoost: number
  /** 低效用阈值 (0-0.5) */
  utilityLowThreshold: number
  /** 高效用阈值 (0.5-1) */
  utilityHighThreshold: number

  /** ── 行为加权清洗参数 ── */
  /** 行为加权清洗保护乘数阈值（>=此值视为受保护，降低清洗概率） */
  behaviorCleanupProtectThreshold: number
  /** 行为加权清洗惩罚乘数阈值（<=此值视为应惩罚，提高清洗概率） */
  behaviorCleanupPenaltyThreshold: number
  /** 话题新鲜度惩罚天数阈值（超过此天数的话题权重开始衰减） */
  behaviorTopicStaleDays: number

  /** ── 层级容量 ── */
  /** 半永久层最大条目数 (10-100) */
  maxSemi: number
  /** 临时层最大条目数 (10-200) */
  maxEphemeral: number
}

// ═══════════════════════════════════════════════
//  默认值
// ═══════════════════════════════════════════════

export const DEFAULT_MEMORY_CONFIG: MemoryTunableConfig = {
  behaviorScoreDailyDecay: 0.015,
  behaviorScoreAccessBoost: 0.05,
  behaviorScoreExplicitRememberBoost: 0.15,
  behaviorWeight: 0.7,
  utilityDailyDecay: 0.02,
  utilityAgentReferenceBoost: 0.08,
  utilityUserConfirmBoost: 0.15,
  utilityLowThreshold: 0.15,
  utilityHighThreshold: 0.7,
  behaviorCleanupProtectThreshold: 1.5,
  behaviorCleanupPenaltyThreshold: 0.8,
  behaviorTopicStaleDays: 7,
  maxSemi: 30,
  maxEphemeral: 50,
}

/** 每个参数的可调范围 */
export const TUNABLE_RANGES: Record<keyof MemoryTunableConfig, { min: number; max: number }> = {
  behaviorScoreDailyDecay: { min: 0.001, max: 0.1 },
  behaviorScoreAccessBoost: { min: 0.01, max: 0.2 },
  behaviorScoreExplicitRememberBoost: { min: 0.05, max: 0.3 },
  behaviorWeight: { min: 0.3, max: 0.9 },
  utilityDailyDecay: { min: 0.001, max: 0.1 },
  utilityAgentReferenceBoost: { min: 0.01, max: 0.2 },
  utilityUserConfirmBoost: { min: 0.05, max: 0.3 },
  utilityLowThreshold: { min: 0.05, max: 0.5 },
  utilityHighThreshold: { min: 0.5, max: 1.0 },
  behaviorCleanupProtectThreshold: { min: 1.0, max: 3.0 },
  behaviorCleanupPenaltyThreshold: { min: 0.1, max: 1.0 },
  behaviorTopicStaleDays: { min: 1, max: 30 },
  maxSemi: { min: 10, max: 100 },
  maxEphemeral: { min: 10, max: 200 },
}

// ═══════════════════════════════════════════════
//  配置快照（用于回滚）
// ═══════════════════════════════════════════════

export interface ConfigSnapshot {
  id: string
  timestamp: number
  config: MemoryTunableConfig
  reason: string
}

// ═══════════════════════════════════════════════
//  记忆优化统计信息
// ═══════════════════════════════════════════════

export interface MemoryOptimizationStats {
  /** 条目统计 */
  totalEntries: number
  permanentCount: number
  semiCount: number
  ephemeralCount: number

  /** 访问统计 */
  accessStats: {
    /** 平均访问次数 */
    meanAccessCount: number
    /** 中位数访问次数 */
    medianAccessCount: number
    /** 零访问条目数（从未被访问） */
    neverAccessedCount: number
    /** 零访问条目占比 */
    neverAccessedRatio: number
    /** P90 访问次数 */
    p90AccessCount: number
    /** P99 访问次数 */
    p99AccessCount: number
    /** 长时间未访问条目数（7天以上） */
    staleEntriesCount: number
    /** 长尾记忆数（访问次数 <= 1 且不是永久层） */
    longTailCount: number
    /** 长尾占比 */
    longTailRatio: number
  }

  /** 效用统计 */
  utilityStats: {
    /** 平均效用分数 */
    meanUtility: number
    /** 中位数效用分数 */
    medianUtility: number
    /** 低效用条目数 */
    lowUtilityCount: number
    /** 低效用占比 */
    lowUtilityRatio: number
    /** 高效用条目数 */
    highUtilityCount: number
    /** 高效用占比 */
    highUtilityRatio: number
  }

  /** 行为得分统计 */
  behaviorStats: {
    /** 平均行为得分 */
    meanBehaviorScore: number
    /** 中位数行为得分 */
    medianBehaviorScore: number
    /** 已衰减条目数（得分 <= 初始分 0.5） */
    decayedCount: number
    /** 引用统计 */
    totalAgentReferences: number
    totalUserConfirmations: number
  }

  /** 配置快照 */
  currentConfig: MemoryTunableConfig
}

// ═══════════════════════════════════════════════
//  配置管理
// ═══════════════════════════════════════════════

export class MemoryConfigManager {
  private currentConfig: MemoryTunableConfig = { ...DEFAULT_MEMORY_CONFIG }
  private snapshots: ConfigSnapshot[] = []
  private readonly maxSnapshots = 20

  getConfig(): MemoryTunableConfig {
    return { ...this.currentConfig }
  }

  /**
   * 更新配置并创建快照（用于回滚）。
   * 验证每个参数是否在允许范围内。
   */
  updateConfig(partial: Partial<MemoryTunableConfig>, reason: string): MemoryTunableConfig {
    // 验证并应用
    const validated: Partial<MemoryTunableConfig> = {}
    for (const [key, value] of Object.entries(partial)) {
      const k = key as keyof MemoryTunableConfig
      const range = TUNABLE_RANGES[k]
      if (!range) continue // 忽略未知参数
      const clamped = Math.max(range.min, Math.min(range.max, value as number))
      if (clamped !== value) {
        log('WARN', 'memory_config_clamped', { key, original: value, clamped })
      }
      validated[k] = clamped
    }

    // 创建快照
    const snapshot: ConfigSnapshot = {
      id: `cfg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      config: { ...this.currentConfig },
      reason,
    }
    this.snapshots.push(snapshot)
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.shift()
    }

    // 应用更新
    Object.assign(this.currentConfig, validated)

    log('INFO', 'memory_config_updated', {
      changes: Object.keys(validated),
      reason,
      snapshotId: snapshot.id,
    })

    return { ...this.currentConfig }
  }

  /**
   * 回滚到最近一次快照。
   * @returns 回滚后的配置，或 null（无快照可回滚）
   */
  rollback(): MemoryTunableConfig | null {
    if (this.snapshots.length === 0) {
      log('WARN', 'memory_config_no_snapshots')
      return null
    }

    const snapshot = this.snapshots.pop()!
    this.currentConfig = { ...snapshot.config }

    log('INFO', 'memory_config_rolled_back', {
      snapshotId: snapshot.id,
      reason: snapshot.reason,
    })

    return { ...this.currentConfig }
  }

  /** 获取快照历史 */
  getSnapshots(): ConfigSnapshot[] {
    return [...this.snapshots]
  }

  /** 重置为默认配置 */
  resetToDefaults(): void {
    const reason = 'reset_to_defaults'
    this.updateConfig(DEFAULT_MEMORY_CONFIG, reason)
    log('INFO', 'memory_config_reset_to_defaults')
  }
}

/** 全局单例 */
export const memoryConfigManager = new MemoryConfigManager()
