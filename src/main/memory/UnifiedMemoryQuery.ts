import { log } from '../logger/Logger'

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
  private stores = new Map<string, any>()

  register(name: string, store: any): void {
    this.stores.set(name, store)
  }

  async query(text: string, options?: MemoryQueryOptions): Promise<QueryResult[]> {
    const topK = options?.topK || 5
    const results: QueryResult[] = []

    for (const [name, store] of this.stores) {
      if (options?.types && !options.types.includes(name as any)) continue
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

  async getFormattedContext(options?: MemoryQueryOptions): Promise<string> {
    const results = await this.query('', { ...options, topK: 10 })
    if (results.length === 0) return ''
    const parts = ['---', '【综合记忆上下文】']
    for (const r of results) parts.push(`[${r.store}] ${r.content.slice(0, 200)}`)
    parts.push('---')
    return parts.join('\n')
  }
}
