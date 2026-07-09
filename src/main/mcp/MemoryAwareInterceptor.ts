import type { MemoryService } from '../memory/MemoryService'
import { log } from '../logger/Logger'
import type { ToolMemoryDefaults } from './ToolMemoryDefaults'
import {
  MEMORY_TOOL_PERSONALIZATION,
  MEMORY_TOOL_MIN_RECORDS,
  MEMORY_TOOL_BOOST_FACTOR,
  MEMORY_TOOL_STAT_WINDOW,
} from '../config'

/**
 * 从 Memory 中检索到的工具调用上下文。
 * 包含与当前工具调用相关的历史记忆、偏好和操作模式。
 */
export interface MemoryContext {
  /** 相关的事实记忆（用户偏好、历史操作记录等） */
  facts: string[]
  /** 语义相似度评分 (0-1)，与 facts 一一对应 */
  scores: number[]
  /** 是否存在有效的上下文 */
  hasContext: boolean
}

/**
 * 默认值填充结果。
 */
export interface DefaultFillResult {
  /** 填充后的参数 */
  args: Record<string, any>
  /** 被填充的参数列表 */
  filled: Array<{ param: string; value: string; source: string; confidence: number }>
  /** 是否有参数被填充 */
  hasFilled: boolean
}

/**
 * 工具优先级提升信息。
 */
export interface ToolPriorityInfo {
  /** 工具名称 */
  toolName: string
  /** 优先级偏移量（正数表示优先提供给 LLM，越大越优先） */
  boost: number
  /** 调用频次 */
  callCount: number
  /** 成功率 (0-1) */
  successRate: number
}

/** 工具调用统计记录，用于在内存中维护频次和成功率 */
interface ToolStats {
  callCount: number
  successCount: number
  recentCalls: Array<{ success: boolean; timestamp: number }>
}

/**
 * 个性化强度级别枚举。
 */
export type PersonalizationLevel = 'off' | 'conservative' | 'balanced' | 'aggressive'

/**
 * MemoryAwareInterceptor — MCP 工具调用的记忆感知拦截器。
 *
 * ## 功能
 * 1. preCall() — 工具调用前语义检索相关记忆
 * 2. enrichArgs() — 将记忆上下文注入工具参数
 * 3. fillDefaults() — 从用户偏好自动填充未提供的参数默认值
 * 4. postCall() — 工具调用后摘要存入记忆 + 统计频次/成功率
 * 5. getToolPriorities() — 返回基于记忆的工具优先级提升列表
 * 6. recordFeedback() — 用户对推荐结果的反馈纠正
 *
 * ## 生命周期
 *   preCall → enrichArgs → fillDefaults → (tool call) → postCall
 *
 * ## 个性化强度级别
 *   - off: 禁用所有记忆驱动的行为
 *   - conservative: 仅在高置信度时影响（默认）
 *   - balanced: 中等影响
 *   - aggressive: 最大限度优化
 */
export class MemoryAwareInterceptor {
  private memoryService: MemoryService | null = null
  private toolDefaults: ToolMemoryDefaults | null = null

  /** 工具调用统计（工具名 → 统计信息） */
  private toolStats = new Map<string, ToolStats>()

  /** 用户反馈：被标记为"不推荐"的工具及参数模式 */
  private negativeFeedback = new Map<string, Set<string>>()

  /** 个性化强度级别，默认从 config 读取 */
  private personalizationLevel: PersonalizationLevel = MEMORY_TOOL_PERSONALIZATION

  /** 关联 MemoryService 实例 */
  setMemoryService(ms: MemoryService | null): void {
    this.memoryService = ms
  }

  /** 关联 ToolMemoryDefaults 实例用于参数默认值填充 */
  setToolDefaults(td: ToolMemoryDefaults | null): void {
    this.toolDefaults = td
  }

  /** 动态设置个性化强度级别 */
  setPersonalizationLevel(level: PersonalizationLevel): void {
    this.personalizationLevel = level
    log('INFO', 'memory_interceptor_level_set', { level })
  }

  /** 获取当前个性化强度级别 */
  getPersonalizationLevel(): PersonalizationLevel {
    return this.personalizationLevel
  }

  /** 检查个性化是否启用 */
  isEnabled(): boolean {
    return this.personalizationLevel !== 'off'
  }

