/**
 * ToolCallMemoryCache — 工具调用记忆缓存与智能复用
 *
 * ## 职责
 * 1. 记录工具调用的 (工具名, 参数签名, 输出, 时间戳) 到内存缓存
 * 2. 在工具调用前检查缓存, 命中且未过期则直接返回缓存结果
 * 3. 跟踪失败模式, 自动调整参数 (超时增加) 或选择备用工具
 * 4. 提供清除缓存的 API
 *
 * ## 与 BehaviorPredictor 的区别
 * - BehaviorPredictor 缓存的是"预测"的结果 (异步预加载)
 * - ToolCallMemoryCache 缓存的是"实际已完成"的调用结果 (同步命中)
 *
 * ## 与 ToolCallLogStore 的区别
 * - ToolCallLogStore 记录所有调用 (持久化日志)
 * - ToolCallMemoryCache 只缓存成功的结果 (供复用, 减少重复开销)
 *
 * ## 数据流
 *   ServerManager.callTool()
 *     → get(name, args)      // 先查缓存
 *     → getAdjustedArgs()    // 基于错误历史调整参数
 *     → (execute tool)
 *     → set(name, args, result)  // 缓存成功结果
 *     → recordError()        // 记录失败模式
 */

import { log } from '../logger/Logger'
import { ToolErrorType } from './ToolErrorType'

// =============================================================================
// 默认常量
// =============================================================================

/** 默认缓存 TTL (5 分钟) — 文件内容可能在短时间内变化 */
const DEFAULT_TTL_MS = 5 * 60 * 1000

/** 只读操作缓存 TTL (30 秒) — 文件可能随时被修改 */
const FILE_READ_TTL_MS = 30 * 1000

/** 结构化数据缓存 TTL (10 分钟) — 记忆/凭据相对稳定 */
const STRUCTURED_TTL_MS = 10 * 60 * 1000

/** 最大缓存条目数 */
const MAX_CACHE_ENTRIES = 200

/** 最大错误跟踪记录数 */
const ERROR_TRACK_MAX = 100

/**
 * 默认可缓存的只读工具集合。
 * 只有确定幂等/只读的工具才加入缓存, 避免返回陈旧结果。
 */
const DEFAULT_CACHEABLE_TOOLS = new Set<string>([
  // ── 文件只读操作 (短 TTL) ──
  'read_file',
  'read_multiple_files',
  'grep',
  'list_files',
  'search_files',
  'search_files_glob',
  'file_info',

  // ── 记忆检索 (中 TTL) ──
  'retrieve_memory',
  'search_memories',
  'query_tasks',
  'get_user_preferences',
  'list_procedures',

  // ── 凭据查询 (中 TTL) ──
  'get_credential',
  'list_credentials',

  // ── 计划/工作流查询 ──
  'list_plans',
  'list_workflows',
  'get_workflow_status',
  'list_workflow_runs',

  // ── 技能查询 ──
  'list_skills',

  // ── 博客查询 ──
  'blog_session_status',
  'blog_get_habits',
  'blog_get_suggestions',
  'blog_list_sessions',
  'blog_get_mode',
  'blog_memory_search',
  'blog_memory_list',
  'blog_memory_stats',

  // ── 文件规则 ──
  'list_file_rules',
  'get_file_rule',

  // ── 类型健康 ──
  'type_health',
])

// =============================================================================
// 类型定义
// =============================================================================

/** 单条缓存条目 */
export interface CacheEntry {
  /** 缓存键: `{toolName}|{argSignature}` */
  key: string
  /** 工具名 */
  toolName: string
  /** 参数签名 (排序后的 key=value 对) */
  argSignature: string
  /** 缓存的结果文本 */
  result: string
  /** 创建时间戳 */
  createdAt: number
  /** 过期时间戳 */
  expiresAt: number
  /** 原始调用耗时 (ms) */
  durationMs: number
  /** 命中次数 */
  hitCount: number
}

/** 工具调用错误记录 */
export interface ErrorRecord {
  /** 工具名 */
  toolName: string
  /** 参数签名 */
  argSignature: string
  /** 失败次数 */
  failureCount: number
  /** 最后一次错误消息 */
  lastError: string
  /** 最后一次错误时间戳 */
  lastErrorAt: number
  /** 错误类型分类 */
  errorType: ToolErrorType | null
  /** 已应用的参数调整记录 */
  appliedAdjustments: Record<string, any>
}

