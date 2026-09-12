/**
 * TtsEngineFallback — TTS 引擎回退注册表
 *
 * MCP 模式迁移：从 ToolFallbackRegistry + ToolDegradationConfig（src/main/tool/）迁移
 *
 * ToolFallbackRegistry 解决的问题：
 *   MCP 工具执行失败时，需要一种可配置的机制自动切换到备选工具。
 *   硬编码的 if-else 条件链难以维护和扩展，且无法在运行时调整。
 *   通过 DegradationRule 的 condition 匹配（any_error / specific_error / error_pattern）
 *   和 FallbackSuggestion 的链式回退管理，达到可配置的自动降级。
 *
 * TTS 中的相同问题：
 *   TTS 引擎（Piper、edge-tts）合成失败时，目前只有 ad-hoc 的重试和模型级回退：
 *   - PiperOrchestrator.processOneWithResult() 有模型级回退（主模型→默认模型）
 *   - TtsService._synthesize() 有 attempt 重试计数（最多 2 次）
 *   - 缺少引擎间回退（Piper 失败 → edge-tts，反之亦然）
 *   - 缺少条件匹配（网络超时 → 换本地引擎，进程崩溃 → 换云端引擎）
 *   - 缺少可配置的规则
 *
 * 适配差异：
 * - ToolFallbackRegistry 以 toolName 为主键映射（read_file → read_multiple_files）
 * - TtsEngineFallback 以 engine 名为主键映射（piper → edge-tts, edge-tts → piper）
 * - condition 类型使用 TtsErrorType 而非 ToolErrorType
 * - 合并 DegradationConfig 的策略配置，简化适应度
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { TtsErrorType, isTtsErrorRecoverable, shouldFallbackToOtherEngine } from './TtsErrorType'

// ════════════════════════════════════════════════════════════════
//  类型定义
// ════════════════════════════════════════════════════════════════

/** TTS 引擎标识 */
export type TtsEngineId = 'piper' | 'edge-tts'

/** 所有可用引擎列表 */
export const ALL_TTS_ENGINES: TtsEngineId[] = ['piper', 'edge-tts']

/**
 * 回退触发条件。
 *
 * 与 ToolDegradationConfig.DegradationCondition 的模式一致，
 * 但使用 TtsErrorType 替代 ToolErrorType。
 */
export type TtsFallbackCondition = { type: 'any_error' } | { type: 'specific_error'; errorType: TtsErrorType }

/**
 * TTS 引擎回退规则。
 *
 * 与 ToolDegradationRule 的模式一致，但引擎为主题而非工具。
 */
export interface TtsFallbackRule {
  /** 规则唯一 ID（自动生成） */
  readonly id?: string
  /** 主引擎（触发回退的引擎） */
  primaryEngine: TtsEngineId
  /** 备选引擎 */
  fallbackEngine: TtsEngineId
  /** 触发条件 */
  condition: TtsFallbackCondition
  /** 最大重试次数（0 = 不重试，仅一次回退） */
  maxRetries?: number
  /** 规则描述 */
  description?: string
  /** 是否启用，默认 true */
  enabled?: boolean
}

/**
 * TTS 引擎降级策略选项。
 *
 * 与 ToolDegradationConfig.DegradationStrategy 的模式一致。
 */
export interface TtsDegradationStrategy {
  /** 启用自动降级，默认 true */
  autoDegradation: boolean
  /** 启用自动重试，默认 true */
  autoRetry: boolean
  /** 最大回退链深度（piper→edge-tts 深度为 1），默认 1 */
  maxFallbackChainDepth: number
  /** 降级时是否记录详细日志，默认 true */
  verboseLogging: boolean
}

/** TTS 引擎回退配置 */
export interface TtsEngineFallbackConfig {
  strategy: TtsDegradationStrategy
  rules: TtsFallbackRule[]
}

/**
 * 回退尝试跟踪信息。
 *
 * 与 ToolFallbackRegistry.FallbackSuggestion 的模式一致。
 */
export interface TtsFallbackAttempt {
  /** 匹配的回退规则 */
  rule: TtsFallbackRule
  /** 当前尝试次数 */
  attemptCount: number
  /** 最大重试次数 */
  maxRetries: number
  /** 是否启用 */
  enabled: boolean
}

// ════════════════════════════════════════════════════════════════
//  默认配置
// ════════════════════════════════════════════════════════════════

const DEFAULT_STRATEGY: TtsDegradationStrategy = {
  autoDegradation: true,
  autoRetry: true,
  maxFallbackChainDepth: 1,
  verboseLogging: true,
}