  /**
   * 获取当前个性化强度对应的 boost 乘数。
   * - off: 0
   * - conservative: boostFactor * 0.5（保守）
   * - balanced: boostFactor * 1.0（标准）
   * - aggressive: boostFactor * 2.0（激进）
   */
  private getEffectiveBoostFactor(): number {
    switch (this.personalizationLevel) {
      case 'off': return 0
      case 'conservative': return Math.round(MEMORY_TOOL_BOOST_FACTOR * 0.5)
      case 'balanced': return MEMORY_TOOL_BOOST_FACTOR
      case 'aggressive': return MEMORY_TOOL_BOOST_FACTOR * 2
    }
  }

  /**
   * 检查是否已收集足够的工具调用数据。
   * 数据不足时自动降级为保守行为，避免噪声推荐。
   */
  private hasSufficientData(): boolean {
    const totalCalls = Array.from(this.toolStats.values())
      .reduce((sum, s) => sum + s.callCount, 0)
    return totalCalls >= MEMORY_TOOL_MIN_RECORDS
  }

  // ══════════════════════════════════════════
  //  工具优先级系统
  // ══════════════════════════════════════════

  /**
   * 获取所有工具基于记忆的优先级提升列表。
   *
   * 综合考虑以下因素：
   * 1. 调用频次（高频工具更可能被再次使用）
   * 2. 成功率（成功率高则提升，低则降级）
   * 3. 用户负面反馈（被用户纠正过的工具降级）
   * 4. Memory 中的用户偏好（用户明确表达偏好的工具提升）
   *
   * @returns 优先级提升列表，按 boost 降序排列
   */
  getToolPriorities(): ToolPriorityInfo[] {
    if (!this.isEnabled() || !this.hasSufficientData()) {
      return []
    }

    const effectiveBoost = this.getEffectiveBoostFactor()
    if (effectiveBoost <= 0) return []

    const priorities: ToolPriorityInfo[] = []

    for (const [toolName, stats] of this.toolStats) {
      const successRate = stats.callCount > 0
        ? stats.successCount / stats.callCount
        : 0

      // 1. 频次因子：调用越多越可能被再次使用
      const freqFactor = Math.min(stats.callCount / MEMORY_TOOL_STAT_WINDOW, 1)

      // 2. 成功率因子：高成功率提升，低成功率降级
      const successFactor = successRate - 0.5 // 基准 0.5，高于则正分

      // 3. 负面反馈降级
      const feedbackPenalty = this.negativeFeedback.has(toolName) ? -2 : 0

      // 综合 boost
      const boost = Math.round(
        effectiveBoost * freqFactor
        + effectiveBoost * successFactor
        + feedbackPenalty
      )

      if (boost !== 0) {
        priorities.push({ toolName, boost, callCount: stats.callCount, successRate })
      }
    }

    // 按 boost 降序
    priorities.sort((a, b) => b.boost - a.boost)
    return priorities
  }

  /**
   * 获取工具的优先级提升值。
   */
  getToolPriority(toolName: string): number {
    const priorities = this.getToolPriorities()
    const match = priorities.find((p) => p.toolName === toolName)
    return match?.boost ?? 0
  }

  /**
   * 获取工具调用统计信息。
   */
  getToolStats(toolName: string): { callCount: number; successCount: number; successRate: number } | null {
    const stats = this.toolStats.get(toolName)
    if (!stats) return null
    return {
      callCount: stats.callCount,
      successCount: stats.successCount,
      successRate: stats.callCount > 0 ? stats.successCount / stats.callCount : 0,
    }
  }

  // ══════════════════════════════════════════
  //  用户反馈机制
  // ══════════════════════════════════════════

  /**
   * 记录用户对工具推荐或参数填充的负面反馈。
   *
   * 当用户明确表示"不要用这个工具"或"我不喜欢这个默认值"时，
   * 记录反馈以在未来降低该工具或参数模式的优先级。
   *
   * @param toolName 相关的工具名
   * @param reason 用户反馈原因（如 'wrong_tool', 'wrong_param', 'wrong_default'）
   * @param details 附加细节（如具体参数名）
   */
  recordFeedback(toolName: string, reason: string, details?: string): void {
    if (!this.toolStats.has(toolName)) return

    // 记录负面反馈（未来降低该工具优先级）
    if (!this.negativeFeedback.has(toolName)) {
      this.negativeFeedback.set(toolName, new Set())
    }
    this.negativeFeedback.get(toolName)!.add(`${reason}${details ? `:${details}` : ''}`)

    // 降级该工具在统计中的成功率（模拟一次失败）
    const stats = this.toolStats.get(toolName)!
    stats.callCount++
    // successCount 不变 → 成功率下降

    // 将负面反馈写入 Memory 作为用户偏好
    if (this.memoryService) {
      const feedbackText = details
        ? `【工具反馈】用户对 ${toolName} 的自动推荐不满意：${reason}（${details}）`
        : `【工具反馈】用户对 ${toolName} 的自动推荐不满意：${reason}`
      this.memoryService.addFact(feedbackText, 0.7)

      // 同时保存为偏好，供 ToolMemoryDefaults 使用
      this.memoryService.saveUserPreference({
        key: `tool_feedback:${toolName}`,
        value: reason,
        confidence: 0.7,
        category: 'preference',
        source: 'memory_interceptor_feedback',
        updatedAt: Date.now(),
      })
    }

    log('INFO', 'memory_interceptor_feedback', {
      tool: toolName,
      reason,
      details,
      feedbackCount: this.negativeFeedback.get(toolName)?.size,
    })
  }