/** 缓存全局统计 */
export interface CacheStats {
  /** 当前缓存条目数 */
  size: number
  /** 总命中次数 */
  hits: number
  /** 总未命中次数 */
  misses: number
  /** 命中率 (0-1) */
  hitRate: number
  /** 最旧的条目创建时间 */
  oldestEntry: number
  /** 最新的条目创建时间 */
  newestEntry: number
  /** 错误跟踪数 */
  errorRecordCount: number
  /** 可缓存的工具列表 */
  cacheableTools: string[]
}

/** 参数调整结果 */
export interface ToolAdjustment {
  /** 调整后的参数对象 */
  args: Record<string, any>
  /** 是否做了调整 */
  adjusted: boolean
  /** 调整原因 */
  reason?: string
}

/** 缓存配置 */
export interface MemoryCacheConfig {
  /** 默认缓存 TTL (毫秒) */
  defaultTTL: number
  /** 文件操作 TTL (毫秒) */
  fileReadTTL: number
  /** 结构化数据 TTL (毫秒) */
  structuredTTL: number
  /** 最大缓存条目数 */
  maxEntries: number
  /** 可缓存的工具集合 (工具名) */
  cacheableTools: Set<string>
  /** 是否启用错误驱动参数调整 */
  errorAdjustmentEnabled: boolean
  /** 是否启用备用工具推荐 */
  fallbackEnabled: boolean
  /** 最小错误缓存 TTL (毫秒) — 避免频繁重试已知会失败的工具 */
  minErrorCacheTTL: number
}

// =============================================================================
// 默认配置
// =============================================================================

const DEFAULT_CONFIG: MemoryCacheConfig = {
  defaultTTL: DEFAULT_TTL_MS,
  fileReadTTL: FILE_READ_TTL_MS,
  structuredTTL: STRUCTURED_TTL_MS,
  maxEntries: MAX_CACHE_ENTRIES,
  cacheableTools: new Set(DEFAULT_CACHEABLE_TOOLS),
  errorAdjustmentEnabled: true,
  fallbackEnabled: true,
  minErrorCacheTTL: 30 * 60 * 1000, // 30 分钟
}

// =============================================================================
// ToolCallMemoryCache 实现
// =============================================================================

class ToolCallMemoryCache {
  private config: MemoryCacheConfig
  /** 内存缓存: key → CacheEntry */
  private cache = new Map<string, CacheEntry>()
  /** 错误记录: key → ErrorRecord */
  private errorRecords = new Map<string, ErrorRecord>()
  /** 命中统计 */
  private hits = 0
  /** 未命中统计 */
  private misses = 0

  constructor(config?: Partial<MemoryCacheConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  // =========================================================================
  // 公共 API
  // =========================================================================

  /**
   * 检查缓存。命中且未过期则返回缓存结果。
   *
   * @param toolName 工具名
   * @param args 工具参数
   * @returns 缓存结果 + 命中次数, 或 null
   */
  get(toolName: string, args: Record<string, any>): { result: string; hitCount: number } | null {
    if (!this.config.cacheableTools.has(toolName)) {
      this.misses++
      return null
    }

    const key = this.buildKey(toolName, args)
    const entry = this.cache.get(key)

    if (!entry) {
      this.misses++
      return null
    }

    // 检查 TTL
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      this.misses++
      log('DEBUG', 'tool_cache_expired', { tool: toolName, key, expiredAt: new Date(entry.expiresAt).toISOString() })
      return null
    }

    // 命中!
    entry.hitCount++
    this.hits++
    log('INFO', 'tool_cache_hit', {
      tool: toolName,
      cacheAge: Date.now() - entry.createdAt,
      hitCount: entry.hitCount,
      durationMs: entry.durationMs,
    })

    return { result: entry.result, hitCount: entry.hitCount }
  }