/**
 * 内置默认回退规则。
 *
 * 回退原则：
 * - Piper 引擎不可用或超时 → 切换到 edge-tts（云端兜底）
 * - edge-tts 网络失败或超时 → 切换到 Piper（本地兜底）
 * - Piper 合成失败 → 先引擎内重试，再切换到 edge-tts
 * - edge-tts 合成失败 → 先引擎内重试，再切换到 Piper
 * - 输入参数错误 → 不触发回退（重试同样失败）
 */
const DEFAULT_RULES: TtsFallbackRule[] = [
  // ── Piper → edge-tts ──
  {
    primaryEngine: 'piper',
    fallbackEngine: 'edge-tts',
    condition: { type: 'specific_error', errorType: TtsErrorType.ENGINE_UNAVAILABLE },
    maxRetries: 0,
    description: 'Piper 引擎不可用时切换到 edge-tts 云端引擎',
  },
  {
    primaryEngine: 'piper',
    fallbackEngine: 'edge-tts',
    condition: { type: 'specific_error', errorType: TtsErrorType.TIMEOUT },
    maxRetries: 1,
    description: 'Piper 合成超时，先同级重试一次，仍超时则切换到 edge-tts',
  },
  {
    primaryEngine: 'piper',
    fallbackEngine: 'edge-tts',
    condition: { type: 'any_error' },
    maxRetries: 1,
    description: 'Piper 合成失败时先重试一次，仍失败则切换到 edge-tts',
  },
  // ── edge-tts → Piper ──
  {
    primaryEngine: 'edge-tts',
    fallbackEngine: 'piper',
    condition: { type: 'specific_error', errorType: TtsErrorType.NETWORK },
    maxRetries: 0,
    description: 'edge-tts 网络不可用时切换到 Piper 本地引擎',
  },
  {
    primaryEngine: 'edge-tts',
    fallbackEngine: 'piper',
    condition: { type: 'specific_error', errorType: TtsErrorType.TIMEOUT },
    maxRetries: 1,
    description: 'edge-tts 超时，先重试一次，仍超时则切换到 Piper',
  },
  {
    primaryEngine: 'edge-tts',
    fallbackEngine: 'piper',
    condition: { type: 'any_error' },
    maxRetries: 1,
    description: 'edge-tts 合成失败时先重试一次，仍失败则切换到 Piper',
  },
]

export const DEFAULT_TTS_FALLBACK_CONFIG: TtsEngineFallbackConfig = {
  strategy: DEFAULT_STRATEGY,
  rules: DEFAULT_RULES,
}

// ════════════════════════════════════════════════════════════════
//  辅助函数
// ════════════════════════════════════════════════════════════════

/**
 * 查找匹配的回退规则。
 *
 * 与 ToolDegradationConfig.findMatchingRules() 的模式一致，
 * 但使用 TTS 领域类型。
 *
 * 匹配优先级：specific_error > any_error
 */
export function findMatchingFallbackRules(
  rules: TtsFallbackRule[],
  primaryEngine: TtsEngineId,
  errorType: TtsErrorType,
): TtsFallbackRule[] {
  const matched: TtsFallbackRule[] = []

  for (const rule of rules) {
    if (rule.primaryEngine !== primaryEngine) continue
    if (rule.enabled === false) continue

    const cond = rule.condition
    switch (cond.type) {
      case 'any_error':
        matched.push(rule)
        break
      case 'specific_error':
        if (cond.errorType === errorType) {
          matched.push(rule)
        }
        break
    }
  }

  // 排序：specific_error > any_error（更精确的规则优先）
  const order = { specific_error: 0, any_error: 1 }
  matched.sort((a, b) => {
    const orderA = order[a.condition.type as keyof typeof order] ?? 2
    const orderB = order[b.condition.type as keyof typeof order] ?? 2
    return orderA - orderB
  })

  return matched
}

// ════════════════════════════════════════════════════════════════
//  TtsEngineFallbackRegistry
// ════════════════════════════════════════════════════════════════

export class TtsEngineFallbackRegistry {
  /** 所有规则（内置 + 用户自定义） */
  private rules: TtsFallbackRule[] = []
  /** 规则 ID 计数器 */
  private nextRuleId = 1
  /** 当前活跃的回退跟踪：primaryEngine → TtsFallbackAttempt */
  private activeFallbacks = new Map<TtsEngineId, TtsFallbackAttempt>()
  /** 策略配置 */
  private strategy: TtsDegradationStrategy
  /** 是否已加载默认规则 */
  private defaultsLoaded = false

