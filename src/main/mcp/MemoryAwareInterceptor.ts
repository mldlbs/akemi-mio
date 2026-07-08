import type { MemoryService } from '../memory/MemoryService'
import { log } from '../logger/Logger'
import type { ToolMemoryDefaults } from './ToolMemoryDefaults'

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
 * MemoryAwareInterceptor — MCP 工具调用的记忆感知拦截器。
 *
 * 在工具调用前检索相关记忆作为上下文注入，
 * 在工具调用后将执行结果摘要存回记忆系统。
 *
 * 所有操作本地完成，不依赖外部服务。
 *
 * ## 生命周期
 *   1. preCall()  — 工具调用前：语义检索相关记忆
 *   2. enrichArgs() — 将记忆上下文注入工具参数
 *   3. fillDefaults() — 从用户偏好自动填充未提供的参数默认值
 *   4. postCall() — 工具调用后：摘要存入记忆
 */
export class MemoryAwareInterceptor {
  private memoryService: MemoryService | null = null
  private toolDefaults: ToolMemoryDefaults | null = null

  /** 关联 MemoryService 实例 */
  setMemoryService(ms: MemoryService | null): void {
    this.memoryService = ms
  }

  /** 关联 ToolMemoryDefaults 实例用于参数默认值填充 */
  setToolDefaults(td: ToolMemoryDefaults | null): void {
    this.toolDefaults = td
  }

  /**
   * 工具调用前：从 Memory 中语义检索相关上下文。
   *
   * 检索策略：
   *   1. VectorMemory 向量语义搜索（基于 toolName + arg 值构建查询）
   *   2. user_fact 条目关键词匹配补充
   *   3. 去重合并，最多返回 5 条
   */
  preCall(toolName: string, args: Record<string, any>): MemoryContext {
    if (!this.memoryService) {
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

      if (allFacts.length > 0) {
        log('INFO', 'memory_interceptor_hit', {
          tool: toolName,
          matches: allFacts.length,
          top: allFacts[0]?.slice(0, 60),
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
    if (!context.hasContext) return args

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
    if (!this.toolDefaults || !this.toolDefaults.hasDefaults(toolName)) {
      return { args, filled: [], hasFilled: false }
    }

    try {
      const result = this.toolDefaults.fill(toolName, args)
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
   * 工具调用后：将执行结果摘要存入 Memory。
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
