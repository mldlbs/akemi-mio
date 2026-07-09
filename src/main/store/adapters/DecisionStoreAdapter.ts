/**
 * DecisionStoreAdapter — 将 DecisionStore 适配为 ReadableStore + WritableStore
 *
 * 映射关系：
 * - search  ←  query（按类别/结果过滤）
 * - getContext  ←  getFormattedContext
 * - store  ←  record
 * - delete  — 不支持（自动 pruning）
 */
import type { DecisionStore, DecisionCategory } from '../../memory/DecisionStore'
import type { ReadableStore, WritableStore, StoreType, SearchOptions, SearchResult, WriteInput, WriteResult } from '../types'

export class DecisionStoreAdapter implements WritableStore {
  readonly name = 'decision_store'
  readonly type: StoreType = 'memory'

  constructor(private store: DecisionStore) {}

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const topK = options?.topK || 10
    const category = options?.filter?.category as DecisionCategory | undefined
    const outcome = options?.filter?.outcome as string | undefined
    const queryLower = query.toLowerCase()

    const records = this.store.query({
      categories: category ? [category] : undefined,
      outcome: outcome as any,
      limit: topK * 2, // 稍微多取，过滤后裁剪
    })

    const results: SearchResult[] = records
      .filter((r) => {
        if (!queryLower) return true
        return (
          r.choice.toLowerCase().includes(queryLower) ||
          r.context.toLowerCase().includes(queryLower) ||
          r.category.toLowerCase().includes(queryLower)
        )
      })
      .map((r) => ({
        id: r.id,
        content: `[${r.category}] 选择: ${r.choice} | 结果: ${r.outcome} (置信度 ${r.confidence.toFixed(2)})`,
        score: r.outcome === 'success' ? r.confidence : r.confidence * 0.5,
        source: this.name,
        sourceType: this.type,
        metadata: {
          agentId: r.agentId,
          category: r.category,
          context: r.context,
          choice: r.choice,
          alternatives: r.alternatives,
          outcome: r.outcome,
          confidence: r.confidence,
          relatedPlanId: r.relatedPlanId,
        },
        timestamp: r.timestamp,
      }))

    if (options?.minScore !== undefined) {
      return results.filter((r) => r.score >= options.minScore!)
    }

    return results.slice(0, topK)
  }

  async getContext(_keywords?: string[]): Promise<string> {
    return this.store.getFormattedContext()
  }

  async store(input: WriteInput): Promise<WriteResult> {
    const metadata = input.metadata || {}
    const id = this.store.record({
      agentId: (metadata.agentId as string) || 'store_adapter',
      category: (metadata.category as DecisionCategory) || 'tool_select',
      context: input.content,
      choice: (metadata.choice as string) || 'recorded',
      alternatives: (metadata.alternatives as string[]) || [],
      confidence: input.confidence ?? 0.5,
      relatedPlanId: metadata.relatedPlanId as string | undefined,
      outcome: (metadata.outcome as any) || 'pending',
    })

    return { success: true, id }
  }

  async delete(_id: string): Promise<boolean> {
    // 不支持外部删除
    return false
  }

  getStats(): Record<string, unknown> {
    const recent = this.store.query({ limit: 100 })
    const byCategory: Record<string, number> = {}
    let success = 0
    let failure = 0
    for (const r of recent) {
      byCategory[r.category] = (byCategory[r.category] || 0) + 1
      if (r.outcome === 'success') success++
      else if (r.outcome === 'failure') failure++
    }
    return {
      totalRecent: recent.length,
      byCategory,
      successCount: success,
      failureCount: failure,
      crossSession: this.store.getCrossSessionSummary(),
    }
  }
}
