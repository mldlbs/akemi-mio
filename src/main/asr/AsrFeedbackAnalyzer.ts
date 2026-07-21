/**
 * AsrFeedbackAnalyzer — ASR 反馈分析器（空闲时批量优化）
 *
 * 在系统空闲时分析用户反馈记录（误识别纠正对），提取 TOP 50 高频误识别词汇，
 * 生成带权重的热词补丁，通过进化管理器批量应用。
 *
 * 设计目标（对应功能特性"自适应领域词表微调"）：
 * 1. 存储（误识别词，正确词）对和上下文语境 ← 由 AsrLogStore 提供
 * 2. 空闲时分析反馈记录，提取 TOP 50 高频误识别词汇 ← 本类的核心职责
 * 3. 调用预定义脚本更新 ASR 领域词表权重 ← 通过 AsrEvolutionManager 实现
 * 4. 生成配置文件补丁并动态重载 ← 由 AsrService 的热词注入机制实现
 *
 * 集成点：
 * - 由 AsrIdleDetector.onIdle() 在空闲时触发 analyzeAndOptimize()
 * - 读取 AsrLogStore.getErrorPatterns() 获取纠正模式
 * - 通过 AsrEvolutionManager.applyPatches() 应用批量补丁
 *
 * 安全机制：
 * - 仅在有足够反馈数据时执行（>= MIN_PATTERNS_THRESHOLD）
 * - 单次执行最大补丁数控制（MAX_PATCHES = 50）
 * - 同一模式不重复处理（幂等性缓存，2h TTL）
 * - 权重归一化防止过拟合
 * - 执行间隔保护（MIN_INTERVAL_MS）
 */

import { log } from '../logger/Logger'
import { asrLogStore, type AsrErrorPattern } from './AsrLogStore'
import { asrEvolutionManager, type AsrConfigPatch } from './AsrEvolutionManager'
import { asrHotwordManager } from './AsrHotwordManager'

// =============================================================================
// 配置
// =============================================================================

/** 单次提取 TOP N 高频模式 */
const TOP_N = 50

/** 视为有意义的模式的最低频次 */
const MIN_FREQUENCY = 2

/** 触发批量优化的最小模式数 */
const MIN_PATTERNS_THRESHOLD = 3

/** 分析窗口（毫秒）— 默认 24 小时 */
const ANALYSIS_WINDOW_MS = 24 * 60 * 60 * 1000

/** 单次执行最大补丁数 */
const MAX_PATCHES = 50

/** 幂等缓存 TTL（毫秒），避免同一模式在 2h 内重复执行 */
const IDEMPOTENCY_TTL_MS = 2 * 60 * 60 * 1000

/** 两次完整分析的最小间隔（毫秒） */
const MIN_INTERVAL_MS = 30 * 60 * 1000

/** 最大权重值 */
const MAX_WEIGHT = 1.0

/** 最小权重值 */
const MIN_WEIGHT = 0.1

// =============================================================================
// 类型
// =============================================================================

/**
 * 分析后的单个模式结果。
 */
export interface AnalyzedPattern {
  /** ASR 识别错误原文 */
  original: string
  /** 正确文本 */
  corrected: string
  /** 出现次数 */
  frequency: number
  /** 错误分类 */
  category: string
  /** 归一化权重 0.1–1.0 */
  weight: number
  /** 是否建议作为热词 */
  suggestHotword: boolean
  /** 是否建议领域语言模型增强 */
  suggestDomainBoost: boolean
  /** 最后出现时间 */
  lastSeen: number
}

/**
 * 批量优化结果。
 */
export interface BatchOptimizationResult {
  /** 已分析的模式数 */
  totalAnalyzed: number
  /** 已生成的补丁数 */
  patchesGenerated: number
  /** 已应用的补丁数 */
  patchesApplied: number
  /** 进化管理器快照 ID */
  snapshotId?: string
  /** 前 N 个高频词（仅用于日志/调试） */
  topCorrected: string[]
  /** 是否实际执行了变更 */
  changesApplied: boolean
  /** 跳过原因（如果没有变更） */
  skipReason?: string
}

// =============================================================================
// AsrFeedbackAnalyzer
// =============================================================================

export class AsrFeedbackAnalyzer {
  /** 幂等缓存：已处理的 pattern key（original|corrected） */
  private recentCache = new Set<string>()
  /** 上次执行时间戳 */
  private lastAnalyzeAt = 0

