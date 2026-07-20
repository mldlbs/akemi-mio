/**
 * MemoryOptimizationCollector — 记忆优化采集器
 *
 * 从 MemoryService 读取全面统计数据，分析记忆系统的健康状况，
 * 识别可优化的瓶颈，生成优化建议 Problem。
 *
 * 分析维度：
 * 1. 长尾记忆检测 — 大量记忆从未或很少被访问（访问次数 ≤ 1）
 * 2. 效用分布分析 — 低效用记忆占比过高表示衰减/清理策略需要调整
 * 3. 记忆枯萎检测 — 长期未访问的记忆过多，需要加速衰减
 * 4. 访问集中度 — 少数记忆被频繁访问，多数被冷落
 * 5. 配置匹配度 — 当前配置是否与统计数据匹配（如 maxSemi 是否合适）
 *
 * 生成的 Problem 由 MemoryOptimizationExecutor 消费。
 */

import { log } from '../../logger/Logger'
import type { Problem, SignalCollector } from './types'
import type { MemoryService } from '../../memory/MemoryService'
import type { MemoryOptimizationStats } from '../../memory/MemoryOptimizationConfig'
import { TUNABLE_RANGES } from '../../memory/MemoryOptimizationConfig'

// ═══════════════════════════════════════════════
//  配置常量
// ═══════════════════════════════════════════════

/** 长尾占比阈值：超过此值时建议优化 */
const LONG_TAIL_THRESHOLD = 0.3

/** 低效用占比阈值 */
const LOW_UTILITY_THRESHOLD = 0.25

/** 零访问占比阈值 */
const NEVER_ACCESSED_THRESHOLD = 0.15

/** 枯萎记忆占比阈值（7天未访问） */
const STALE_THRESHOLD = 0.2

/** 两次采集最小间隔（2 小时，与 Evolution 周期一致） */
const MIN_INTERVAL_MS = 2 * 60 * 60 * 1000

/** 每次采集最多生成的问题数 */
const MAX_PROBLEMS_PER_CYCLE = 2

/** 半永久层使用率阈值：超过此值建议扩容 */
const SEMI_CAPACITY_USAGE_THRESHOLD = 0.85

// ═══════════════════════════════════════════════
//  分析结果接口
// ═══════════════════════════════════════════════

interface AnalysisFinding {
  type: 'long_tail' | 'low_utility' | 'never_accessed' | 'stale_memories' | 'capacity_pressure' | 'decay_mismatch'
  severity: 'warning' | 'info'
  title: string
  detail: string
  /** 建议调整的参数 */
  suggestedParams?: Record<string, number>
  /** 说明 */
  rationale: string
}

// ═══════════════════════════════════════════════
//  MemoryOptimizationCollector
// ═══════════════════════════════════════════════

export class MemoryOptimizationCollector implements SignalCollector {
  readonly name = 'memory-optimization'
  readonly source = 'memory' as const

  private lastRun = 0
  private minIntervalMs = MIN_INTERVAL_MS
  /** 已生成的 problem 指纹（防重复） */
  private emittedFingerprints = new Set<string>()
  /** MemoryService 引用（由 PipelineOrchestrator 在 register 时注入） */
  private memoryService: MemoryService | null = null

  shouldRun(): boolean {
    if (Date.now() - this.lastRun < this.minIntervalMs) return false
    return this.memoryService !== null
  }

  /** 注入 MemoryService 引用（由 PipelineOrchestrator 在注册后调用） */
  setMemoryService(ms: MemoryService): void {
    this.memoryService = ms
    log('INFO', 'memory_opt_collector_memory_attached')
  }

