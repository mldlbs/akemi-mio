/**
 * BehaviorPredictor — 行为驱动工具预激活引擎
 *
 * ## 职责
 * 1. 记录工具调用序列及上下文（滑动窗口）
 * 2. 构建序列模式模型（马尔可夫链风格）
 * 3. 基于当前上下文预测下一个可能调用的工具
 * 4. 异步预加载/预缓存预测结果
 *
 * ## 生命周期
 *   recordCall(tool, args) → build/update patterns → predict next → preload
 *
 * ## 资源保护
 * - 预加载结果有 TTL，超时后自动失效
 * - 异步预加载有独立的超时控制
 * - 低置信度预测跳过预加载
 * - 预加载缓存上限防止内存泄漏
 *
 * ## 集成点
 * - ServerManager.callTool() 中调用 recordCall() 和 predict()
 * - ServerManager.callTool() 前检查 getCachedResult() 使用缓存
 */

import { log } from '../logger/Logger'
import {
  BEHAVIOR_PREDICTOR_WINDOW_SIZE,
  BEHAVIOR_PREDICTOR_MIN_SEQUENCE_LENGTH,
  BEHAVIOR_PREDICTOR_MIN_PATTERN_FREQUENCY,
  BEHAVIOR_PREDICTOR_PRELOAD_TTL_MS,
  BEHAVIOR_PREDICTOR_PRELOAD_CACHE_MAX,
  BEHAVIOR_PREDICTOR_PRELOAD_TIMEOUT_MS,
  BEHAVIOR_PREDICTOR_MAX_CONCURRENT_PRELOADS,
} from '../config'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 单次工具调用记录 */
export interface CallRecord {
  toolName: string
  /** 参数的关键摘要（用于缓存键和上下文匹配） */
  argSignature: string
  /** 调用耗时（毫秒），0 表示初始记录时未知 */
  durationMs: number
  /** 时间戳 */
  timestamp: number
  /** 是否成功 */
  success: boolean
}

/** 工具序列模式的描述 */
interface PatternRecord {
  /** 模式签名：工具名序列，如 "read_file→grep→write_file" */
  signature: string
  /** 序列长度 */
  length: number
  /** 最后一项为预测目标：signature 中最后一个工具名 */
  targetTool: string
  /** 该模式出现次数 */
  frequency: number
  /** 最后观测时间 */
  lastObserved: number
  /** 平均调用间隔（毫秒） */
  avgIntervalMs: number
  /** 该模式是否成功（所有调用均成功才算） */
  allSuccess: boolean
}

/** 预测结果 */
export interface PredictionResult {
  /** 预测的下一个工具名 */
  toolName: string
  /** 置信度 (0-1) */
  confidence: number
  /** 匹配的模式签名 */
  matchedPattern: string
  /** 预测来源：序列模式 */
  source: 'sequence'
}

/** 预加载缓存条目 */
interface PreloadEntry {
  /** 缓存的工具调用结果文本 */
  result: string
  /** 创建时间 */
  createdAt: number
  /** 过期间戳 */
  expiresAt: number
}

// ══════════════════════════════════════════
//  默认配置
// ══════════════════════════════════════════

export const DEFAULT_CONFIG = {
  /** 滑动窗口大小（最近 N 次调用用于模式构建） */
  WINDOW_SIZE: 12,
  /** 模式中最小序列长度（小于此值不构成有意义模式） */
  MIN_SEQUENCE_LENGTH: 2,
  /** 模式中最大序列长度（防止过拟合长尾模式） */
  MAX_SEQUENCE_LENGTH: 5,
  /** 模式被认定为有效的最小出现次数 */
  MIN_PATTERN_FREQUENCY: 2,
  /** 置信度阈值：高于此值才触发预加载 */
  PRELOAD_CONFIDENCE_THRESHOLD: 0.35,
  /** 预加载结果的 TTL（毫秒） */
  PRELOAD_TTL_MS: 120_000,
  /** 预加载缓存最大条目数 */
  PRELOAD_CACHE_MAX: 50,
  /** 异步预加载超时（毫秒） */
  PRELOAD_TIMEOUT_MS: 10_000,
  /** 最多同时进行的预加载任务数 */
  MAX_CONCURRENT_PRELOADS: 3,
  /** 模式频率置信度缩放因子 */
  CONFIDENCE_FREQ_SCALE: 0.4,
  /** 模式近因置信度缩放因子 */
  CONFIDENCE_RECENCY_SCALE: 0.3,
  /** 模式长度置信度缩放因子（较长序列预测更可靠） */
  CONFIDENCE_LENGTH_SCALE: 0.3,
  /** 近因衰减半衰期（毫秒） */
  RECENCY_HALF_LIFE_MS: 600_000,
}

