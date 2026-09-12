/**
 * KnowledgeBaseService — 跨存储知识整合编排器
 *
 * 跨 MemoryService / SummaryMemory / KnowledgeGraph / EngineeringMemory / DecisionStore 五个存储：
 * 1. 统一查询并去重（精确匹配 + 前缀模糊匹配）
 * 2. 按优先级排序：permanent fact(100) > engineering(70) > summary(60) > ephemeral(40) > kg(30) > decision(10)
 * 3. 交叉引用：当 user_fact 话题也出现在 summary 中时合并标注
 */

import { log } from '@akemi-mio/core/logger/Logger'

export type KBStoreName = 'memory' | 'vector' | 'summary' | 'kg' | 'engineering' | 'decisions'

export interface KBResult {
  content: string
  source: KBStoreName
  priority: number
  confidence: number
  timestamp: number
  dedupKey: string
  crossReferences?: string[]
}

export interface KBQueryOptions {
  topK?: number
  includeStores?: KBStoreName[]
  minConfidence?: number
  queryText?: string
}

const PRIORITY_MAP: Record<KBStoreName, number> = {
  memory: 40,
  vector: 30,
  summary: 60,
  kg: 30,
  engineering: 70,
  decisions: 10,
}

export class KnowledgeBaseService {
  private memoryService: any = null
  private unifiedQuery: any = null

  setDeps(deps: { memoryService: any; unifiedQuery: any }): void {
    this.memoryService = deps.memoryService
    this.unifiedQuery = deps.unifiedQuery
  }

  /** 跨存储统一查询 */
  query(options: KBQueryOptions = {}): KBResult[] {
    const results: KBResult[] = []
    const ms = this.memoryService
    if (!ms) return results

    const topK = options.topK || 10
    const minConfidence = options.minConfidence || 0

    // 1. MemoryService entries
    if (!options.includeStores || options.includeStores.includes('memory')) {
      for (const entry of ms.getEntries?.() || []) {
        if (entry.confidence < minConfidence) continue
        results.push(
          this.toResult(entry.content, 'memory', entry.confidence, entry.tier === 'permanent' ? 100 : PRIORITY_MAP.memory, entry.updatedAt),
        )
      }
    }

    // 2. SummaryMemory
    if ((!options.includeStores || options.includeStores.includes('summary')) && ms.summary) {
      for (const s of ms.summary.getAll?.() || []) {
        results.push(this.toResult(s.summary || s, 'summary', 0.6, PRIORITY_MAP.summary, s.turnEnd || s.createdAt || Date.now()))
      }
    }

    // 3. KnowledgeGraph
    if ((!options.includeStores || options.includeStores.includes('kg')) && ms.knowledgeGraph) {
      const kgCtx = ms.knowledgeGraph.getFormattedContext?.()
      if (kgCtx) {
        for (const line of kgCtx.split('\n')) {
          const trimmed = line.replace(/^-\s*/, '').trim()
          if (trimmed.length > 5) {
            results.push(this.toResult(trimmed, 'kg', 0.6, PRIORITY_MAP.kg, Date.now()))
          }
        }
      }
    }

    // 4. EngineeringMemory
    if ((!options.includeStores || options.includeStores.includes('engineering')) && ms.engineering) {
      const allEng = ms.engineering.getAll?.() || []
      for (const e of allEng.slice(0, 20)) {
        results.push(this.toResult(e.content, 'engineering', e.confidence || 0.5, PRIORITY_MAP.engineering, e.updatedAt || Date.now()))
      }
    }

    // 5. DecisionStore
    if ((!options.includeStores || options.includeStores.includes('decisions')) && ms.decisionStore) {
      const recentDecisions = ms.decisionStore.query?.({ limit: 10 }) || []
      for (const d of recentDecisions) {
        const text = `[${d.category}] ${d.choice?.slice(0, 60)}`
        results.push(this.toResult(text, 'decisions', d.confidence || 0.3, PRIORITY_MAP.decisions, d.timestamp || Date.now()))
      }
    }

    // Dedup
    const deduped = this.deduplicate(results)
    // Cross-reference
    const withRefs = this.crossReference(deduped)

    // Sort by priority desc, then confidence desc
    withRefs.sort((a, b) => b.priority - a.priority || b.confidence - a.confidence)
    return withRefs.slice(0, topK)
  }