  /**
   * 存储工具调用结果到缓存。
   * 仅缓存标记为可缓存的工具的成功结果。
   * 根据工具类型自动选择 TTL:
   *   - 文件读取: 短 TTL (30s)
   *   - 结构化查询: 长 TTL (10min)
   *   - 其他: 默认 TTL (5min)
   *
   * @param toolName 工具名
   * @param args 工具参数
   * @param result 结果文本
   * @param durationMs 调用耗时
   * @param success 是否成功 (仅成功结果被缓存)
   * @param ttlMs 可选覆盖 TTL
   */
  set(
    toolName: string,
    args: Record<string, any>,
    result: string,
    durationMs: number,
    success: boolean,
    ttlMs?: number,
  ): void {
    if (!this.config.cacheableTools.has(toolName)) return
    if (!success) return // 仅缓存成功结果

    const key = this.buildKey(toolName, args)

    // 已有缓存且未过期 → 跳过 (保留首次缓存)
    const existing = this.cache.get(key)
    if (existing && Date.now() < existing.expiresAt) {
      existing.hitCount++
      return
    }

    // 自动选择 TTL
    const ttl = ttlMs ?? this.pickTTL(toolName)
    const now = Date.now()

    const entry: CacheEntry = {
      key,
      toolName,
      argSignature: this.buildArgSignature(args),
      result,
      createdAt: now,
      expiresAt: now + ttl,
      durationMs,
      hitCount: 0,
    }

    this.cache.set(key, entry)

    // 超出上限时淘汰最旧条目
    if (this.cache.size > this.config.maxEntries) {
      this.evict()
    }

    log('INFO', 'tool_cache_set', {
      tool: toolName,
      ttl,
      expiresIn: `${(ttl / 1000).toFixed(0)}s`,
      durationMs,
    })
  }

  /**
   * 记录工具调用失败, 用于错误模式分析和参数自动调整。
   * 多次同类失败会触发参数调整逻辑。
   */
  recordError(
    toolName: string,
    args: Record<string, any>,
    error: string,
    errorType: ToolErrorType | null,
  ): void {
    const key = this.buildKey(toolName, args)
    const now = Date.now()

    const existing = this.errorRecords.get(key)
    if (existing) {
      existing.failureCount++
      existing.lastError = error.slice(0, 500)
      existing.lastErrorAt = now
      existing.errorType = errorType
    } else {
      this.errorRecords.set(key, {
        toolName,
        argSignature: this.buildArgSignature(args),
        failureCount: 1,
        lastError: error.slice(0, 500),
        lastErrorAt: now,
        errorType,
        appliedAdjustments: {},
      })
    }

    // 错误记录超出上限时淘汰最旧条目
    if (this.errorRecords.size > ERROR_TRACK_MAX) {
      const entries = [...this.errorRecords.entries()]
        .sort((a, b) => a[1].lastErrorAt - b[1].lastErrorAt)
      const toRemove = Math.floor(ERROR_TRACK_MAX * 0.2)
      for (let i = 0; i < toRemove; i++) {
        this.errorRecords.delete(entries[i][0])
      }
    }

    log('INFO', 'tool_cache_error_recorded', {
      tool: toolName,
      errorType,
      failureCount: this.errorRecords.get(key)?.failureCount,
    })
  }

  /**
   * 基于错误历史获取调整后的参数。
   *
   * 调整策略:
   * - 超时错误 (TRANSIENT + "timeout"): 加倍 timeout 参数
   * - 文件权限错误 (PERMISSION): 标记路径问题 (供外层处理)
   * - TOOL_MISSING: 触发备用工具推荐
   *
   * @param toolName 工具名
   * @param args 原始参数
   * @returns 调整后的参数 + 调整说明
   */
  getAdjustedArgs(toolName: string, args: Record<string, any>): ToolAdjustment {
    if (!this.config.errorAdjustmentEnabled) {
      return { args, adjusted: false }
    }

    const key = this.buildKey(toolName, args)
    const errorRecord = this.errorRecords.get(key)
    if (!errorRecord || errorRecord.failureCount === 0) {
      return { args, adjusted: false }
    }

    const adjusted: Record<string, any> = { ...args }
    const reasons: string[] = []

    // ── 1. 超时调整: 增加 timeout/requestTimeoutMs ──
    if (
      errorRecord.errorType === ToolErrorType.TRANSIENT &&
      errorRecord.lastError.toLowerCase().includes('timeout')
    ) {
      const maxTimeout = 300_000 // 5 分钟上限
      if (typeof adjusted.timeout === 'number' && adjusted.timeout < maxTimeout) {
        const newTimeout = Math.min(adjusted.timeout * 2, maxTimeout)
        if (newTimeout !== adjusted.timeout) {
          adjusted.timeout = newTimeout
          reasons.push(`上次调用超时 (${adjusted.timeout / 2}ms → ${newTimeout}ms)`)
        }
      } else if (typeof adjusted.requestTimeoutMs === 'number' && adjusted.requestTimeoutMs < maxTimeout) {
        const newTimeout = Math.min(adjusted.requestTimeoutMs * 2, maxTimeout)
        if (newTimeout !== adjusted.requestTimeoutMs) {
          adjusted.requestTimeoutMs = newTimeout
          reasons.push(`上次调用超时 (${adjusted.requestTimeoutMs / 2}ms → ${newTimeout}ms)`)
        }
      } else if (typeof adjusted.timeout === 'undefined' && typeof adjusted.requestTimeoutMs === 'undefined') {
        // 无超时参数时添加一个合理的默认超时
        adjusted.timeout = 120_000 // 2 分钟
        reasons.push('上次调用超时, 已设置超时限制 (120s)')
      }
    }

    // ── 2. 参数校验错误: 检查常见参数格式问题 ──
    if (errorRecord.errorType === ToolErrorType.ARGUMENT) {
      const errMsg = errorRecord.lastError.toLowerCase()
      if (errMsg.includes('path') && typeof adjusted.path === 'string') {
        // 路径参数问题 — 标记给外部处理
        reasons.push(`上次调用路径参数错误: "${adjusted.path.slice(0, 80)}"`)
      }
      if (errMsg.includes('pattern') && typeof adjusted.pattern === 'string') {
        reasons.push(`上次调用模式参数错误: "${adjusted.pattern.slice(0, 80)}"`)
      }
    }

    if (reasons.length > 0) {
      // 更新已应用调整记录
      errorRecord.appliedAdjustments = {
        ...errorRecord.appliedAdjustments,
        ...adjusted,
      }

      log('INFO', 'tool_cache_args_adjusted', {
        tool: toolName,
        reason: reasons.join('; '),
        failureCount: errorRecord.failureCount,
      })

      return {
        args: adjusted,
        adjusted: true,
        reason: reasons.join('; '),
      }
    }

    return { args, adjusted: false }
  }