// ══════════════════════════════════════════
//  BehaviorPredictor 实现
// ══════════════════════════════════════════

export class BehaviorPredictor {
  // 滑动窗口：最近 N 次调用
  private recentCalls: CallRecord[] = []
  // 模式库：signature → PatternRecord
  private patterns = new Map<string, PatternRecord>()
  // 预加载缓存：cacheKey → PreloadEntry
  private preloadCache = new Map<string, PreloadEntry>()
  // 正在进行的预加载任务 (Set 用于去重 + 计数)
  private activePreloads = new Set<string>()
  // 配置（可覆盖默认值）
  private config: typeof DEFAULT_CONFIG

  // 构造函数计时归零
  private startupTime: number

  constructor(config?: Partial<typeof DEFAULT_CONFIG>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.startupTime = Date.now()
  }

  // ══════════════════════════════════════════
  //  核心 API
  // ══════════════════════════════════════════

  /**
   * 记录一次工具调用。
   * 会更新滑动窗口，重新构建模式库，触发预测 chain。
   */
  recordCall(
    toolName: string,
    args: Record<string, any>,
    durationMs: number,
    success: boolean,
  ): void {
    const argSignature = this.buildArgSignature(args)
    const now = Date.now()

    // 记录本次调用
    this.recentCalls.push({
      toolName,
      argSignature,
      durationMs,
      timestamp: now,
      success,
    })

    // 维护窗口大小
    if (this.recentCalls.length > this.config.WINDOW_SIZE) {
      this.recentCalls.shift()
    }

    // 增量更新模式
    this.updatePatterns(toolName, success, now)

    log('INFO', 'behavior_predictor_recorded', {
      tool: toolName,
      windowSize: this.recentCalls.length,
      patternCount: this.patterns.size,
    })
  }

  /**
   * 基于最近上下文预测下一个可能调用的工具。
   * 返回按置信度降序的预测列表。
   */
  predict(toolName: string): PredictionResult[] {
    if (this.recentCalls.length < this.config.MIN_SEQUENCE_LENGTH) {
      return []
    }

    // 构建当前上下文：以当前 toolName 结尾的最近调用序列
    const context = this.buildContextFromCalls(toolName)
    if (!context || context.length < this.config.MIN_SEQUENCE_LENGTH) {
      return []
    }

    const predictions: PredictionResult[] = []

    // 检查所有可能的模式前缀
    // 从最长前缀开始匹配（优先匹配更具体的模式）
    for (let len = Math.min(context.length, this.config.MAX_SEQUENCE_LENGTH); len >= this.config.MIN_SEQUENCE_LENGTH; len--) {
      const prefix = context.slice(-len).join('→')
      // 查找以此前缀开头的模式
      for (const [, pattern] of this.patterns) {
        if (!pattern.signature.startsWith(prefix + '→')) continue
        const remaining = pattern.signature.slice(prefix.length + 1) // 去掉"prefix→"
        // 只取紧接着的一个工具预测（不跨多步）
        const nextTool = remaining.split('→')[0]
        if (!nextTool) continue

        const confidence = this.computeConfidence(pattern)
        if (confidence > 0) {
          predictions.push({
            toolName: nextTool,
            confidence,
            matchedPattern: pattern.signature,
            source: 'sequence',
          })
        }
      }
    }

    // 按置信度降序排列
    predictions.sort((a, b) => b.confidence - a.confidence)

    // 去重（相同预测工具保留最高置信度）
    const seen = new Set<string>()
    const deduped: PredictionResult[] = []
    for (const p of predictions) {
      if (!seen.has(p.toolName)) {
        seen.add(p.toolName)
        deduped.push(p)
      }
    }

    if (deduped.length > 0) {
      log('INFO', 'behavior_predictor_prediction', {
        currentTool: toolName,
        top: deduped.slice(0, 3).map((p) => `${p.toolName}(${(p.confidence * 100).toFixed(0)}%)`).join(', '),
        total: deduped.length,
      })
    }

    return deduped
  }

