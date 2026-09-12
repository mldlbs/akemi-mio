/**
 * CreativityCollector 鈥?鍒涙剰鐐瑰瓙閲囬泦鍣? *
 * 浠?CreativityService 鐨?IdeaStore 涓鍙栭珮鍒?Hypothesis锛? * 杞崲涓虹閬撳彲娑堣垂鐨?Problem锛坰ource='feature'锛夛紝
 * 鐢?CreativityExecutor 钀藉湴瀹炵幇銆? */

import { log } from '@akemi-mio/core/logger/Logger'
import type { Problem, SignalCollector } from './types'
import { ideaStore } from '@akemi-mio/creativity'

export class CreativityCollector implements SignalCollector {
  readonly name = 'creativity'
  readonly source = 'feature' as const

  private lastRun = 0
  private minIntervalMs = 3 * 60 * 1000
  private store: typeof ideaStore

  constructor(store?: typeof ideaStore) {
    this.store = store ?? ideaStore
  }

  shouldRun(): boolean {
    if (!this.store) return false
    if (Date.now() - this.lastRun < this.minIntervalMs) return false
    return true
  }

  async collect(): Promise<Problem[]> {
    this.lastRun = Date.now()

    if (!this.store) {
      log('WARN', 'creativity_collector_no_store')
      return []
    }

    try {
      // 鍙彇宸插彂閰典负 active 鐨勯珮鍒嗗亣璁撅紙novelty >= 60, feasibility >= 40锛夛紝椤跺 3 涓?
      const all = this.store.getHypotheses()
      // 后置质量门禁: promote不代表执行, 需过综合分+内容深度关
      // composite >= 120 (300的40%), idea >= 30字, 不取已执行过的
      const candidates = all.filter((h) => {
        if (h.status !== 'active') return false
        if (h.implementedCommitSha) return false
        const composite = (h.novelty || 0) + (h.feasibility || 0) + (h.impact || 0)
        if (composite < 120) return false
        if (!h.title || !h.idea || h.idea.length < 30) return false
        return true
      })

      // 鎸夌患鍚堝垎鎺掑簭 (novelty + feasibility + impact)
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