  /**
   * 获取备用工具建议。
   * 当某工具+参数组合多次失败后, 返回一个替代工具的推荐。
   * 映射关系由内置规则定义。
   *
   * @param toolName 失败的工具名
   * @param args 调用参数
   * @returns 建议的备用工具名, 或 null
   */
  getFallbackSuggestion(toolName: string, args: Record<string, any>): string | null {
    if (!this.config.fallbackEnabled) return null

    const key = this.buildKey(toolName, args)
    const errorRecord = this.errorRecords.get(key)

    // 需要至少 2 次同类失败才触发备用工具推荐
    if (!errorRecord || errorRecord.failureCount < 2) return null

    // 内置备用工具映射
    const fallbackMap: Record<string, string[]> = {
      'read_file': ['grep', 'list_files'],
      'grep': ['search_files_glob', 'search_files'],
      'list_files': ['search_files_glob', 'grep'],
      'retrieve_memory': ['search_memories'],
      'search_memories': ['retrieve_memory'],
      'search_files_glob': ['grep', 'list_files'],
      'file_info': ['list_files', 'read_file'],
    }

    const fallbacks = fallbackMap[toolName]
    if (!fallbacks || fallbacks.length === 0) return null

    log('INFO', 'tool_cache_fallback_suggested', {
      tool: toolName,
      fallback: fallbacks[0],
      failureCount: errorRecord.failureCount,
      errorType: errorRecord.errorType,
    })

    return fallbacks[0]
  }

  /**
   * 清除缓存。
   *
   * @param toolName 可选, 仅清除特定工具的缓存
   * @returns 被清除的缓存条目数
   */
  clear(toolName?: string): number {
    let count = 0

    if (toolName) {
      // 清除该工具的缓存条目
      for (const [key, entry] of this.cache) {
        if (entry.toolName === toolName) {
          this.cache.delete(key)
          count++
        }
      }
      // 同时清除该工具的错误记录
      for (const [key, record] of this.errorRecords) {
        if (record.toolName === toolName) {
          this.errorRecords.delete(key)
        }
      }
      log('INFO', 'tool_cache_cleared', { tool: toolName, removedCache: count })
    } else {
      count = this.cache.size
      const errorCount = this.errorRecords.size
      this.cache.clear()
      this.errorRecords.clear()
      this.hits = 0
      this.misses = 0
      log('INFO', 'tool_cache_cleared_all', { removedCache: count, removedErrors: errorCount })
    }

    return count
  }

  /**
   * 使特定工具的特定参数组合的缓存失效。
   * 用于工具返回了错误但缓存已被写入的场景。
   */
  invalidate(toolName: string, args: Record<string, any>): void {
    const key = this.buildKey(toolName, args)
    this.cache.delete(key)
    log('DEBUG', 'tool_cache_invalidated', { tool: toolName, key })
  }