  /**
   * 异步预加载预测到的工具。
   * 由外部调用，传入工具所在的 serverName 和执行函数。
   */
  async preloadTool(
    cacheKey: string,
    serverName: string,
    toolName: string,
    args: Record<string, any>,
    executor: (name: string, args: Record<string, any>) => Promise<string>,
  ): Promise<void> {
    // 已在缓存中 → 跳过
    if (this.preloadCache.has(cacheKey)) return
    // 已有活跃的预加载任务 → 跳过
    if (this.activePreloads.has(cacheKey)) return

    // 限制并发数
    if (this.activePreloads.size >= this.config.MAX_CONCURRENT_PRELOADS) {
      log('DEBUG', 'behavior_predictor_preload_throttled', {
        tool: toolName,
        activeCount: this.activePreloads.size,
      })
      return
    }

    this.activePreloads.add(cacheKey)
    log('INFO', 'behavior_predictor_preload_start', {
      tool: toolName,
      server: serverName,
      cacheKey,
    })

    try {
      const result = await this.executePreloadWithTimeout(toolName, args, executor)
      if (result !== null) {
        this.preloadCache.set(cacheKey, {
          result,
          createdAt: Date.now(),
          expiresAt: Date.now() + this.config.PRELOAD_TTL_MS,
        })
        // 维护缓存上限
        this.evictPreloadCache()

        log('INFO', 'behavior_predictor_preload_complete', {
          tool: toolName,
          resultSize: result.length,
        })
      }
    } catch (err: any) {
      // 预加载失败不会污染正常的工具调用，仅记录日志
      log('WARN', 'behavior_predictor_preload_failed', {
        tool: toolName,
        error: err.message?.slice(0, 200) || String(err),
      })
    } finally {
      this.activePreloads.delete(cacheKey)
    }
  }

  /**
   * 检查预加载缓存中是否已有结果。
   * 如果命中的缓存已过期，自动清理并返回 null。
   */
  getCachedResult(cacheKey: string): string | null {
    const entry = this.preloadCache.get(cacheKey)
    if (!entry) return null

    if (Date.now() > entry.expiresAt) {
      this.preloadCache.delete(cacheKey)
      log('DEBUG', 'behavior_predictor_cache_expired', { cacheKey })
      return null
    }

    log('INFO', 'behavior_predictor_cache_hit', { cacheKey })
    return entry.result
  }

  /**
   * 构建缓存键，用于工具名+参数签名的唯一标识。
   * 外部调用者可以直接调用此方法生成一致的键。
   */
  buildCacheKey(toolName: string, args: Record<string, any>): string {
    const sig = this.buildArgSignature(args)
    return `${toolName}|${sig}`
  }

  // ══════════════════════════════════════════
  //  内部：模式构建与更新
  // ══════════════════════════════════════════

  /**
   * 从最近调用窗口更新模式库。
   * 每次有新调用时，从窗口末尾提取所有长度的子序列。
   */
  private updatePatterns(lastTool: string, success: boolean, now: number): void {
    if (this.recentCalls.length < this.config.MIN_SEQUENCE_LENGTH) return

    // 以最后一个工具结尾，提取长度 2..MIN(MAX, window) 的子序列
    const maxLen = Math.min(this.config.MAX_SEQUENCE_LENGTH, this.recentCalls.length)
    // 从窗口末尾向前取子序列
    for (let len = this.config.MIN_SEQUENCE_LENGTH; len <= maxLen; len++) {
      if (this.recentCalls.length < len) break
      const sequence = this.recentCalls.slice(-len)
      const toolSequence = sequence.map((c) => c.toolName)
      const signature = toolSequence.join('→')
      const intervals = this.computeIntervals(sequence)

      const existing = this.patterns.get(signature)
      if (existing) {
        existing.frequency++
        existing.lastObserved = now
        existing.avgIntervalMs = (existing.avgIntervalMs * (existing.frequency - 1) + intervals) / existing.frequency
        if (!success) existing.allSuccess = false
      } else {
        this.patterns.set(signature, {
          signature,
          length: len,
          targetTool: toolSequence[toolSequence.length - 1],
          frequency: 1,
          lastObserved: now,
          avgIntervalMs: intervals,
          allSuccess: success,
        })
      }
    }

    // 定期裁剪低频模式
    if (this.patterns.size > 100) {
      this.prunePatterns()
    }
  }

