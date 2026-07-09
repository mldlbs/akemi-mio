/**
 * ProceduralMemoryAdapter — 将 ProceduralMemory 适配为 ReadableStore + WritableStore
 *
 * 映射关系：
 * - search  ←  findByEmbedding + findByKeywords
 * - getContext  ←  getFormattedContext
 * - store  ←  save / recordHit / recordFail
 * - delete  — 不支持删除（自动 pruning）
 */
import type { ProceduralMemory, Procedure } from '../../agent/ProceduralMemory'
import type { ReadableStore, WritableStore, StoreType, SearchOptions, SearchResult, WriteInput, WriteResult } from '../types'

export class ProceduralMemoryAdapter implements WritableStore {
  readonly name = 'procedural_memory'
  readonly type: StoreType = 'agent'

  constructor(private memory: ProceduralMemory) {}

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const topK = options?.topK || 5
    const queries = query.split(/\s+/).filter(Boolean)

    // 语义搜索
    const byEmbedding = this.memory.findByEmbedding(query, topK)
    // 关键词搜索
    const byKeywords = queries.length > 0 ? this.memory.findByKeywords(queries, topK) : []

    // 合并去重
    const seen = new Set<string>()
    const results: SearchResult[] = []

    const pushResult = (proc: Procedure, score: number) => {
      if (seen.has(proc.id)) return
      seen.add(proc.id)
      results.push({
        id: proc.id,
        content: `${proc.name}: ${proc.description}\n步骤: ${proc.steps.map((s, i) => `${i + 1}.${s}`).join(' → ')}`,
        score,
        source: this.name,
        sourceType: this.type,
        metadata: {
          name: proc.name,
          description: proc.description,
          steps: proc.steps,
          triggerKeywords: proc.triggerKeywords,
          successCount: proc.successCount,
          failCount: proc.failCount,
        },
        timestamp: proc.updatedAt,
      })
    }

    for (const p of byEmbedding) pushResult(p, 0.8)
    for (const p of byKeywords) pushResult(p, 0.6)

    if (options?.minScore !== undefined) {
      return results.filter((r) => r.score >= options.minScore!)
    }

    return results.sort((a, b) => b.score - a.score).slice(0, topK)
  }

  async getContext(keywords?: string[]): Promise<string> {
    return this.memory.getFormattedContext(keywords)
  }

  async store(input: WriteInput): Promise<WriteResult> {
    if (input.type === 'hit') {
      this.memory.recordHit(input.content)
      return { success: true }
    }
    if (input.type === 'fail') {
      this.memory.recordFail(input.content)
      return { success: true }
    }

    // 默认保存为 procedure
    const metadata = input.metadata || {}
    const procedure = this.memory.save({
      name: input.content.slice(0, 40),
      description: input.content,
      steps: (metadata.steps as string[]) || [],
      triggerKeywords: (metadata.triggerKeywords as string[]) || [],
    })

    return { success: true, id: procedure.id }
  }

  async delete(_id: string): Promise<boolean> {
    // ProceduralMemory 不支持外部删除，自动 pruning 管理容量
    return false
  }

  getStats(): Record<string, unknown> {
    const all = this.memory.listAll()
    return {
      totalProcedures: all.length,
      avgSuccessCount: all.reduce((s, p) => s + p.successCount, 0) / (all.length || 1),
      avgFailCount: all.reduce((s, p) => s + p.failCount, 0) / (all.length || 1),
    }
  }
}