  /**
   * 清除所有用户反馈记录（恢复默认推荐行为）。
   */
  clearFeedback(): void {
    this.negativeFeedback.clear()
    log('INFO', 'memory_interceptor_feedback_cleared')
  }

  // ══════════════════════════════════════════
  //  核心拦截方法
  // ══════════════════════════════════════════

  /**
   * 工具调用前：从 Memory 中语义检索相关上下文。
   *
   * 检索策略：
   *   1. VectorMemory 向量语义搜索（基于 toolName + arg 值构建查询）
   *   2. user_fact 条目关键词匹配补充
   *   3. 去重合并，最多返回 5 条
   *
   * 在 conservative 模式下，仅当置信度 > 0.7 时返回结果。
   */
  preCall(toolName: string, args: Record<string, any>): MemoryContext {
    if (!this.memoryService || !this.isEnabled()) {
      return { facts: [], scores: [], hasContext: false }
    }

    try {
      // 构建语义查询：工具名 + 字符串参数值
      const queryParts: string[] = [toolName]
      for (const [key, value] of Object.entries(args)) {
        if (typeof value === 'string' && value.length > 0 && value.length < 500) {
          // 过滤掉纯路径/URL 中的噪音部分
          const cleaned = value.replace(/[\/\\:]/g, ' ')
          queryParts.push(cleaned)
        }
      }
      const query = queryParts.join(' ')

      // 1. VectorMemory 语义搜索
      const vectorResults = this.memoryService.vector.querySync(query, 5)

      // 2. user_fact 关键词匹配（捕获向量搜索遗漏的精确匹配）
      const userFacts = this.memoryService
        .getEntries()
        .filter((e) => e.type === 'user_fact')
        .map((e) => e.content)

      const queryLower = query.toLowerCase()
      const keywordScored = userFacts
        .map((content) => {
          const contentLower = content.toLowerCase()
          let score = 0
          // 工具名匹配权重最高
          if (contentLower.includes(toolName.toLowerCase())) score += 3
          // 参数关键词匹配
          for (const part of queryParts.slice(1)) {
            if (part.length > 2 && contentLower.includes(part.toLowerCase())) score += 1
          }
          return { content, score }
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map((s) => s.content)

      // 3. 合并去重
      const allFacts = [...new Set([...vectorResults, ...keywordScored])]
      const scores = allFacts.map((_, i) => {
        // 向量搜索结果排前面，置信度更高
        return i < vectorResults.length ? 0.8 : 0.5
      })

      // 4. conservative 模式：仅在高置信度时返回结果
      if (this.personalizationLevel === 'conservative') {
        // 保守模式下，仅保留置信度 > 0.7 的结果
        const highConfFacts = allFacts.filter((_, i) => scores[i] > 0.7)
        const highConfScores = scores.filter((s) => s > 0.7)

        if (highConfFacts.length > 0) {
          log('INFO', 'memory_interceptor_hit', {
            tool: toolName,
            matches: highConfFacts.length,
            top: highConfFacts[0]?.slice(0, 60),
            level: 'conservative',
          })
        }

        return {
          facts: highConfFacts,
          scores: highConfScores,
          hasContext: highConfFacts.length > 0,
        }
      }

      if (allFacts.length > 0) {
        log('INFO', 'memory_interceptor_hit', {
          tool: toolName,
          matches: allFacts.length,
          top: allFacts[0]?.slice(0, 60),
          level: this.personalizationLevel,
        })
      }

      return {
        facts: allFacts,
        scores,
        hasContext: allFacts.length > 0,
      }
    } catch (err) {
      log('WARN', 'memory_interceptor_precall_failed', { tool: toolName, error: String(err) })
      return { facts: [], scores: [], hasContext: false }
    }
  }

  /**
   * 将记忆上下文注入工具参数。
   *
   * 使用 `_memoryContext` 保留前缀以避免与工具实际参数冲突。
   * 外部 MCP 服务器会忽略未识别的字段；本地工具可选择使用该上下文。
   */
  enrichArgs(args: Record<string, any>, context: MemoryContext): Record<string, any> {
    if (!context.hasContext || !this.isEnabled()) return args

    return {
      ...args,
      _memoryContext: {
        facts: context.facts,
        note: '【记忆检索】以下是从历史记忆中检索到的可能相关的上下文，仅供参考',
      },
    }
  }

  /**
   * 从用户偏好中自动填充工具参数的默认值。
   *
   * 仅填充用户未显式提供的参数（用户值优先）。
   * 依赖 ToolMemoryDefaults 注册表中的映射规则。
   *
   * 若未配置 ToolMemoryDefaults 或工具无注册映射，直接返回原始参数。
   *
   * @param toolName 工具名
   * @param args 用户提供的参数（可能已通过 enrichArgs 增强）
   * @returns 填充结果，包含填充后的参数和填充详情
   */
  fillDefaults(toolName: string, args: Record<string, any>): DefaultFillResult {
    if (!this.isEnabled()) {
      return { args, filled: [], hasFilled: false }
    }

    if (!this.toolDefaults || !this.toolDefaults.hasDefaults(toolName)) {
      return { args, filled: [], hasFilled: false }
    }

    try {
      const result = this.toolDefaults.fill(toolName, args, this.personalizationLevel)
      return {
        args: result.args,
        filled: result.filled,
        hasFilled: result.filled.length > 0,
      }
    } catch (err) {
      log('WARN', 'memory_interceptor_fill_defaults_failed', {
        tool: toolName,
        error: String(err),
      })
      return { args, filled: [], hasFilled: false }
    }
  }

  /**
   * 工具调用后：将执行结果摘要存入 Memory，
   * 并更新工具调用频次和成功率统计。
   *
   * 摘要格式: "[工具调用] toolName(key=value, ...) → 成功/失败: resultPreview"
   * 成功调用置信度 0.6，失败调用置信度 0.3（避免噪声记忆占据高优先级）。
   */
  postCall(
    toolName: string,
    args: Record<string, any>,
    result: string,
    success: boolean,
  ): void {
    // 更新内部统计
    this.updateToolStats(toolName, success)

    if (!this.memoryService) return

    try {
      const summaryText = this.buildSummary(toolName, args, result, success)
      if (summaryText) {
        // 工具调用记录以较低置信度存入，避免与用户事实混淆
        this.memoryService.addFact(summaryText, success ? 0.6 : 0.3)
        log('INFO', 'memory_interceptor_stored', {
          tool: toolName,
          success,
          preview: summaryText.slice(0, 80),
        })
      }
    } catch (err) {
      log('WARN', 'memory_interceptor_postcall_failed', { tool: toolName, error: String(err) })
    }
  }

  /**
   * 更新工具调用内部统计（频次和成功率）。
   * 维护固定大小的滑动窗口，避免无限增长。
   */
  private updateToolStats(toolName: string, success: boolean): void {
    let stats = this.toolStats.get(toolName)
    if (!stats) {
      stats = { callCount: 0, successCount: 0, recentCalls: [] }
      this.toolStats.set(toolName, stats)
    }

    stats.callCount++
    if (success) stats.successCount++

    // 滑动窗口：保留最近 N 次调用记录
    stats.recentCalls.push({ success, timestamp: Date.now() })
    if (stats.recentCalls.length > MEMORY_TOOL_STAT_WINDOW) {
      const removed = stats.recentCalls.shift()!
      // 从窗口移除的调用也调整计数
      if (removed.success) stats.successCount--
      stats.callCount--
    }
  }

  /**
   * 构建工具调用摘要文本。
   */
  private buildSummary(
    toolName: string,
    args: Record<string, any>,
    result: string,
    success: boolean,
  ): string {
    // 提取关键参数摘要（仅限字符串类型，截断至 60 字符）
    const argSummary = Object.entries(args)
      .filter(([, v]) => typeof v === 'string' && v.length > 0)
      .map(([k, v]) => `${k}=${(v as string).slice(0, 60)}`)
      .join(', ')

    const status = success ? '成功' : '失败'
    // 截断结果预览，避免长输出污染记忆
    const resultPreview = result.slice(0, 120).replace(/\n/g, ' ')

    if (argSummary) {
      return `[工具调用] ${toolName}(${argSummary}) → ${status}: ${resultPreview}`
    }
    return `[工具调用] ${toolName} → ${status}: ${resultPreview}`
  }
}