  /**
   * 从最近调用序列构建上下文前缀（用于模式匹配）。
   * 以当前调用的 toolName 结尾，提取 MAX_SEQUENCE_LENGTH 长度的前缀。
   */
  private buildContextFromCalls(currentTool: string): string[] | null {
    // 找到当前工具在窗口中的位置（可能有多次出现）
    const indices: number[] = []
    for (let i = 0; i < this.recentCalls.length; i++) {
      if (this.recentCalls[i].toolName === currentTool) {
        indices.push(i)
      }
    }

    if (indices.length === 0) return null

    // 使用最近一次匹配
    const lastIdx = indices[indices.length - 1]

    // 从开始到 lastIdx（含）的序列
    const context = this.recentCalls.slice(0, lastIdx + 1).map((c) => c.toolName)
    return context
  }

  // ══════════════════════════════════════════
  //  内部：置信度计算
  // ══════════════════════════════════════════

  /**
   * 计算模式置信度。
   * 综合考量：频率、近因性、序列长度、成功率。
   */
  private computeConfidence(pattern: PatternRecord): number {
    // 频率因子：出现次数越多越可信
    const freqScore = Math.min(pattern.frequency / 10, 1) // 10 次以上饱和

    // 近因因子：近期出现的模式更可信
    const ageMs = Date.now() - pattern.lastObserved
    const recencyScore = Math.exp(-ageMs / this.config.RECENCY_HALF_LIFE_MS)

    // 长度因子：较长序列更可靠（降低偶然性）
    const lengthScore = Math.min((pattern.length - 1) / (this.config.MAX_SEQUENCE_LENGTH - 1), 1)

    // 成功率惩罚
    const successPenalty = pattern.allSuccess ? 1.0 : 0.7

    const confidence =
      freqScore * this.config.CONFIDENCE_FREQ_SCALE +
      recencyScore * this.config.CONFIDENCE_RECENCY_SCALE +
      lengthScore * this.config.CONFIDENCE_LENGTH_SCALE

    // 归一化到 [0, 1]，乘以成功率惩罚
    const normalized = Math.min(confidence / (this.config.CONFIDENCE_FREQ_SCALE + this.config.CONFIDENCE_RECENCY_SCALE + this.config.CONFIDENCE_LENGTH_SCALE), 1)
    return Math.round(normalized * successPenalty * 100) / 100
  }

  // ══════════════════════════════════════════
  //  内部：缓存管理
  // ══════════════════════════════════════════

  /**
   * 清理预加载缓存中过期的条目和（必要时）最旧的条目。
   */
  private evictPreloadCache(): void {
    const now = Date.now()
    // 先清理过期条目
    for (const [key, entry] of this.preloadCache) {
      if (now > entry.expiresAt) {
        this.preloadCache.delete(key)
      }
    }

    // 如果仍然超出限制，删除最旧的条目
    if (this.preloadCache.size > this.config.PRELOAD_CACHE_MAX) {
      const entries = [...this.preloadCache.entries()]
        .sort((a, b) => a[1].createdAt - b[1].createdAt)
      const toRemove = this.preloadCache.size - this.config.PRELOAD_CACHE_MAX
      for (let i = 0; i < toRemove; i++) {
        this.preloadCache.delete(entries[i][0])
      }
    }
  }

  // ══════════════════════════════════════════
  //  内部：模式库维护
  // ══════════════════════════════════════════

