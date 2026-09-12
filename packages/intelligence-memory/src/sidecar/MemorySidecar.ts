/**
 * MemorySidecar — Memory 附属的边车进程
 *
 * ── 架构角色 ──
 *
 * 边车在 Memory 请求到达 MemoryService 主逻辑之前执行横切关注点
 * （监控、缓存、过滤、转换），实现与主逻辑的分离。
 *
 * ── 设计原则 ──
 *
 * 1. 无状态 — 边车不持有 Memory 状态，通过 ISidecarPlugin 插件注册
 * 2. 无依赖 — 不引入任何业务模块的依赖库（如 startup-radar）
 * 3. 可提取 — 接口设计支持未来提取为独立子进程（通过 ProcessManager）
 * 4. 零开销 — 无注册插件时退化为纯透传模式（仅监控+缓存层工作）
 *
 * ── 钩子调用流程（由 MemoryService 在关键方法中调用） ──
 *
 *   MemoryService.addEntry()
 *       ↓ ①
 *   MemorySidecar.processAddEntry()  ← pre-hooks + 过滤
 *       ↓ ② proceed=true → MemoryService 主逻辑执行
 *   MemoryService.addEntry() 主逻辑
 *       ↓ ③
 *   MemorySidecar.postProcessAddEntry()  ← post-hooks
 *
 *   MemoryService.getEntries()
 *       ↓ ①
 *   MemorySidecar.processGetEntries()  ← pre-hooks + 缓存检查
 *       ↓ ② proceed=false → 直接返回缓存，跳过主逻辑
 *       ↓   proceed=true  → MemoryService 主逻辑执行
 *   MemoryService.getEntries() 主逻辑
 *       ↓ ③
 *   MemorySidecar.postProcessGetEntries()  ← 缓存写入 + post-hooks
 *
 * ── 与 PiperBehaviorSidecar 的异同 ──
 *
 *   相同点：
 *   - 都实现 Cache → Filter → Transform → Monitor 管道层
 *   - 都遵循无状态、无依赖、可提取、零开销的设计原则
 *
 *   不同点：
 *   - PiperBehaviorSidecar 直接包装 PiperOrchestrator（调用方经边车进入）
 *   - MemorySidecar 通过钩子集成到 MemoryService 内部（MemoryService 调用边车）
 *   - MemorySidecar 的插件由外部注册，Memory 模块不感知业务细节
 *
 * ── 使用方式（在 AppRuntime 中） ──
 *
 *   // 创建边车并注册插件
 *   const sidecar = new MemorySidecar()
 *   sidecar.registerPlugin(new RadarMemorySidecarPlugin())
 *
 *   // 注入到 MemoryService
 *   memoryService.setSidecar(sidecar)
 *
 *   // 此时所有经过 MemoryService.addEntry() / getEntries()
 *   // / getFormattedContext() 的请求都会先经过边车处理
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { ISidecarPlugin, AddEntryContext, GetEntriesContext, MemorySidecarStats, SidecarCacheConfig } from './types'
import { DEFAULT_SIDECAR_CACHE_CONFIG } from './types'
import type { MemoryEntry } from '../types'

// ══════════════════════════════════════════
//  内存缓存条目
// ══════════════════════════════════════════

interface CacheEntry<T> {
  data: T
  timestamp: number
}

// ══════════════════════════════════════════
//  配置
// ══════════════════════════════════════════

export interface MemorySidecarConfig {
  /** 缓存配置 */
  cache: SidecarCacheConfig
  /** 是否启用调试日志 */
  debug: boolean
}

const DEFAULT_CONFIG: MemorySidecarConfig = {
  cache: { ...DEFAULT_SIDECAR_CACHE_CONFIG },
  debug: false,
}

// ══════════════════════════════════════════
//  MemorySidecar — 钩子式边车
// ══════════════════════════════════════════

export class MemorySidecar {
  private readonly config: MemorySidecarConfig
  private readonly plugins: ISidecarPlugin[] = []