  async collect(): Promise<Problem[]> {
    this.lastRun = Date.now()

    if (!this.memoryService) {
      log('WARN', 'memory_opt_collector_no_memory_service')
      return []
    }

    try {
      const stats = this.memoryService.getOptimizationStats()

      // 数据量不足时不分析
      if (stats.totalEntries < 5) {
        log('INFO', 'memory_opt_collector_insufficient_data', { entries: stats.totalEntries })
        return []
      }

      // 执行多维度分析
      const findings = this.analyze(stats)

      // 去重并转 Problem
      const problems: Problem[] = []
      for (const finding of findings) {
        const fp = this.fingerprint(finding)
        if (this.emittedFingerprints.has(fp)) continue
        this.emittedFingerprints.add(fp)

        const problem = this.findingToProblem(finding, stats)
        if (problem) problems.push(problem)
      }

      // 清理旧指纹
      if (this.emittedFingerprints.size > 100) {
        const entries = Array.from(this.emittedFingerprints)
        this.emittedFingerprints = new Set(entries.slice(-50))
      }

      log('INFO', 'memory_opt_collector_done', {
        totalEntries: stats.totalEntries,
        findings: findings.length,
        problems: problems.length,
        longTail: stats.accessStats.longTailRatio.toFixed(3),
        lowUtility: stats.utilityStats.lowUtilityRatio.toFixed(3),
      })

      return problems.slice(0, MAX_PROBLEMS_PER_CYCLE)
    } catch (err: any) {
      log('ERROR', 'memory_opt_collector_error', { error: err.message })
      return []
    }
  }

  // ═══════════════════════════════════════════════
  //  多维度分析
  // ═══════════════════════════════════════════════

  private analyze(stats: MemoryOptimizationStats): AnalysisFinding[] {
    const findings: AnalysisFinding[] = []

    // 1. 长尾记忆检测
    if (stats.accessStats.longTailRatio > LONG_TAIL_THRESHOLD) {
      const ratio = stats.accessStats.longTailRatio
      const severity = ratio > 0.5 ? 'warning' : 'info'
      const currentDecay = stats.currentConfig.behaviorScoreDailyDecay
      // 长尾过多 → 建议略微提高衰减率以加速清理低价值记忆
      const suggestedDecay = Math.min(
        currentDecay * 1.3,
        TUNABLE_RANGES.behaviorScoreDailyDecay.max,
      )

      findings.push({
        type: 'long_tail',
        severity,
        title: `长尾记忆占比过高 (${(ratio * 100).toFixed(0)}%)`,
        detail: `${stats.accessStats.longTailCount} 条记忆访问次数 ≤ 1，占总 user_fact 的 ${(ratio * 100).toFixed(0)}%。这些记忆很少被使用，但仍占用检索空间。`,
        suggestedParams: suggestedDecay !== currentDecay
          ? { behaviorScoreDailyDecay: suggestedDecay }
          : undefined,
        rationale: `当前衰减率 ${currentDecay} 可能过低，建议调至 ${suggestedDecay} 以加速低价值记忆衰减。`,
      })
    }

    // 2. 低效用记忆检测
    if (stats.utilityStats.lowUtilityRatio > LOW_UTILITY_THRESHOLD) {
      const ratio = stats.utilityStats.lowUtilityRatio
      const severity = ratio > 0.4 ? 'warning' : 'info'
      const currentLow = stats.currentConfig.utilityLowThreshold
      // 低效用太多 → 降低阈值让更多记忆存活 / 或提高衰减
      const suggestedThreshold = Math.max(
        TUNABLE_RANGES.utilityLowThreshold.min,
        currentLow - 0.03,
      )

      findings.push({
        type: 'low_utility',
        severity,
        title: `低效用记忆占比偏高 (${(ratio * 100).toFixed(0)}%)`,
        detail: `${stats.utilityStats.lowUtilityCount} 条记忆效用评分低于阈值，占总量的 ${(ratio * 100).toFixed(0)}%。`,
        suggestedParams: suggestedThreshold !== currentLow
          ? { utilityLowThreshold: suggestedThreshold }
          : undefined,
        rationale: `当前低效用阈值 ${currentLow} 可能偏宽松，建议微调至 ${suggestedThreshold} 以减少清理候选。`,
      })
    }

    // 3. 零访问记忆
    if (stats.accessStats.neverAccessedRatio > NEVER_ACCESSED_THRESHOLD) {
      const ratio = stats.accessStats.neverAccessedRatio
      findings.push({
        type: 'never_accessed',
        severity: 'info',
        title: `${stats.accessStats.neverAccessedCount} 条记忆从未被访问 (${(ratio * 100).toFixed(0)}%)`,
        detail: `这些记忆创建后从未被 Agent 引用或用户提及，可能不需要持久保存。`,
        rationale: `建议提高 behaviorScoreAccessBoost 以鼓励高质量记忆留存，或降低 maxEphemeral 以减少临时层容量。`,
      })
    }

    // 4. 枯萎记忆
    if (stats.accessStats.staleEntriesCount > 5 && stats.accessStats.staleEntriesCount > stats.totalEntries * STALE_THRESHOLD) {
      const count = stats.accessStats.staleEntriesCount
      const total = stats.totalEntries
      const currentDecay = stats.currentConfig.utilityDailyDecay
      const suggestedDecay = Math.min(
        currentDecay * 1.5,
        TUNABLE_RANGES.utilityDailyDecay.max,
      )

      findings.push({
        type: 'stale_memories',
        severity: 'info',
        title: `${count} 条记忆超过 7 天未访问 (${(count / total * 100).toFixed(0)}%)`,
        detail: `这些记忆长期未被使用，可能已经过时。`,
        suggestedParams: suggestedDecay !== currentDecay
          ? { utilityDailyDecay: suggestedDecay }
          : undefined,
        rationale: `当前效用衰减率 ${currentDecay} 过低，建议调至 ${suggestedDecay} 以加速过时记忆的自然淘汰。`,
      })
    }

    // 5. 层级容量压力
    const semiUsage = stats.semiCount / stats.currentConfig.maxSemi
    if (semiUsage > SEMI_CAPACITY_USAGE_THRESHOLD) {
      const suggestedMax = Math.min(
        Math.ceil(stats.semiCount * 1.3),
        TUNABLE_RANGES.maxSemi.max,
      )
      findings.push({
        type: 'capacity_pressure',
        severity: 'info',
        title: `半永久层容量紧张 (${stats.semiCount}/${stats.currentConfig.maxSemi}, ${(semiUsage * 100).toFixed(0)}%)`,
        detail: `半永久层已使用 ${semiUsage * 100}% 容量，接近上限可能导致频繁 pruning。`,
        suggestedParams: suggestedMax > stats.currentConfig.maxSemi
          ? { maxSemi: suggestedMax }
          : undefined,
        rationale: `建议将 maxSemi 从 ${stats.currentConfig.maxSemi} 扩容到 ${suggestedMax} 以减少 pruning 频率。`,
      })
    }

    return findings
  }