  /**
   * 分析纠正记录，提取 TOP N 高频误识别模式。
   *
   * @param since 可选，分析窗口起始时间戳（默认 24 小时前）
   * @returns 按频次降序排列的分析结果
   */
  analyze(since?: number): AnalyzedPattern[] {
    const windowStart = since ?? Date.now() - ANALYSIS_WINDOW_MS
    const patterns = asrLogStore.getErrorPatterns(windowStart)

    log('INFO', 'asr_feedback_analyze', {
      total_patterns: patterns.length,
      window_hours: (ANALYSIS_WINDOW_MS / 3600000).toFixed(1),
    })

    // 过滤低频率模式 → 按频次降序 → 取 TOP N
    const significant = patterns
      .filter((p) => p.frequency >= MIN_FREQUENCY)
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, TOP_N)

    // 转换为分析结果（含权重计算）
    const maxFreq = significant.length > 0 ? significant[0].frequency : 1
    const analyzed = significant.map((p) => this.analyzePattern(p, maxFreq))

    log('INFO', 'asr_feedback_analyze_result', {
      significant: analyzed.length,
      top_freq: analyzed[0]?.frequency ?? 0,
      top_word: analyzed[0]?.corrected ?? '(none)',
      lowest_freq: analyzed[analyzed.length - 1]?.frequency ?? 0,
    })