  private toResult(content: string, source: KBStoreName, confidence: number, priority: number, timestamp: number): KBResult {
    return {
      content: content.slice(0, 300),
      source,
      priority,
      confidence,
      timestamp,
      dedupKey: this.computeDedupKey(content),
    }
  }

  /** 精确去重 + 前缀模糊去重 */
  private deduplicate(results: KBResult[]): KBResult[] {
    const seen = new Map<string, KBResult>()

    for (const r of results) {
      const existing = seen.get(r.dedupKey)
      if (existing) {
        if (r.priority > existing.priority) {
          seen.set(r.dedupKey, r)
          r.crossReferences = [...(r.crossReferences || []), existing.source]
        } else {
          existing.crossReferences = [...(existing.crossReferences || []), r.source]
        }
        continue
      }

      let merged = false
      for (const [key, e] of seen) {
        if (this.fuzzyMatch(key, r.dedupKey)) {
          if (r.priority > e.priority) {
            seen.set(key, r)
            r.crossReferences = [...(r.crossReferences || []), e.source]
          } else {
            e.crossReferences = [...(e.crossReferences || []), r.source]
          }
          merged = true
          break
        }
      }
      if (!merged) {
        seen.set(r.dedupKey, r)
      }
    }

    return Array.from(seen.values())
  }

  private computeDedupKey(content: string): string {
    return content
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]/g, '')
      .slice(0, 100)
  }

  private fuzzyMatch(a: string, b: string): boolean {
    if (a === b) return false
    const shorter = a.length < b.length ? a : b
    const longer = a.length < b.length ? b : a
    if (shorter.length >= 10 && longer.startsWith(shorter)) return true
    const overlap = [...shorter].filter((c) => longer.includes(c)).length
    return overlap / longer.length >= 0.8 && longer.length > 10
  }

  /** 交叉引用：当不同存储的内容涉及相同话题时合并标注 */
  private crossReference(results: KBResult[]): KBResult[] {
    for (let i = 0; i < results.length; i++) {
      for (let j = i + 1; j < results.length; j++) {
        const a = results[i]
        const b = results[j]
        if (a.source === b.source) continue
        const wordsA = this.extractKeywords(a.content)
        const wordsB = this.extractKeywords(b.content)
        const shared = wordsA.filter((w) => wordsB.includes(w))
        if (shared.length >= 2) {
          if (!a.crossReferences) a.crossReferences = []
          if (!a.crossReferences.includes(b.source)) a.crossReferences.push(b.source)
          if (!b.crossReferences) b.crossReferences = []
          if (!b.crossReferences.includes(a.source)) b.crossReferences.push(a.source)
        }
      }
    }
    return results
  }

  private extractKeywords(text: string): string[] {
    const words = text.match(/[a-zA-Z]{3,}/g) || []
    const chinese = text.match(/[一-鿿]{2,}/g) || []
    return [...new Set([...words.map((w) => w.toLowerCase()), ...chinese])]
  }

  /** 构建格式化上下文块（用于 system prompt 注入） */
  getFormattedContext(options?: { queryText?: string; topK?: number }): string {
    const results = this.query({ ...options, topK: options?.topK || 15 })
    if (results.length === 0) return ''

    const parts: string[] = ['【知识库】']
    for (const r of results) {
      let prefix = `[${this.storeLabel(r.source)}]`
      if (r.crossReferences?.length) {
        prefix += `(关联:${r.crossReferences.map((s) => this.storeLabel(s as KBStoreName)).join(',')})`
      }
      parts.push(`- ${prefix} ${r.content.slice(0, 150)}`)
      if (r.priority >= 90) {
        parts[parts.length - 1] += ' ⭐'
      }
    }
    return parts.join('\n')
  }

  private storeLabel(store: KBStoreName): string {
    const labels: Record<KBStoreName, string> = {
      memory: '记忆',
      vector: '向量',
      summary: '摘要',
      kg: '知识图谱',
      engineering: '工程模式',
      decisions: '决策',
    }
    return labels[store] || store
  }
}