  constructor(config?: Partial<TtsEngineFallbackConfig>) {
    this.strategy = config?.strategy ?? { ...DEFAULT_STRATEGY }
    if (config?.rules) {
      this.rules = config.rules.map((r) => this.normalizeRule(r))
    }
  }

  /**
   * 确保默认规则已加载（惰性加载，避免构造时副作用）。
   * 与 ToolFallbackRegistry.ensureDefaults() 的模式一致。
   */
  private ensureDefaults(): void {
    if (this.defaultsLoaded) return
    this.defaultsLoaded = true

    for (const rule of DEFAULT_TTS_FALLBACK_CONFIG.rules) {
      this.addRule(rule)
    }

    log('INFO', 'tts_fallback_defaults_loaded', { count: DEFAULT_TTS_FALLBACK_CONFIG.rules.length })
  }

  /**
   * 规范化规则：填充 ID 和默认值。
   */
  private normalizeRule(rule: TtsFallbackRule): TtsFallbackRule {
    return {
      ...rule,
      id: rule.id || `tts_fb_${this.nextRuleId++}`,
      maxRetries: rule.maxRetries ?? 1,
      enabled: rule.enabled ?? true,
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  规则管理
  // ════════════════════════════════════════════════════════════════

  /**
   * 注册一条回退规则。
   * 如果已有同 primaryEngine + fallbackEngine + condition 的规则，覆盖之。
   */
  addRule(rule: TtsFallbackRule): string {
    this.ensureDefaults()
    const normalized = this.normalizeRule(rule)

    // 去重
    const existingIdx = this.rules.findIndex(
      (r) =>
        r.primaryEngine === normalized.primaryEngine &&
        r.fallbackEngine === normalized.fallbackEngine &&
        r.condition.type === normalized.condition.type &&
        (normalized.condition.type !== 'specific_error' || (r.condition as any).errorType === (normalized.condition as any).errorType),
    )

    if (existingIdx >= 0) {
      const existingId = this.rules[existingIdx].id
      this.rules[existingIdx] = { ...normalized, id: existingId }
      log('INFO', 'tts_fallback_rule_updated', {
        primary: normalized.primaryEngine,
        fallback: normalized.fallbackEngine,
        id: existingId,
      })
      return existingId!
    }

    this.rules.push(normalized)
    log('INFO', 'tts_fallback_rule_added', {
      primary: normalized.primaryEngine,
      fallback: normalized.fallbackEngine,
      id: normalized.id,
    })
    return normalized.id!
  }

  /**
   * 移除一条规则。
   */
  removeRule(ruleId: string): boolean {
    const idx = this.rules.findIndex((r) => r.id === ruleId)
    if (idx < 0) return false
    this.rules.splice(idx, 1)
    log('INFO', 'tts_fallback_rule_removed', { id: ruleId })
    return true
  }

  /**
   * 启用/禁用一条规则。
   */
  setRuleEnabled(ruleId: string, enabled: boolean): boolean {
    const rule = this.rules.find((r) => r.id === ruleId)
    if (!rule) return false
    rule.enabled = enabled
    log('INFO', 'tts_fallback_rule_toggled', { id: ruleId, enabled })
    return true
  }

  /**
   * 清除所有规则（包括内置）。
   */
  clearRules(): void {
    this.rules = []
    this.activeFallbacks.clear()
    this.defaultsLoaded = false
    log('INFO', 'tts_fallback_rules_cleared')
  }

  /**
   * 更新策略配置。
   */
  updateStrategy(partial: Partial<TtsDegradationStrategy>): void {
    this.strategy = { ...this.strategy, ...partial }
    log('INFO', 'tts_fallback_strategy_updated', { ...this.strategy })
  }

  /**
   * 获取当前策略配置。
   */
  getStrategy(): Readonly<TtsDegradationStrategy> {
    return { ...this.strategy }
  }

  /**
   * 获取所有已注册的规则（快照）。
   */
  getAllRules(): ReadonlyArray<TtsFallbackRule> {
    this.ensureDefaults()
    return [...this.rules]
  }

  // ════════════════════════════════════════════════════════════════
  //  回退决策
  // ════════════════════════════════════════════════════════════════

  /**
   * 为失败的引擎查找备选引擎。
   *
   * 与 ToolFallbackRegistry.beginFallback() 的模式一致：
   * 1. 根据 engine + errorType 查找匹配规则
   * 2. 检查回退链深度
   * 3. 创建 FallbackAttempt 跟踪
   *
   * @returns 备选引擎名，如果无可用的回退则返回 null
   */
  getFallback(
    primaryEngine: TtsEngineId,
    errorType: TtsErrorType = TtsErrorType.UNKNOWN,
  ): { fallbackEngine: TtsEngineId; attempt: TtsFallbackAttempt } | null {
    this.ensureDefaults()

    if (!this.strategy.autoDegradation) {
      log('DEBUG', 'tts_fallback_disabled_by_strategy', { primaryEngine })
      return null
    }

    // 不可恢复的错误不触发回退
    if (!isTtsErrorRecoverable(errorType)) {
      log('DEBUG', 'tts_fallback_unrecoverable', { primaryEngine, errorType })
      return null
    }

    // 查找匹配规则
    const matchingRules = findMatchingFallbackRules(this.rules, primaryEngine, errorType)
    if (matchingRules.length === 0) return null

    const rule = matchingRules[0] // 取最匹配的规则

    // 检查回退链深度
    if (this.getFallbackChainDepth(primaryEngine) >= this.strategy.maxFallbackChainDepth) {
      log('WARN', 'tts_fallback_chain_depth_exceeded', {
        primary: primaryEngine,
        fallback: rule.fallbackEngine,
        maxDepth: this.strategy.maxFallbackChainDepth,
      })
      return null
    }

    const attempt: TtsFallbackAttempt = {
      rule,
      attemptCount: 0,
      maxRetries: rule.maxRetries ?? 1,
      enabled: rule.enabled !== false,
    }

    this.activeFallbacks.set(primaryEngine, attempt)

    if (this.strategy.verboseLogging) {
      log('INFO', 'tts_fallback_activated', {
        primary: primaryEngine,
        fallback: rule.fallbackEngine,
        errorType,
        maxRetries: attempt.maxRetries,
      })
    }

    return { fallbackEngine: rule.fallbackEngine, attempt }
  }

  /**
   * 递增回退尝试计数。
   * 返回 true 如果还有剩余重试次数。
   */
  incrementAttempt(primaryEngine: TtsEngineId): boolean {
    const fb = this.activeFallbacks.get(primaryEngine)
    if (!fb) return false
    fb.attemptCount++
    const hasRemaining = fb.attemptCount <= fb.maxRetries
    if (!hasRemaining && this.strategy.verboseLogging) {
      log('INFO', 'tts_fallback_attempts_exhausted', {
        primary: primaryEngine,
        fallback: fb.rule.fallbackEngine,
        attempts: fb.attemptCount,
        maxRetries: fb.maxRetries,
      })
    }
    return hasRemaining
  }

  /**
   * 结束回退跟踪。
   */
  endFallback(primaryEngine: TtsEngineId): void {
    this.activeFallbacks.delete(primaryEngine)
  }

  /**
   * 判断对于给定的错误类型，是否应该先重试同一引擎再考虑跨引擎回退。
   *
   * 与 shouldFallbackToOtherEngine() 配合，决定回退策略：
   * - true：先重试 same engine → 再尝试 fallback engine
   * - false：直接尝试 fallback engine
   */
  shouldRetryBeforeFallback(errorType: TtsErrorType): boolean {
    return !shouldFallbackToOtherEngine(errorType)
  }

  /**
   * 获取当前活跃的回退跟踪（调试用）。
   */
  getActiveFallbacks(): Map<TtsEngineId, TtsFallbackAttempt> {
    return new Map(this.activeFallbacks)
  }

  /**
   * 清除所有活跃回退跟踪。
   */
  clearActiveFallbacks(): void {
    this.activeFallbacks.clear()
  }

  // ════════════════════════════════════════════════════════════════
  //  内部方法
  // ════════════════════════════════════════════════════════════════

  /**
   * 计算回退链深度。
   * Piper → edge-tts 深度为 1（edge-tts 是 Piper 的回退目标时）。
   *
   * 与 ToolFallbackRegistry.getFallbackChainDepth() 的模式一致。
   */
  private getFallbackChainDepth(engineName: TtsEngineId): number {
    let depth = 0
    let current: TtsEngineId | null = engineName
    for (let i = 0; i < 5; i++) {
      const fb = this.activeFallbacks.get(current)
      if (!fb) break
      depth++
      current = fb.rule.fallbackEngine as TtsEngineId
    }
    return depth
  }
}

// ════════════════════════════════════════════════════════════════
//  全局单例
// ════════════════════════════════════════════════════════════════

/** 全局单例，供 TtsService 使用 */
export const ttsEngineFallback = new TtsEngineFallbackRegistry()
