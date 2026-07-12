/**
 * ToolFallbackRegistry — 工具回退注册表
 *
 * 维护主工具 → 备选工具的映射关系，支持：
 * 1. 内置默认回退规则（硬编码，编译时确定）
 * 2. 用户自定义回退规则（运行时注册，可持久化）
 * 3. 运行时规则启用/禁用
 * 4. 条件匹配（按错误类型或错误消息模式）
 *
 * 与 ToolDegradationConfig 的关系：
 * - ToolDegradationConfig 定义数据结构和默认配置
 * - ToolFallbackRegistry 是运行时可变的规则容器
 * - DEGRADATION_RULES 环境变量可用于覆盖默认规则
 */

import { log } from '../logger/Logger'
import { ToolErrorType } from './ToolErrorType'
import {
  type DegradationRule,
  type DegradationConfig,
  DEFAULT_DEGRADATION_CONFIG,
  findMatchingRules,
} from './ToolDegradationConfig'

// =============================================================================
// 回退建议
// =============================================================================

export interface FallbackSuggestion {
  /** 回退规则 */
  rule: DegradationRule
  /** 是否启用 */
  enabled: boolean
  /** 当前尝试次数（从 0 开始） */
  attemptCount: number
  /** 最大回退重试次数 */
  maxRetries: number
  /** 退避基数（毫秒） */
  backoffMs: number
}

// =============================================================================
// ToolFallbackRegistry
// =============================================================================

export class ToolFallbackRegistry {
  /** 所有规则（内置 + 用户自定义） */
  private rules: DegradationRule[] = []
  /** 规则生成 ID 计数器 */
  private nextRuleId = 1
  /** 回退跟踪：primaryTool → FallbackSuggestion */
  private activeFallbacks = new Map<string, FallbackSuggestion>()
  /** 是否已加载默认规则 */
  private defaultsLoaded = false

  constructor(config?: Partial<DegradationConfig>) {
    if (config?.rules) {
      this.rules = config.rules.map((r) => this.normalizeRule(r))
    }
  }

  /**
   * 确保默认规则已加载（惰性，避免构造时副作用）
   */
  private ensureDefaults(): void {
    if (this.defaultsLoaded) return
    this.defaultsLoaded = true

    // 使用 DEFAULT_DEGRADATION_CONFIG 中的规则
    for (const rule of DEFAULT_DEGRADATION_CONFIG.rules) {
      this.addRule(rule)
    }

    log('INFO', 'fallback_defaults_loaded', { count: DEFAULT_DEGRADATION_CONFIG.rules.length })
  }

  /**
   * 规范化规则：填充 ID 和默认值
   */
  private normalizeRule(rule: DegradationRule): DegradationRule {
    return {
      ...rule,
      id: rule.id || `fb_${this.nextRuleId++}`,
      maxFallbackRetries: rule.maxFallbackRetries ?? 1,
      fallbackBackoffMs: rule.fallbackBackoffMs ?? 500,
      enabled: rule.enabled ?? true,
    }
  }

  // =========================================================================
  // 规则管理
  // =========================================================================

  /**
   * 注册一条降级规则。
   * 如果规则不含 ID，自动生成唯一 ID。
   * 如果已有同 primaryTool + fallbackTool + condition 的规则，覆盖之。
   */
  addRule(rule: DegradationRule): string {
    const normalized = this.normalizeRule(rule)

    // 去重：同主工具 + 备选工具 + 条件类型的规则替换旧规则
    const existingIdx = this.rules.findIndex(
      (r) =>
        r.primaryTool === normalized.primaryTool &&
        r.fallbackTool === normalized.fallbackTool &&
        r.condition.type === normalized.condition.type &&
        (normalized.condition.type !== 'specific_error' ||
          (r.condition as any).errorType === (normalized.condition as any).errorType),
    )

    if (existingIdx >= 0) {
      // 保留原始 ID 覆盖其他字段
      const existingId = this.rules[existingIdx].id
      this.rules[existingIdx] = { ...normalized, id: existingId }
      log('INFO', 'fallback_rule_updated', {
        primary: normalized.primaryTool,
        fallback: normalized.fallbackTool,
        id: existingId,
      })
      return existingId!
    }

    this.rules.push(normalized)
    log('INFO', 'fallback_rule_added', {
      primary: normalized.primaryTool,
      fallback: normalized.fallbackTool,
      id: normalized.id,
    })
    return normalized.id!
  }

  /**
   * 移除一条规则
   */
  removeRule(ruleId: string): boolean {
    const idx = this.rules.findIndex((r) => r.id === ruleId)
    if (idx < 0) return false
    this.rules.splice(idx, 1)
    log('INFO', 'fallback_rule_removed', { id: ruleId })
    return true
  }

