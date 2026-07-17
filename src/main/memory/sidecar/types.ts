/**
 * MemorySidecar 类型定义
 *
 * Memory 附属的边车进程类型系统。
 * 边车在 Memory 请求到达主逻辑前执行横切关注点（监控、缓存、过滤、转换）。
 *
 * ── 设计原则 ──
 * 1. 无状态 — 边车不持有 Memory 状态，通过依赖注入获取 MemoryService 引用
 * 2. 无依赖 — 不引入任何业务模块的依赖库（如 startup-radar）
 * 3. 可提取 — 接口设计支持未来提取为独立子进程（通过 ProcessManager）
 * 4. 零开销 — 无注册插件时退化为纯透传模式
 */

import type { MemoryEntry } from '../types'

// ════════════════════════════════════════════════════════════════
//  插件接口 — 业务模块通过此接口注册到边车
// ════════════════════════════════════════════════════════════════

/**
 * 边车处理阶段。
 * - pre: 在 Memory 主逻辑执行前调用（可修改参数或阻止执行）
 * - post: 在 Memory 主逻辑执行后调用（可修改返回值）
 */
export type SidecarHookPhase = 'pre' | 'post'

/**
 * 添加条目的边车上下文。
 */
export interface AddEntryContext {
  type: MemoryEntry['type']
  content: string
  confidence: number
  tier?: MemoryEntry['tier']
  structuredData?: string | null
}

/**
 * 添加条目的边车处理结果。
 */
export interface AddEntryResult {
  /** 是否继续执行 Memory 主逻辑 */
  proceed: boolean
  /** 可能被插件修改后的上下文 */
  context?: AddEntryContext
}

/**
 * 获取条目的边车上下文。
 */
export interface GetEntriesContext {
  /** 最多返回条数 */
  limit?: number
  /** 过滤层级 */
  tier?: MemoryEntry['tier']
}

/**
 * 获取条目的边车处理结果。
 */
export interface GetEntriesResult {
  /** 是否继续执行 Memory 主逻辑 */
  proceed: boolean
  /** 可能被插件修改后的上下文 */
  context?: GetEntriesContext
  /** 插件可预先注入的条目（缓存命中时跳过主逻辑） */
  entries?: MemoryEntry[]
}

/**
 * 格式化上下文的边车处理结果。
 */
export interface GetFormattedContextResult {
  /** 是否继续执行 Memory 主逻辑 */
  proceed: boolean
  /** 插件可预先注入的上下文（缓存命中时跳过主逻辑） */
  context?: string
}

/**
 * 插件预处理返回结果。
 * proceed=false 表示插件处理完毕，跳过 Memory 主逻辑。
 */
export type PreProcessResult<T> = { proceed: false; result: T } | { proceed: true; context?: any }

/**
 * 插件后处理返回结果。
 * 返回修改后的结果，或原样返回。
 */
export type PostProcessResult<T> = T

/**
 * 边车插件接口。
 *
 * 业务模块（如 startup-radar）实现此接口后，
 * 通过 MemorySidecar.registerPlugin() 注册到边车。
 *
 * 所有方法均为可选，按需实现。
 */
export interface ISidecarPlugin {
  /** 插件唯一标识 */
  readonly name: string

  /**
   * 预处理：在 addEntry 前调用。
   * 可用于监控、过滤、转换待添加的条目。
   */
  preAddEntry?(ctx: AddEntryContext): AddEntryResult

  /**
   * 后处理：在 addEntry 后调用。
   * 可用于监控已添加的条目。
   */
  postAddEntry?(ctx: AddEntryContext, entryId?: string): void

  /**
   * 预处理：在 getEntries 前调用。
   * 可用于拦截查询、注入缓存、过滤参数。
   */
  preGetEntries?(ctx: GetEntriesContext): GetEntriesResult

  /**
   * 后处理：在 getEntries 后调用。
   * 可用于过滤、转换返回的条目列表。
   */
  postGetEntries?(entries: MemoryEntry[]): MemoryEntry[]

  /**
   * 预处理：在 getFormattedContext 前调用。
   * 可用于注入缓存上下文。
   */
  preGetFormattedContext?(): GetFormattedContextResult

  /**
   * 后处理：在 getFormattedContext 后调用。
   * 可用于转换、增强返回的上下文。
   */
  postGetFormattedContext?(context: string): string

  /**
   * 添加事实的快捷后处理。
   */
  postAddFact?(content: string, confidence: number): void

  /**
   * 交互记录后处理。
   * 可用于分析交互模式与雷达信号的相关性。
   */
  postRecordInteraction?(userText?: string): void
}

// ════════════════════════════════════════════════════════════════
//  缓存相关
// ════════════════════════════════════════════════════════════════

export interface SidecarCacheConfig {
  /** 是否启用缓存 */
  enabled: boolean
  /** 缓存 TTL（毫秒） */
  ttlMs: number
  /** 最大缓存条目数 */
  maxEntries: number
}

export const DEFAULT_SIDECAR_CACHE_CONFIG: SidecarCacheConfig = {
  enabled: true,
  ttlMs: 5 * 60 * 1000, // 5 分钟
  maxEntries: 100,
}

// ════════════════════════════════════════════════════════════════
//  监控统计
// ════════════════════════════════════════════════════════════════

export interface MemorySidecarStats {
  /** 总请求数 */
  totalRequests: number
  /** 缓存命中数 */
  cacheHits: number
  /** 被过滤拦截的请求数 */
  filteredRequests: number
  /** 被转换的条目数 */
  transformedEntries: number
  /** 当前缓存大小 */
  cacheSize: number
  /** 已注册插件数 */
  pluginCount: number
  /** 注册的插件名列表 */
  pluginNames: string[]
  /** 已拦截的 addEntry 次数 */
  blockedAddEntries: number
  /** 错误计数 */
  errorCount: number
}
