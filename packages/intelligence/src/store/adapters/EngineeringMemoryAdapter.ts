/**
 * EngineeringMemoryAdapter — 将 EngineeringMemory 适配为 ReadableStore + WritableStore
 *
 * 映射关系：
 * - search  ←  search（SQL LIKE 全文搜索）+ query（按类型过滤）
 * - getContext  ←  getFormattedContext
 * - store  ←  store
 * - 不支持删除（自动 pruning）
 */
import type { EngineeringMemory } from '@akemi-mio/intelligence-memory/EngineeringMemory'
import type { ReadableStore, WritableStore, StoreType, SearchOptions, SearchResult, WriteInput, WriteResult } from '@akemi-mio/intelligence/store/types'

export class EngineeringMemoryAdapter implements WritableStore {
  readonly name = 'engineering_memory'
  readonly type: StoreType = 'memory'

  constructor(private memory: EngineeringMemory) {}

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const topK = options?.topK || 5
    const typeFilter = options?.filter?.type as string | undefined

    const entries = typeFilter ? this.memory.query({ types: [typeFilter], topK }) : this.memory.search(query, topK)

    // 如果搜索词存在，结合 search 和 query 结果
    if (query && !typeFilter) {
      const byQuery = this.memory.query({ topK }).filter((e) => {
        const lower = query.toLowerCase()
        return (
          e.content.toLowerCase().includes(lower) ||
          e.tags.some((t) => t.toLowerCase().includes(lower)) ||
          e.source.toLowerCase().includes(lower)
        )
      })
      // 合并去重
      const seen = new Set(entries.map((e) => e.id))
      for (const e of byQuery) {
        if (!seen.has(e.id)) {
          seen.add(e.id)
          entries.push(e)
        }
      }
    }

    const results: SearchResult[] = entries.map((e) => ({
      id: e.id,
      content: e.content,
      score: e.confidence,
      source: this.name,
      sourceType: this.type,
      metadata: {
        type: e.type,
        source: e.source,
        confidence: e.confidence,
        relatedFiles: e.relatedFiles,
        tags: e.tags,
      },
      timestamp: e.updatedAt,
    }))

    if (options?.minScore !== undefined) {
      return results.filter((r) => r.score >= options.minScore!)
    }

    return results.slice(0, topK)
  }

  async getContext(_keywords?: string[]): Promise<string> {
    return this.memory.getFormattedContext()
  }

  async store(input: WriteInput): Promise<WriteResult> {
    this.memory.store({
      type: (input.type as any) || 'architecture_pattern',
      content: input.content,
      source: 'store_adapter',
      confidence: input.confidence ?? 0.5,
      relatedFiles: (input.metadata?.relatedFiles as string[]) || [],
      tags: input.tags || [],
    })

    return { success: true }
  }

  async delete(_id: string): Promise<boolean> {
    // EngineeringMemory 不支持外部删除，自动 pruning 管理容量
    return false
  }

  getStats(): Record<string, unknown> {
    const all = this.memory.query({ topK: 999 })
    const byType: Record<string, number> = {}
    for (const e of all) {
      byType[e.type] = (byType[e.type] || 0) + 1
    }
    return {
      totalEntries: all.length,
      byType,
      avgConfidence: all.reduce((s, e) => s + e.confidence, 0) / (all.length || 1),
    }
  }
}
