/**
 * StrategyEngineAdapter — 将 StrategyEngine 适配为 ReadableStore（只读）
 *
 * 映射关系：
 * - search  ←  getActive（按上下文关键词过滤）
 * - getContext  ←  getFormattedContext
 * - 写入通过 create 实现，但保持只读以降低抽象风险
 */
import type { StrategyEngine } from '@akemi-mio/intelligence/cognitive/StrategyEngine'
import type { ReadableStore, StoreType, SearchOptions, SearchResult } from '@akemi-mio/intelligence/store/types'

export class StrategyEngineAdapter implements ReadableStore {
  readonly name = 'strategy_engine'
  readonly type: StoreType = 'cognitive'

  constructor(private engine: StrategyEngine) {}

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const queryLower = query.toLowerCase()
    const keywords = query ? [queryLower] : []

    const strategies = this.engine.getActive(keywords)
    const results: SearchResult[] = strategies.map((s) => ({
      id: s.id,
      content: `[${s.name}] ${s.description}\n适用场景: ${s.applicableContext}`,
      score: s.priority / 10,
      source: this.name,
      sourceType: this.type,
      metadata: {
        name: s.name,
        description: s.description,
        promptTemplate: s.promptTemplate,
        applicableContext: s.applicableContext,
        priority: s.priority,
        version: s.version,
      },
      timestamp: s.updatedAt,
    }))

    if (options?.topK) {
      return results.slice(0, options.topK)
    }

    return results
  }

  async getContext(keywords?: string[]): Promise<string> {
    return this.engine.getFormattedContext(keywords)
  }

  getStats(): Record<string, unknown> {
    const all = this.engine.getActive([])
    return {
      totalActive: all.length,
    }
  }
}