  /**
   * 获取缓存全局统计。
   */
  getStats(): CacheStats {
    const now = Date.now()
    let oldest = now
    let newest = 0

    for (const [, entry] of this.cache) {
      if (entry.createdAt < oldest) oldest = entry.createdAt
      if (entry.createdAt > newest) newest = entry.createdAt
    }

    const total = this.hits + this.misses
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? Math.round((this.hits / total) * 10000) / 10000 : 0,
      oldestEntry: oldest === now ? 0 : oldest,
      newestEntry: newest,
      errorRecordCount: this.errorRecords.size,
      cacheableTools: [...this.config.cacheableTools].sort(),
    }
  }

  /**
   * 获取错误记录列表 (调试/管理用)。
   *
   * @param toolName 可选过滤工具名
   */
  getErrorRecords(toolName?: string): ErrorRecord[] {
    const records: ErrorRecord[] = []
    for (const [, record] of this.errorRecords) {
      if (!toolName || record.toolName === toolName) {
        records.push({ ...record })
      }
    }
    return records.sort((a, b) => b.failureCount - a.failureCount)
  }

  /**
   * 获取缓存的快照 (调试/管理用)。
   *
   * @param toolName 可选过滤工具名
   */
  getCacheSnapshot(toolName?: string): CacheEntry[] {
    const entries: CacheEntry[] = []
    for (const [, entry] of this.cache) {
      if (!toolName || entry.toolName === toolName) {
        entries.push({ ...entry })
      }
    }
    return entries.sort((a, b) => b.createdAt - a.createdAt).slice(0, 100)
  }

  /**
   * 检查某工具是否可缓存。
   */
  isCacheable(toolName: string): boolean {
    return this.config.cacheableTools.has(toolName)
  }

  /**
   * 更新可缓存的工具集合。
   */
  setCacheableTools(tools: string[]): void {
    this.config.cacheableTools = new Set(tools)
    // 清理不再可缓存的条目
    for (const [key, entry] of this.cache) {
      if (!this.config.cacheableTools.has(entry.toolName)) {
        this.cache.delete(key)
      }
    }
  }

  /**
   * 获取当前配置 (只读快照)。
   */
  getConfig(): Readonly<MemoryCacheConfig> {
    const { cacheableTools, ...rest } = this.config
    return {
      ...rest,
      cacheableTools: new Set(cacheableTools),
    }
  }

  // =========================================================================
  // 内部方法
  // =========================================================================

  /**
   * 根据工具类型自动选择 TTL。
   */
  private pickTTL(toolName: string): number {
    // 文件读取: 短 TTL
    if (['read_file', 'read_multiple_files', 'file_info'].includes(toolName)) {
      return this.config.fileReadTTL
    }
    // 结构化查询: 长 TTL
    if (['retrieve_memory', 'search_memories', 'get_credential', 'list_credentials'].includes(toolName)) {
      return this.config.structuredTTL
    }
    // 默认
    return this.config.defaultTTL
  }

  /**
   * 构建缓存键: `{toolName}|{sorted-arg-signature}`
   */
  private buildKey(toolName: string, args: Record<string, any>): string {
    const sig = this.buildArgSignature(args)
    return `${toolName}|${sig}`
  }

  /**
   * 从工具参数构建排序后的签名。
   * 跳过元数据参数 (`_` 前缀), 对值截断以防止过长的键。
   */
  private buildArgSignature(args: Record<string, any>): string {
    const parts: string[] = []
    for (const [key, value] of Object.entries(args)) {
      if (key.startsWith('_')) continue
      if (typeof value === 'string') {
        parts.push(`${key}=${value.slice(0, 60)}`)
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        parts.push(`${key}=${String(value)}`)
      } else if (value === null || value === undefined) {
        parts.push(`${key}=null`)
      } else {
        parts.push(`${key}=${JSON.stringify(value).slice(0, 60)}`)
      }
    }
    return parts.sort().join('&')
  }

  /**
   * 淘汰最旧的缓存条目, 使缓存大小回到 maxEntries。
   */
  private evict(): void {
    const entries = [...this.cache.entries()]
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
    const toRemove = this.cache.size - this.config.maxEntries
    for (let i = 0; i < toRemove; i++) {
      this.cache.delete(entries[i][0])
    }
    log('INFO', 'tool_cache_evicted', { removedCount: toRemove, remainingSize: this.cache.size })
  }
}

// =============================================================================
// 全局单例
// =============================================================================

export const toolCallMemoryCache = new ToolCallMemoryCache()