  // ── 缓存 ──
  private entriesCache: CacheEntry<MemoryEntry[]> | null = null
  private contextCache: CacheEntry<string> | null = null

  // ── 监控统计 ──
  private totalRequests = 0
  private cacheHits = 0
  private filteredRequests = 0
  private transformedEntries = 0
  private blockedAddEntries = 0
  private errorCount = 0

  constructor(config?: Partial<MemorySidecarConfig>) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      cache: { ...DEFAULT_SIDECAR_CACHE_CONFIG, ...config?.cache },
    }
  }

  // ══════════════════════════════════════════
  //  插件管理
  // ══════════════════════════════════════════

  /**
   * 注册一个边车插件。
   * 插件的 pre/post 方法将在对应的 Memory 操作前后被调用。
   * 相同 name 的插件重复注册会覆盖旧实例。
   */
  registerPlugin(plugin: ISidecarPlugin): void {
    const existingIdx = this.plugins.findIndex((p) => p.name === plugin.name)
    if (existingIdx >= 0) {
      this.plugins[existingIdx] = plugin
      log('INFO', 'memory_sidecar_plugin_replaced', { plugin: plugin.name })
      return
    }
    this.plugins.push(plugin)
    log('INFO', 'memory_sidecar_plugin_registered', {
      plugin: plugin.name,
      total: this.plugins.length,
    })
  }

  /** 注销指定插件 */
  unregisterPlugin(name: string): boolean {
    const idx = this.plugins.findIndex((p) => p.name === name)
    if (idx < 0) return false
    this.plugins.splice(idx, 1)
    log('INFO', 'memory_sidecar_plugin_unregistered', { plugin: name })
    return true
  }

  /** 获取所有已注册插件名 */
  getPluginNames(): string[] {
    return this.plugins.map((p) => p.name)
  }

  /** 清空所有缓存 */
  clearCache(): void {
    this.entriesCache = null
    this.contextCache = null
    log('INFO', 'memory_sidecar_cache_cleared')
  }

  /** 重置所有统计计数 */
  resetStats(): void {
    this.totalRequests = 0
    this.cacheHits = 0
    this.filteredRequests = 0
    this.transformedEntries = 0
    this.blockedAddEntries = 0
    this.errorCount = 0
    log('INFO', 'memory_sidecar_stats_reset')
  }

  /** 获取边车运行统计 */
  getStats(): MemorySidecarStats {
    return {
      totalRequests: this.totalRequests,
      cacheHits: this.cacheHits,
      filteredRequests: this.filteredRequests,
      transformedEntries: this.transformedEntries,
      cacheSize: (this.entriesCache ? 1 : 0) + (this.contextCache ? 1 : 0),
      pluginCount: this.plugins.length,
      pluginNames: this.plugins.map((p) => p.name),
      blockedAddEntries: this.blockedAddEntries,
      errorCount: this.errorCount,
    }
  }

  // ══════════════════════════════════════════
  //  钩子方法 — addEntry
  // ══════════════════════════════════════════

  /**
   * addEntry 预处理钩子。
   *
   * 在 MemoryService.addEntry() 主逻辑前调用。
   * 运行所有插件的 preAddEntry → 可阻止执行或修改参数。
   *
   * @returns 处理结果：proceed=false 表示被拦截，proceed=true 继续主逻辑
   */
  processAddEntry(
    type: MemoryEntry['type'],
    content: string,
    confidence: number,
    options?: { tier?: MemoryEntry['tier']; structuredData?: string | null },
  ): { proceed: boolean; type?: MemoryEntry['type']; content?: string; confidence?: number; options?: typeof options } {
    this.totalRequests++

    const ctx: AddEntryContext = {
      type,
      content,
      confidence,
      tier: options?.tier,
      structuredData: options?.structuredData ?? null,
    }

    // ── 运行所有插件的 preAddEntry ──
    for (const plugin of this.plugins) {
      if (plugin.preAddEntry) {
        try {
          const result = plugin.preAddEntry(ctx)
          if (!result.proceed) {
            this.blockedAddEntries++
            if (this.config.debug) {
              log('DEBUG', 'memory_sidecar_entry_blocked', {
                plugin: plugin.name,
                content: content.slice(0, 50),
                type,
              })
            }
            return { proceed: false }
          }
          // 应用插件修改后的上下文
          if (result.context) {
            Object.assign(ctx, result.context)
          }
        } catch (err) {
          this.errorCount++
          log('WARN', 'memory_sidecar_pre_add_entry_error', {
            plugin: plugin.name,
            error: String(err),
          })
        }
      }
    }

    return {
      proceed: true,
      type: ctx.type,
      content: ctx.content,
      confidence: ctx.confidence,
      options:
        ctx.tier !== undefined || ctx.structuredData !== undefined ? { tier: ctx.tier, structuredData: ctx.structuredData } : options,
    }
  }

  /**
   * addEntry 后处理钩子。
   *
   * 在 MemoryService.addEntry() 主逻辑后调用。
   * 运行所有插件的 postAddEntry。
   */
  postProcessAddEntry(
    type: MemoryEntry['type'],
    content: string,
    confidence: number,
    options?: { tier?: MemoryEntry['tier']; structuredData?: string | null },
  ): void {
    const ctx: AddEntryContext = {
      type,
      content,
      confidence,
      tier: options?.tier,
      structuredData: options?.structuredData ?? null,
    }

    for (const plugin of this.plugins) {
      if (plugin.postAddEntry) {
        try {
          plugin.postAddEntry(ctx)
        } catch (err) {
          this.errorCount++
          log('WARN', 'memory_sidecar_post_add_entry_error', {
            plugin: plugin.name,
            error: String(err),
          })
        }
      }
    }
  }

  // ══════════════════════════════════════════
  //  钩子方法 — addFact
  // ══════════════════════════════════════════

  /**
   * addFact 后处理钩子。
   * 在 MemoryService.addFact() 主逻辑后调用。
   */
  postProcessAddFact(content: string, confidence: number): void {
    for (const plugin of this.plugins) {
      if (plugin.postAddFact) {
        try {
          plugin.postAddFact(content, confidence)
        } catch (err) {
          this.errorCount++
          log('WARN', 'memory_sidecar_post_add_fact_error', {
            plugin: plugin.name,
            error: String(err),
          })
        }
      }
    }
  }

  // ══════════════════════════════════════════
  //  钩子方法 — getEntries
  // ══════════════════════════════════════════

  /**
   * getEntries 预处理钩子。
   *
   * 在 MemoryService.getEntries() 主逻辑前调用。
   * 先检查缓存 → 再运行插件的 preGetEntries。
   *
   * @returns proceed=false + entries 表示直接返回缓存/插件结果
   *          proceed=true 表示继续主逻辑
   */
  processGetEntries(tier?: MemoryEntry['tier']): { proceed: boolean; entries?: MemoryEntry[] } {
    this.totalRequests++

    const ctx: GetEntriesContext = { tier }

    // ── ① 运行所有插件的 preGetEntries ──
    for (const plugin of this.plugins) {
      if (plugin.preGetEntries) {
        try {
          const result = plugin.preGetEntries(ctx)
          if (!result.proceed && result.entries) {
            this.filteredRequests++
            return { proceed: false, entries: result.entries }
          }
          if (result.context) {
            Object.assign(ctx, result.context)
          }
        } catch (err) {
          this.errorCount++
          log('WARN', 'memory_sidecar_pre_get_entries_error', {
            plugin: plugin.name,
            error: String(err),
          })
        }
      }
    }

    // ── ② 缓存层（仅无 tier 过滤时可用） ──
    if (!tier && this.config.cache.enabled && this.entriesCache) {
      if (Date.now() - this.entriesCache.timestamp <= this.config.cache.ttlMs) {
        this.cacheHits++
        return { proceed: false, entries: [...this.entriesCache.data] }
      }
      this.entriesCache = null
    }

    return { proceed: true }
  }

  /**
   * getEntries 后处理钩子。
   *
   * 在 MemoryService.getEntries() 主逻辑后调用。
   * 写入缓存 → 运行插件的 postGetEntries 进行过滤/转换。
   */
  postProcessGetEntries(entries: MemoryEntry[], tier?: MemoryEntry['tier']): MemoryEntry[] {
    if (!entries) return entries

    let result = entries

    // ── ① 写入缓存（仅无 tier 过滤时可用） ──
    if (!tier && this.config.cache.enabled && result.length > 0) {
      this.entriesCache = { data: [...result], timestamp: Date.now() }
    }

    // ── ② 运行所有插件的 postGetEntries ──
    for (const plugin of this.plugins) {
      if (plugin.postGetEntries) {
        try {
          const filtered = plugin.postGetEntries(result)
          if (filtered !== result) {
            this.transformedEntries++
          }
          result = filtered
        } catch (err) {
          this.errorCount++
          log('WARN', 'memory_sidecar_post_get_entries_error', {
            plugin: plugin.name,
            error: String(err),
          })
        }
      }
    }

    return result
  }

  // ══════════════════════════════════════════
  //  钩子方法 — getFormattedContext
  // ══════════════════════════════════════════

  /**
   * getFormattedContext 预处理钩子。
   *
   * 先检查缓存 → 再运行插件的 preGetFormattedContext。
   * 返回 proceed=false + context 表示直接返回缓存/插件结果。
   */
  preProcessGetFormattedContext(): { proceed: boolean; context?: string } {
    this.totalRequests++

    // ── ① 运行所有插件的 preGetFormattedContext ──
    for (const plugin of this.plugins) {
      if (plugin.preGetFormattedContext) {
        try {
          const result = plugin.preGetFormattedContext()
          if (!result.proceed && result.context !== undefined) {
            this.filteredRequests++
            return { proceed: false, context: result.context }
          }
        } catch (err) {
          this.errorCount++
          log('WARN', 'memory_sidecar_pre_get_context_error', {
            plugin: plugin.name,
            error: String(err),
          })
        }
      }
    }

    // ── ② 缓存层 ──
    if (this.config.cache.enabled && this.contextCache) {
      if (Date.now() - this.contextCache.timestamp <= this.config.cache.ttlMs) {
        this.cacheHits++
        return { proceed: false, context: this.contextCache.data }
      }
      this.contextCache = null
    }

    return { proceed: true }
  }

  /**
   * getFormattedContext 后处理钩子。
   *
   * 写入缓存 → 运行插件的 postGetFormattedContext 进行转换。
   */
  postProcessGetFormattedContext(context: string): string {
    if (!context) return context

    let result = context

    // ── ① 写入缓存 ──
    if (this.config.cache.enabled) {
      this.contextCache = { data: result, timestamp: Date.now() }
    }

    // ── ② 运行所有插件的 postGetFormattedContext ──
    for (const plugin of this.plugins) {
      if (plugin.postGetFormattedContext) {
        try {
          const transformed = plugin.postGetFormattedContext(result)
          if (transformed !== result) {
            this.transformedEntries++
          }
          result = transformed
        } catch (err) {
          this.errorCount++
          log('WARN', 'memory_sidecar_post_get_context_error', {
            plugin: plugin.name,
            error: String(err),
          })
        }
      }
    }

    return result
  }

  // ══════════════════════════════════════════
  //  钩子方法 — recordInteraction
  // ══════════════════════════════════════════

  /**
   * recordInteraction 后处理钩子。
   * 在 MemoryService.recordInteraction() 主逻辑后调用。
   */
  postProcessRecordInteraction(userText?: string): void {
    for (const plugin of this.plugins) {
      if (plugin.postRecordInteraction) {
        try {
          plugin.postRecordInteraction(userText)
        } catch (err) {
          this.errorCount++
          log('WARN', 'memory_sidecar_post_record_interaction_error', {
            plugin: plugin.name,
            error: String(err),
          })
        }
      }
    }
  }
}
