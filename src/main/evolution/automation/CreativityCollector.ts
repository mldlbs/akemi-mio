/**
 * CreativityCollector — 创意点子采集器
 *
 * 从 CreativityService 的 IdeaStore 中读取高分 Hypothesis，
 * 转换为管道可消费的 Problem（source='feature'），
 * 由 CreativityExecutor 落地实现。
 */

import { log } from '../../logger/Logger'
import type { Problem, SignalCollector } from './types'
import { ideaStore } from '../../creativity'

export class CreativityCollector implements SignalCollector {
  readonly name = 'creativity'
  readonly source = 'feature' as const

  private lastRun = 0
  private minIntervalMs = 30 * 60 * 1000

  shouldRun(): boolean {
    if (!ideaStore) return false
    if (Date.now() - this.lastRun < this.minIntervalMs) return false
    return true
  }

  async collect(): Promise<Problem[]> {
    this.lastRun = Date.now()

    if (!ideaStore) {
      log('WARN', 'creativity_collector_no_store')
      return []
    }

    try {
      // 取高分 draft/active 假设（novelty >= 60, feasibility >= 40），顶多 3 个
      const all = ideaStore.getHypotheses()
      const candidates = all.filter(
        (h) => (h.status === 'draft' || h.status === 'active') && (h.novelty || 0) >= 60 && (h.feasibility || 0) >= 40 && h.title && h.idea,
      )

      // 按综合分排序 (novelty + feasibility + impact)
      candidates.sort((a, b) => {
        const scoreA = (a.novelty || 0) + (a.feasibility || 0) + (a.impact || 0)
        const scoreB = (b.novelty || 0) + (b.feasibility || 0) + (b.impact || 0)
        return scoreB - scoreA
      })

      const topN = candidates.slice(0, 3)

      const problems: Problem[] = topN.map((h) => ({
        id: `feature:${h.id}`,
        source: 'feature',
        severity: 'info' as const,
        title: h.title,
        description: h.idea,
        estimatedCostChars: (h.idea?.length || 100) + (h.implementationDifficulty || 3) * 200,
        lastSeen: h.createdAt,
        occurrenceCount: 1,
        context: {
          raw: h.idea || '',
          snippet: h.perspectives ? `${h.perspectives.self}\n---\n${h.perspectives.user}` : undefined,
          metadata: {
            hypothesisId: h.id,
            novelty: String(h.novelty || 0),
            feasibility: String(h.feasibility || 0),
            impact: String(h.impact || 0),
            expectedBenefit: h.expectedBenefit || '',
            risk: h.risk || '',
            implementationDifficulty: String(h.implementationDifficulty || 3),
            sourceLabels: (h.sourceLabels || []).join(', '),
          },
        },
      }))

      log('INFO', 'creativity_collector_done', {
        total: all.length,
        candidates: candidates.length,
        problems: problems.length,
      })

      return problems
    } catch (err: any) {
      log('ERROR', 'creativity_collector_error', { error: err.message })
      return []
    }
  }
}