  /**
   * 裁剪低频和过期的模式，防止模式库无限增长。
   */
  private prunePatterns(): void {
    const now = Date.now()
    const toDelete: string[] = []
    for (const [sig, pattern] of this.patterns) {
      // 删除出现次数少于阈值的模式
      if (pattern.frequency < this.config.MIN_PATTERN_FREQUENCY) {
        toDelete.push(sig)
        continue
      }
      // 删除过久未观测的模式（超过 24 小时）
      if (now - pattern.lastObserved > 24 * 60 * 60 * 1000) {
        toDelete.push(sig)
      }
    }
    for (const sig of toDelete) {
      this.patterns.delete(sig)
    }
    if (toDelete.length > 0) {
      log('INFO', 'behavior_predictor_patterns_pruned', {
        removed: toDelete.length,
        remaining: this.patterns.size,
      })
    }
  }

  // ══════════════════════════════════════════
  //  内部：工具方法
  // ══════════════════════════════════════════

  /**
   * 从工具参数中构建简短的签名，用于缓存键和上下文匹配。
   */
  private buildArgSignature(args: Record<string, any>): string {
    const parts: string[] = []
    for (const [key, value] of Object.entries(args)) {
      if (key.startsWith('_')) continue // 跳过元数据参数
      if (typeof value === 'string') {
        // 取前 40 个字符
        parts.push(`${key}=${value.slice(0, 40)}`)
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        parts.push(`${key}=${String(value)}`)
      }
    }
    return parts.sort().join('&')
  }

  /**
   * 计算序列中相邻调用的平均间隔（毫秒）。
   */
  private computeIntervals(sequence: CallRecord[]): number {
    if (sequence.length < 2) return 0
    let total = 0
    for (let i = 1; i < sequence.length; i++) {
      total += sequence[i].timestamp - sequence[i - 1].timestamp
    }
    return total / (sequence.length - 1)
  }

  /**
   * 执行预加载，带超时保护。
   */
  private async executePreloadWithTimeout(
    toolName: string,
    args: Record<string, any>,
    executor: (name: string, args: Record<string, any>) => Promise<string>,
  ): Promise<string | null> {
    const timeoutPromise = new Promise<null>((_, reject) => {
      setTimeout(
        () => reject(new Error(`Preload timeout after ${this.config.PRELOAD_TIMEOUT_MS}ms`)),
        this.config.PRELOAD_TIMEOUT_MS,
      )
    })

    const result = await Promise.race([
      executor(toolName, args),
      timeoutPromise,
    ])
    return result
  }

  // ══════════════════════════════════════════
  //  调试与统计 API
  // ══════════════════════════════════════════

  /** 获取当前模式库的快照（用于调试） */
  getPatternSnapshot(): Array<{ signature: string; frequency: number; confidence: number }> {
    return [...this.patterns.values()]
      .map((p) => ({
        signature: p.signature,
        frequency: p.frequency,
        confidence: this.computeConfidence(p),
      }))
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 20)
  }

  /** 获取预加载缓存统计 */
  getCacheStats(): { size: number; activePreloads: number } {
    return {
      size: this.preloadCache.size,
      activePreloads: this.activePreloads.size,
    }
  }

  /** 获取最近调用的快照 */
  getRecentCalls(): CallRecord[] {
    return [...this.recentCalls]
  }
}

// ══════════════════════════════════════════
//  全局单例
// ══════════════════════════════════════════

export const behaviorPredictor = new BehaviorPredictor({
  WINDOW_SIZE: BEHAVIOR_PREDICTOR_WINDOW_SIZE,
  MIN_SEQUENCE_LENGTH: BEHAVIOR_PREDICTOR_MIN_SEQUENCE_LENGTH,
  MIN_PATTERN_FREQUENCY: BEHAVIOR_PREDICTOR_MIN_PATTERN_FREQUENCY,
  PRELOAD_TTL_MS: BEHAVIOR_PREDICTOR_PRELOAD_TTL_MS,
  PRELOAD_CACHE_MAX: BEHAVIOR_PREDICTOR_PRELOAD_CACHE_MAX,
  PRELOAD_TIMEOUT_MS: BEHAVIOR_PREDICTOR_PRELOAD_TIMEOUT_MS,
  MAX_CONCURRENT_PRELOADS: BEHAVIOR_PREDICTOR_MAX_CONCURRENT_PRELOADS,
})
