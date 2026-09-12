/**
 * FailureAnalyzerAdapter — 将 FailureAnalyzer 适配为 ReadableStore（只读）
 *
 * 映射关系：
 * - search  ←  getHotPatterns（按类型/名称过滤）
 * - getContext  ←  getFormattedContext
 * - 不支持写入（FailureAnalyzer 通过 EventBus 被动收集数据）
 */
import type { FailureAnalyzer } from '@akemi-mio/intelligence/agent/FailureAnalyzer'
import type { ReadableStore, StoreType, SearchOptions, SearchResult } from '@akemi-mio/intelligence/store/types'

export class FailureAnalyzerAdapter implements ReadableStore {
  readonly name = 'failure_analyzer'
  readonly type: StoreType = 'agent'

  constructor(private analyzer: FailureAnalyzer) {}

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const topK = options?.topK || 5
    const hotPatterns = this.analyzer.getHotPatterns(topK)
    const queryLower = query.toLowerCase()

    const results: SearchResult[] = hotPatterns
      .filter((p) => {
        // 过滤：查询匹配类型、名称或错误信息
        if (!queryLower) return true
        const typeMatch = Array.from(p.types).some((t) => t.toLowerCase().includes(queryLower))
        const nameMatch = Array.from(p.names).some((n) => n.toLowerCase().includes(queryLower))
        const errorMatch = p.errors.some((e) => e.toLowerCase().includes(queryLower))
        return typeMatch || nameMatch || errorMatch
      })
      .map((p) => ({
        content: `【失败模式】类型: ${Array.from(p.types).join(',')} | 出现 ${p.count} 次 | 涉及: ${Array.from(p.names).join(', ')} | 错误: ${(p.errors[0] || '').slice(0, 120)}`,
        score: Math.min(0.9, 0.3 + p.count * 0.1),
        source: this.name,
        sourceType: this.type,
        metadata: {
          fingerprint: p.fingerprint,
          count: p.count,
          types: Array.from(p.types),
          names: Array.from(p.names),
          errors: p.errors,
          firstSeen: p.firstSeen,
          lastSeen: p.lastSeen,
        },
        timestamp: p.lastSeen,
      }))

    if (options?.minScore !== undefined) {
      return results.filter((r) => r.score >= options.minScore!)
    }

    return results
  }

  async getContext(_keywords?: string[]): Promise<string> {
    return this.analyzer.getFormattedContext()
  }

  getStats(): Record<string, unknown> {
    return this.analyzer.getStats()
  }
}
