import type { MemoryService } from '../memory/MemoryService'
import { log } from '../logger/Logger'

/**
 * 工具参数 → 用户偏好键的映射规则。
 *
 * key = "toolName.paramName"，value = 用户偏好中的 key。
 * 例如: { "query_weather.city": "default_city" }
 *
 * 当工具调用时，若某参数未被用户显式提供，
 * 则从此注册表查找对应用户偏好值自动填充。
 */
export interface ToolParamDefaults {
  [toolParamKey: string]: string
}

/**
 * MemoryRetriever — 记忆检索模块。
 *
 * 封装对 MemoryService 的访问，提供统一接口用于：
 *   - 检索用户偏好（按 key 查询）
 *   - 检索最近工具调用历史（按工具名筛选）
 *   - 获取交互模式（高频工具、常用参数）
 *
 * 所有操作本地完成，不依赖外部服务。
 */
export class MemoryRetriever {
  private memoryService: MemoryService | null = null

  setMemoryService(ms: MemoryService | null): void {
    this.memoryService = ms
  }

  /**
   * 按 key 查询用户偏好值。
   * 返回置信度最高的匹配项，若无匹配返回 null。
   */
  getPreference(key: string): { value: string; confidence: number } | null {
    if (!this.memoryService) return null
    try {
      const prefs = this.memoryService.getUserPreferences()
      const match = prefs.find((p) => p.key === key)
      if (match) {
        return { value: match.value, confidence: match.confidence }
      }
      return null
    } catch (err) {
      log('WARN', 'memory_retriever_pref_failed', { key, error: String(err) })
      return null
    }
  }

  /**
   * 检索与指定工具相关的最近调用记录。
   * 从 user_fact 条目中筛选包含 "[工具调用] toolName" 的记录。
   */
  getRecentToolCalls(toolName: string, limit = 5): string[] {
    if (!this.memoryService) return []
    try {
      const marker = `[工具调用] ${toolName}`
      return this.memoryService
        .getEntries()
        .filter((e) => e.type === 'user_fact' && e.content.includes(marker))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit)
        .map((e) => e.content)
    } catch (err) {
      log('WARN', 'memory_retriever_history_failed', { toolName, error: String(err) })
      return []
    }
  }

  /**
   * 获取用户的高频工具列表（按调用次数排序）。
   * 返回格式: [{ toolName, count }]
   */
  getFrequentTools(limit = 10): Array<{ toolName: string; count: number }> {
    if (!this.memoryService) return []
    try {
      const marker = '[工具调用] '
      const toolCounts = new Map<string, number>()
      for (const entry of this.memoryService.getEntries()) {
        if (entry.type !== 'user_fact' || !entry.content.startsWith(marker)) continue
        // 解析 "[工具调用] toolName(...) → ..."
        const rest = entry.content.slice(marker.length)
        const parenIdx = rest.indexOf('(')
        const arrowIdx = rest.indexOf(' → ')
        const endIdx = parenIdx > 0 ? parenIdx : arrowIdx > 0 ? arrowIdx : rest.length
        const toolName = rest.slice(0, endIdx).trim()
        if (toolName) {
          toolCounts.set(toolName, (toolCounts.get(toolName) || 0) + 1)
        }
      }
      return Array.from(toolCounts.entries())
        .map(([toolName, count]) => ({ toolName, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit)
    } catch (err) {
      log('WARN', 'memory_retriever_freq_failed', { error: String(err) })
      return []
    }
  }
}

/**
 * ToolMemoryDefaults — 工具参数默认值管理器。
 *
 * 维护工具参数 → 用户偏好键的映射注册表，
 * 在工具调用前自动填充用户未显式提供的参数。
 *
 * ## 使用方式
 *   1. 注册映射: defaults.register('query_weather', 'city', 'default_city')
 *   2. 调用填充: defaults.fill('query_weather', {}) → { city: '北京' }
 *
 * ## 用户确认优先级
 *   仅填充用户未提供的参数。若用户显式传入了 city='上海'，
 *   则不会用默认值覆盖。
 */
export class ToolMemoryDefaults {
  private registry: ToolParamDefaults = {}
  private memoryRetriever: MemoryRetriever

  constructor(memoryRetriever: MemoryRetriever) {
    this.memoryRetriever = memoryRetriever
  }

  /**
   * 注册工具参数默认值映射。
   *
   * @param toolName 工具名，如 "query_weather"
   * @param paramName 参数名，如 "city"
   * @param prefKey 用户偏好中的 key，如 "default_city"
   */
  register(toolName: string, paramName: string, prefKey: string): void {
    const key = `${toolName}.${paramName}`
    this.registry[key] = prefKey
    log('INFO', 'tool_defaults_registered', { tool: toolName, param: paramName, prefKey })
  }

  /**
   * 批量注册工具参数默认值映射。
   *
   * @param mappings 格式: { "toolName.paramName": "prefKey", ... }
   */
  registerAll(mappings: ToolParamDefaults): void {
    for (const [key, prefKey] of Object.entries(mappings)) {
      this.registry[key] = prefKey
    }
    log('INFO', 'tool_defaults_registered_batch', { count: Object.keys(mappings).length })
  }

  /**
   * 取消注册。
   */
  unregister(toolName: string, paramName: string): void {
    const key = `${toolName}.${paramName}`
    delete this.registry[key]
  }

  /**
   * 为工具参数填充默认值。
   *
   * 仅填充用户未显式提供的参数（即 args 中不存在的 key）。
   * 若用户已提供该参数，即使值相同也不会被覆盖。
   *
   * @param toolName 工具名
   * @param args 用户提供的参数
   * @returns 填充后的参数副本，以及填充日志
   */
  fill(toolName: string, args: Record<string, any>): {
    args: Record<string, any>
    filled: Array<{ param: string; value: string; source: string; confidence: number }>
  } {
    const filled: Array<{ param: string; value: string; source: string; confidence: number }> = []
    const enriched = { ...args }

    for (const [toolParamKey, prefKey] of Object.entries(this.registry)) {
      const [regTool, param] = toolParamKey.split('.', 2)
      if (regTool !== toolName || !param) continue

      // 仅填充用户未提供的参数（用户显式值优先）
      if (param in args) continue

      const pref = this.memoryRetriever.getPreference(prefKey)
      if (pref) {
        enriched[param] = pref.value
        filled.push({
          param,
          value: pref.value,
          source: `user_preference:${prefKey}`,
          confidence: pref.confidence,
        })
      }
    }

    if (filled.length > 0) {
      log('INFO', 'tool_defaults_filled', {
        tool: toolName,
        filled: filled.map((f) => `${f.param}=${f.value}`).join(', '),
      })
    }

    return { args: enriched, filled }
  }

  /**
   * 导出当前注册表（用于调试/持久化）。
   */
  getRegistry(): ToolParamDefaults {
    return { ...this.registry }
  }

  /**
   * 检查指定工具是否有注册的默认值映射。
   */
  hasDefaults(toolName: string): boolean {
    return Object.keys(this.registry).some((k) => k.startsWith(`${toolName}.`))
  }
}
