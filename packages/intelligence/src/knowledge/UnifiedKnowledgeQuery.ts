/**
 * UnifiedKnowledgeQuery — 统一的跨知识源查询引擎
 *
 * 注册所有 IKnowledgeSource 实现（Memory + Agent 侧），
 * 对外提供统一查询/上下文获取入口。
 * 调用方无需关注底层是 MemoryService、ProceduralMemory 还是 ReflectLoop。
 *
 * 与 UnifiedMemoryQuery 的关系：
 * - UnifiedMemoryQuery 仅覆盖 Memory 侧 store（设计更早）
 * - UnifiedKnowledgeQuery 覆盖 Memory + Agent 侧所有知识源（本层抽象）
 * - 两者可共存，后者更全
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { IKnowledgeSource, IMutableKnowledgeSource, KnowledgeItem, QueryOptions, SaveInput } from './IKnowledgeSource'
import { isMutable } from './IKnowledgeSource'

export type { IKnowledgeSource, IMutableKnowledgeSource, KnowledgeItem, QueryOptions, SaveInput }

export class UnifiedKnowledgeQuery {
  /** 所有已注册的知识源（策略模式的具体实现集合） */
  private sources = new Map<string, IKnowledgeSource>()

  // ════════════════════════════════════════
  //  注册 / 注销
  // ════════════════════════════════════════

  /**
   * 注册一个知识源。
   * 同名源会覆盖旧注册（最后注册的生效）。
   */
  register(source: IKnowledgeSource): void {
    if (this.sources.has(source.name)) {
      log('INFO', 'ukq_source_replaced', { name: source.name })
    }
    this.sources.set(source.name, source)
    log('INFO', 'ukq_source_registered', { name: source.name })
  }

  /**
   * 注销一个知识源。
   * @returns true 表示成功移除
   */
  unregister(name: string): boolean {
    const removed = this.sources.delete(name)
    if (removed) {
      log('INFO', 'ukq_source_unregistered', { name })
    }
    return removed
  }

  /** 获取所有已注册的知识源名 */
  getSourceNames(): string[] {
    return Array.from(this.sources.keys())
  }

  /** 获取已注册的知识源实例（按名） */
  getSource(name: string): IKnowledgeSource | undefined {
    return this.sources.get(name)
  }

  /** 获取所有已注册的知识源 */
  getAllSources(): IKnowledgeSource[] {
    return Array.from(this.sources.values())
  }

  /** 获取所有可写的知识源 */
  getMutableSources(): IMutableKnowledgeSource[] {
    return this.getAllSources().filter(isMutable)
  }

  // ════════════════════════════════════════
  //  只读操作
  // ════════════════════════════════════════

  /**
   * 跨所有已注册知识源的统一语义查询。
   * 结果按得分排序，来源混合。
   *
   * @param query - 查询文本
   * @param options - 可过滤 sourceNames，限制 topK
   * @returns 合并排序后的结果
   */
  async query(query: string, options?: QueryOptions): Promise<KnowledgeItem[]> {
    const topK = options?.topK ?? 5
    const sourceFilter = options?.sourceNames
    const results: KnowledgeItem[] = []

    const targetSources = sourceFilter
      ? (sourceFilter.map((n) => this.sources.get(n)).filter(Boolean) as IKnowledgeSource[])
      : Array.from(this.sources.values())

    await Promise.allSettled(
      targetSources.map(async (source) => {
        try {
          const items = await source.query(query, { topK })
          results.push(...items)
        } catch (err) {
          log('WARN', 'ukq_query_failed', { source: source.name, error: String(err) })
        }
      }),
    )

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, Math.max(topK, 10))
  }

  /**
   * 获取所有知识源的合并格式化上下文。
   * 按源逐一调用 getContext() 合并。
   *
   * @param query - 可选的定向查询
   * @returns 合并后的上下文字符串，无内容时返回 ''
   */
  async getCombinedContext(query?: string): Promise<string> {
    const parts: string[] = []

    for (const [name, source] of this.sources) {
      try {
        const ctx = await Promise.resolve(source.getContext(query))
        if (ctx) parts.push(ctx)
      } catch (err) {
        log('WARN', 'ukq_context_failed', { source: name, error: String(err) })
      }
    }

    return parts.join('\n\n')
  }

  /**
   * 获取单个知识源的格式化上下文。
   */
  async getSourceContext(name: string, query?: string): Promise<string> {
    const source = this.sources.get(name)
    if (!source) {
      log('WARN', 'ukq_source_not_found', { name })
      return ''
    }
    try {
      return await Promise.resolve(source.getContext(query))
    } catch (err) {
      log('WARN', 'ukq_source_context_failed', { name, error: String(err) })
      return ''
    }
  }

  // ════════════════════════════════════════
  //  写操作（委托给可写源）
  // ════════════════════════════════════════

  /**
   * 向指定知识源保存条目。
   * 如果目标源不支持写操作，返回 false。
   */
  async saveTo(name: string, input: SaveInput): Promise<string | false> {
    const source = this.sources.get(name)
    if (!source) {
      log('WARN', 'ukq_save_source_not_found', { name })
      return false
    }
    if (!isMutable(source)) {
      log('WARN', 'ukq_save_source_not_mutable', { name })
      return false
    }
    try {
      return await source.save(input)
    } catch (err) {
      log('WARN', 'ukq_save_failed', { name, error: String(err) })
      return false
    }
  }

  /**
   * 从指定知识源删除条目。
   */
  async deleteFrom(name: string, id: string): Promise<boolean> {
    const source = this.sources.get(name)
    if (!source) {
      log('WARN', 'ukq_delete_source_not_found', { name })
      return false
    }
    if (!isMutable(source)) {
      log('WARN', 'ukq_delete_source_not_mutable', { name })
      return false
    }
    try {
      return await source.delete(id)
    } catch (err) {
      log('WARN', 'ukq_delete_failed', { name, error: String(err) })
      return false
    }
  }

  // ════════════════════════════════════════
  //  生命周期
  // ════════════════════════════════════════

  /** 清理所有已注册知识源的资源 */
  async disposeAll(): Promise<void> {
    for (const [name, source] of this.sources) {
      try {
        await source.dispose?.()
      } catch (err) {
        log('WARN', 'ukq_dispose_failed', { name, error: String(err) })
      }
    }
    this.sources.clear()
  }

  /** 获取注册数量统计 */
  stats(): { total: number; names: string[]; mutableCount: number } {
    const all = Array.from(this.sources.values())
    return {
      total: all.length,
      names: all.map((s) => s.name),
      mutableCount: all.filter(isMutable).length,
    }
  }
}