  /**
   * 启用/禁用一条规则
   */
  setRuleEnabled(ruleId: string, enabled: boolean): boolean {
    const rule = this.rules.find((r) => r.id === ruleId)
    if (!rule) return false
    rule.enabled = enabled
    log('INFO', 'fallback_rule_toggled', { id: ruleId, enabled })
    return true
  }

  /**
   * 清除所有规则（包括内置）
   */
  clearRules(): void {
    this.rules = []
    this.activeFallbacks.clear()
    this.defaultsLoaded = false
    log('INFO', 'fallback_rules_cleared')
  }

  // =========================================================================
  // 查询
  // =========================================================================

  /**
   * 获取指定主工具的所有匹配回退规则。
   * 按条件精度排序，仅返回已启用的规则。
   */
  getFallbacks(
    primaryTool: string,
    errorType?: ToolErrorType,
    errorMessage?: string,
  ): DegradationRule[] {
    this.ensureDefaults()

    if (errorType && errorMessage) {
      return findMatchingRules(this.rules, primaryTool, errorType, errorMessage)
    }

    // 无条件时返回所有匹配主工具的已启用规则，按 any_error 降序
    return this.rules
      .filter((r) => r.primaryTool === primaryTool && r.enabled !== false)
      .sort((a, b) => {
        const order = { 'specific_error': 0, 'error_pattern': 1, 'any_error': 2 }
        const orderA = order[a.condition.type as keyof typeof order] ?? 3
        const orderB = order[b.condition.type as keyof typeof order] ?? 3
        return orderA - orderB
      })
  }

  /**
   * 检查是否有任何匹配的回退规则
   */
  hasFallback(primaryTool: string, errorType?: ToolErrorType, errorMessage?: string): boolean {
    return this.getFallbacks(primaryTool, errorType, errorMessage).length > 0
  }

  /**
   * 获取所有已注册的规则（快照）
   */
  getAllRules(): ReadonlyArray<DegradationRule> {
    this.ensureDefaults()
    return [...this.rules]
  }

  /**
   * 获取所有已启用的规则
   */
  getEnabledRules(): DegradationRule[] {
    return this.getAllRules().filter((r) => r.enabled !== false)
  }

  // =========================================================================
  // 回退执行跟踪
  // =========================================================================

  /**
   * 开始跟踪一次回退尝试。
   * 返回 FallbackSuggestion，调用者应据此执行备选工具。
   * 如果回退链深度超过 maxFallbackChainDepth，返回 null。
   */
  beginFallback(
    primaryTool: string,
    errorType?: ToolErrorType,
    errorMessage?: string,
    maxChainDepth: number = 2,
  ): FallbackSuggestion | null {
    const rules = this.getFallbacks(primaryTool, errorType, errorMessage)
    if (rules.length === 0) return null

    const rule = rules[0] // 取最匹配的规则

    // 检查回退链深度
    const chainDepth = this.getFallbackChainDepth(primaryTool)
    if (chainDepth >= maxChainDepth) {
      log('WARN', 'fallback_chain_depth_exceeded', {
        primary: primaryTool,
        fallback: rule.fallbackTool,
        chainDepth,
        maxChainDepth,
      })
      return null
    }

    const suggestion: FallbackSuggestion = {
      rule,
      enabled: rule.enabled !== false,
      attemptCount: 0,
      maxRetries: rule.maxFallbackRetries ?? 1,
      backoffMs: rule.fallbackBackoffMs ?? 500,
    }

    this.activeFallbacks.set(primaryTool, suggestion)
    return suggestion
  }

  /**
   * 递增回退尝试计数。
   * 返回 true 如果还有剩余重试次数。
   */
  incrementFallbackAttempt(primaryTool: string): boolean {
    const fb = this.activeFallbacks.get(primaryTool)
    if (!fb) return false
    fb.attemptCount++
    return fb.attemptCount <= fb.maxRetries
  }

  /**
   * 结束回退跟踪
   */
  endFallback(primaryTool: string): void {
    this.activeFallbacks.delete(primaryTool)
  }

  /**
   * 获取回退链深度（A→B 深度为 1，B→C 深度为 2）
   */
  private getFallbackChainDepth(toolName: string): number {
    let depth = 0
    let current = toolName
    for (let i = 0; i < 10; i++) {
      const fb = this.activeFallbacks.get(current)
      if (!fb) break
      depth++
      current = fb.rule.fallbackTool
    }
    return depth
  }

  /**
   * 获取当前活跃的回退跟踪（快照，调试用）
   */
  getActiveFallbacks(): Map<string, FallbackSuggestion> {
    return new Map(this.activeFallbacks)
  }
}

// =============================================================================
// 全局单例
// =============================================================================

export const toolFallbackRegistry = new ToolFallbackRegistry()
