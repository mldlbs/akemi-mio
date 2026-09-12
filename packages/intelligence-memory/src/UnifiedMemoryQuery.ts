import { log } from '@akemi-mio/core/logger/Logger'
import type { IMemoryPlugin, MemoryRetrievalResult } from './IMemoryPlugin'

export interface QueryResult {
  store: string
  content: string
  score: number
  metadata: Record<string, any>
  timestamp: number
}

export interface MemoryQueryOptions {
  types?: ('user_fact' | 'engineering' | 'summary' | 'knowledge_graph' | 'vector')[]
  topK?: number
  minConfidence?: number
}

export class UnifiedMemoryQuery {
  /** 向后兼容：通用 store map（支持非 IMemoryPlugin 对象） */
  private stores = new Map<string, any>()
  /** 正式插件注册表 */
  private plugins = new Map<string, IMemoryPlugin>()

  /** 注册通用 store（向后兼容） */
  register(name: string, store: any): void {
    this.stores.set(name, store)
  }

  /** 注册 IMemoryPlugin 插件 */
  registerPlugin(plugin: IMemoryPlugin): void {
    this.plugins.set(plugin.name, plugin)
    log('INFO', 'umq_plugin_registered', { plugin: plugin.name })
  }

  /** 注销插件 */
  unregisterPlugin(name: string): boolean {
    return this.plugins.delete(name)
  }

  /** 获取所有已注册的插件名 */
  getPluginNames(): string[] {
    return [...this.plugins.keys()]
  }

  /**
   * 获取已注册的插件实例（按名）。
   * 用于外部适配（如知识源统一查询引擎）。
   */
  getPlugin(name: string): IMemoryPlugin | undefined {
    return this.plugins.get(name)
  }

  /**
   * 获取所有已注册的插件条目（名+实例）。
   * 用于批量适配到其他接口。
   */
  getAllPlugins(): IMemoryPlugin[] {
    return Array.from(this.plugins.values())
  }

  async query(text: string, options?: MemoryQueryOptions): Promise<QueryResult[]> {
    const topK = options?.topK || 5
    const results: QueryResult[] = []

    // 1. 优先通过插件接口检索
    for (const [name, plugin] of this.plugins) {
      if (options?.types && !options.types.includes(name as any)) continue
      try {
        const pluginResults = await plugin.retrieve(text, topK)
        for (const pr of pluginResults) {
          if (options?.minConfidence && pr.score < options.minConfidence) continue
          results.push({
            store: name,
            content: pr.content,
            score: pr.score,
            metadata: pr.metadata || {},
            timestamp: pr.timestamp || Date.now(),
          })
        }
      } catch {
        log('WARN', 'umq_plugin_query_failed', { plugin: name })
      }
    }

    // 2. 向后兼容：查询传统 store
    for (const [name, store] of this.stores) {
      if (options?.types && !options.types.includes(name as any)) continue
      // 如果同名插件已注册，跳过传统 store
      if (this.plugins.has(name)) continue
      try {
        if (typeof store.search === 'function') {
          const entries = await Promise.resolve(store.search(text, topK))
          if (Array.isArray(entries)) {
            for (const e of entries) {
              const score = e.confidence || e.score || 0.5
              if (options?.minConfidence && score < options.minConfidence) continue
              results.push({
                store: name,
                content: e.content || e.summary || '',
                score,
                metadata: { type: e.type },
                timestamp: e.updatedAt || e.createdAt || Date.now(),
              })
            }
          }
        } else if (typeof store.query === 'function') {
          const entries = await Promise.resolve(store.query(text))
          if (Array.isArray(entries)) {
            for (const e of entries) {
              results.push({
                store: name,
                content: e.value || e.content || '',
                score: e.confidence || 0.5,
                metadata: { entity: e.entity, attribute: e.attribute },
                timestamp: Date.now(),
              })
            }
          }
        } else if (typeof store.getFormattedContext === 'function') {
          const ctx = await Promise.resolve(store.getFormattedContext())
          if (ctx) results.push({ store: name, content: ctx.slice(0, 200), score: 0.5, metadata: {}, timestamp: Date.now() })
        }
      } catch {
        log('WARN', 'umq_store_query_failed', { store: name })
      }
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, topK)
  }

  /**
   * 通过插件接口批量更新记忆。
   * 在对话结束后调用，各插件异步持久化摘要和知识实体。
   */
  async updateAll(input: {
    userMessage: string
    assistantReply: string
    topics?: string[]
    decisions?: string[]
    entities?: string[]
    metadata?: Record<string, unknown>
  }): Promise<void> {
    const pluginInput = {
      userMessage: input.userMessage,
      assistantReply: input.assistantReply,
      topics: input.topics || [],
      decisions: input.decisions || [],
      entities: input.entities || [],
      timestamp: Date.now(),
      metadata: input.metadata || {},
    }

    const promises: Promise<void>[] = []
    for (const [name, plugin] of this.plugins) {
      if (plugin.update) {
        promises.push(
          plugin.update(pluginInput).catch((err) => {
            log('WARN', 'umq_plugin_update_failed', { plugin: name, error: String(err) })
          }),
        )
      }
    }
    await Promise.allSettled(promises)
  }

  async getFormattedContext(options?: MemoryQueryOptions): Promise<string> {
    const results = await this.query('', { ...options, topK: 10 })
    if (results.length === 0) return ''
    const parts = ['---', '【综合记忆上下文】']
    for (const r of results) parts.push(`[${r.store}] ${r.content.slice(0, 200)}`)
    parts.push('---')
    return parts.join('\n')
  }

  /**
   * 通过插件接口获取所有已注册插件的格式化上下文。
   * 比 query() 更高效，直接调用各插件的 getContext()。
   */
  async getPluginContexts(query?: string): Promise<string> {
    const parts: string[] = []
    for (const [name, plugin] of this.plugins) {
      try {
        if (plugin.getContext) {
          const ctx = await Promise.resolve(plugin.getContext(query))
          if (ctx) parts.push(ctx)
        }
      } catch {
        log('WARN', 'umq_plugin_context_failed', { plugin: name })
      }
    }
    return parts.join('\n')
  }
}