  // ═══════════════════════════════════════════════
  //  Finding → Problem 转换
  // ═══════════════════════════════════════════════

  private findingToProblem(finding: AnalysisFinding, stats: MemoryOptimizationStats): Problem | null {
    const id = `memory:${finding.type}:${this.lastRun}`

    // 构建描述
    const description = [
      `## ${finding.title}`,
      '',
      finding.detail,
      '',
      `## 当前配置`,
      `- 行为得分衰减率: ${stats.currentConfig.behaviorScoreDailyDecay}`,
      `- 效用衰减率: ${stats.currentConfig.utilityDailyDecay}`,
      `- 低效用阈值: ${stats.currentConfig.utilityLowThreshold}`,
      `- 高效用阈值: ${stats.currentConfig.utilityHighThreshold}`,
      `- maxSemi: ${stats.currentConfig.maxSemi}`,
      `- maxEphemeral: ${stats.currentConfig.maxEphemeral}`,
      '',
      `## 分析`,
      finding.rationale,
      '',
      `## 建议调整参数`,
      finding.suggestedParams
        ? Object.entries(finding.suggestedParams)
            .map(([k, v]) => `- ${k}: ${v}`)
            .join('\n')
        : '无需调整参数（仅报告状态）',
    ].join('\n')

    // 构建元数据
    const metadata: Record<string, string> = {
      analysisType: finding.type,
      rationale: finding.rationale.slice(0, 200),
      totalEntries: String(stats.totalEntries),
      longTailRatio: stats.accessStats.longTailRatio.toFixed(4),
      lowUtilityRatio: stats.utilityStats.lowUtilityRatio.toFixed(4),
    }
    if (finding.suggestedParams) {
      metadata.suggestedParams = JSON.stringify(finding.suggestedParams)
    }

    return {
      id,
      source: 'memory',
      severity: finding.severity,
      title: finding.title,
      description,
      estimatedCostChars: description.length,
      lastSeen: this.lastRun,
      occurrenceCount: 1,
      context: {
        raw: description,
        snippet: `memory optimization analysis: ${finding.type}`,
        metadata,
      },
    }
  }

  // ═══════════════════════════════════════════════
  //  工具方法
  // ═══════════════════════════════════════════════

  /** 生成 finding 去重指纹 */
  private fingerprint(f: AnalysisFinding): string {
    return `${f.type}:${this.lastRun}`
  }
}