    return analyzed
  }

  /**
   * 分析并应用批量优化（空闲时调用的便捷入口）。
   *
   * 流程：
   * 1. 检查执行间隔和幂等性
   * 2. 分析纠正记录提取 TOP N 模式
   * 3. 生成带权重的配置补丁
   * 4. 通过 AsrEvolutionManager 批量应用
   * 5. 更新幂等缓存
   *
   * @returns 优化结果
   */
  analyzeAndOptimize(): BatchOptimizationResult {
    const now = Date.now()
    const result: BatchOptimizationResult = {
      totalAnalyzed: 0,
      patchesGenerated: 0,
      patchesApplied: 0,
      topCorrected: [],
      changesApplied: false,
    }

    // 1. 检查执行间隔
    if (now - this.lastAnalyzeAt < MIN_INTERVAL_MS) {
      const remainingMin = Math.round(
        (MIN_INTERVAL_MS - (now - this.lastAnalyzeAt)) / 60000,
      )
      result.skipReason = `距上次分析仅 ${Math.round((now - this.lastAnalyzeAt) / 60000)} 分钟，需等待 ${remainingMin} 分钟`
      log('INFO', 'asr_feedback_analyze_skip_interval', {
        lastAnalyzeAt: new Date(this.lastAnalyzeAt).toISOString(),
        remainingMin,
      })
      return result
    }

    // 2. 分析纠正记录
    const analyzed = this.analyze()
    result.totalAnalyzed = analyzed.length

    if (analyzed.length < MIN_PATTERNS_THRESHOLD) {
      result.skipReason = `有效模式不足 ${MIN_PATTERNS_THRESHOLD} 条（当前 ${analyzed.length} 条），跳过`
      log('INFO', 'asr_feedback_analyze_skip_insufficient', {
        count: analyzed.length,
        threshold: MIN_PATTERNS_THRESHOLD,
      })
      return result
    }

    // 3. 生成带权重的补丁
    const patches = this.buildPatches(analyzed)
    result.patchesGenerated = patches.length
    result.topCorrected = analyzed
      .slice(0, 10)
      .map((a) => `${a.corrected}(${a.frequency}, w=${a.weight.toFixed(2)})`)

    if (patches.length === 0) {
      result.skipReason = '所有模式均已处理过（幂等性缓存命中），无新增补丁'
      log('INFO', 'asr_feedback_analyze_skip_idempotent', {
        analyzed: analyzed.length,
      })
      return result
    }

    // 4. 通过进化管理器应用补丁
    const applyResult = asrEvolutionManager.applyPatches(patches, {
      batchLabel: `空闲批量优化 (${analyzed.length} 模式, TOP ${TOP_N})`,
    })

    if (!applyResult) {
      result.skipReason = '进化管理器返回空结果（可能不可用）'
      log('WARN', 'asr_feedback_analyze_apply_failed')
      return result
    }

    result.patchesApplied = patches.length
    result.snapshotId = applyResult.snapshotId
    result.changesApplied = true
    this.lastAnalyzeAt = now

    // 5. 更新幂等缓存
    for (const p of patches) {
      const cacheKey = `${p.type}:${p.value}`
      this.recentCache.add(cacheKey)
      setTimeout(() => {
        this.recentCache.delete(cacheKey)
      }, IDEMPOTENCY_TTL_MS)
    }

    log('INFO', 'asr_feedback_analyze_optimized', {
      analyzed: analyzed.length,
      patchesApplied: patches.length,
      snapshotId: applyResult.snapshotId,
      topCorrected: result.topCorrected.slice(0, 5),
    })

    return result
  }

  // ── 内部方法 ──

  /**
   * 将单个错误模式转换为分析结果（含权重计算）。
   *
   * 权重策略：
   * - 线性归一化：weight = frequency / maxFreq
   * - 钳位范围：[MIN_WEIGHT, MAX_WEIGHT]
   * - homophone 类权重略降（同音字可能为偶然错误）
   * - domain_term/new_word 类权重略升（领域术语需优先学习）
   */
  private analyzePattern(pattern: AsrErrorPattern, maxFreq: number): AnalyzedPattern {
    let weight = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, pattern.frequency / maxFreq))

    // 根据错误类型调整权重
    switch (pattern.category) {
      case 'homophone':
        weight *= 0.8 // 同音字可能为偶然，降权
        break
      case 'domain_term':
        weight = Math.min(MAX_WEIGHT, weight * 1.2) // 领域术语优先
        break
      case 'new_word':
        weight = Math.min(MAX_WEIGHT, weight * 1.15) // 新词优先
        break
      case 'incomplete':
        weight = Math.min(MAX_WEIGHT, weight * 1.1) // 不完整识别暗示术语
        break
    }

    return {
      original: pattern.original,
      corrected: pattern.corrected,
      frequency: pattern.frequency,
      category: pattern.category,
      weight: Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, weight)),
      suggestHotword: true,
      suggestDomainBoost:
        pattern.category === 'domain_term' ||
        pattern.category === 'new_word' ||
        pattern.frequency >= 5,
      lastSeen: pattern.lastSeen,
    }
  }

  /**
   * 根据分析结果生成配置补丁。
   *
   * 补丁类型策略：
   * - 所有高频模式：hotword_add（带权重）
   * - domain_term/new_word 高频模式：额外生成 domain_lm_boost
   *
   * @param patterns 分析结果（已排序，高频在前）
   * @returns 去重后的补丁列表
   */
  private buildPatches(patterns: AnalyzedPattern[]): AsrConfigPatch[] {
    const patches: AsrConfigPatch[] = []
    const seenValues = new Set<string>()

    for (const p of patterns) {
      if (patches.length >= MAX_PATCHES) break

      // 幂等性检查
      const cacheKey = `hotword_add:${p.corrected}`
      if (this.recentCache.has(cacheKey)) continue

      // 检查与现有热词表重复
      const existingVocab = asrHotwordManager.exportVocabulary()
      const alreadyExists = existingVocab.some(
        (v) => v.word.toLowerCase() === p.corrected.toLowerCase(),
      )
      if (alreadyExists) continue

      // 检查同类项重复（防止同一词多次添加）
      if (seenValues.has(p.corrected.toLowerCase())) continue
      seenValues.add(p.corrected.toLowerCase())

      // 1. 热词添加（带权重）
      patches.push({
        type: 'hotword_add',
        description: `[空闲优化] "${p.corrected}" 频次=${p.frequency} 权重=${p.weight.toFixed(2)} 分类=${p.category}（误识别为 "${p.original}"）`,
        value: p.corrected,
        weight: p.weight,
      })

      // 2. 领域语言模型增强（仅对高频领域术语/新词）
      if (p.suggestDomainBoost && patches.length < MAX_PATCHES) {
        const boostKey = `domain_lm_boost:${p.corrected}`
        if (!this.recentCache.has(boostKey)) {
          patches.push({
            type: 'domain_lm_boost',
            description: `[空闲优化] 领域语言模型增强 "${p.corrected}"（${p.category} 频次=${p.frequency}）`,
            value: p.corrected,
            weight: Math.min(MAX_WEIGHT, p.weight * 1.3),
          })
        }
      }
    }

    return patches
  }

  /**
   * 获取最近分析统计。
   */
  getStats(): {
    lastAnalyzeAt: number
    cacheSize: number
  } {
    return {
      lastAnalyzeAt: this.lastAnalyzeAt,
      cacheSize: this.recentCache.size,
    }
  }
}

// =============================================================================
// 单例
// =============================================================================

/** 全局单例，供 AsrService 和空闲检测器共享 */
export const asrFeedbackAnalyzer = new AsrFeedbackAnalyzer()
