/**
 * RepositoryEventIterator — EvaluationRepository → EventIterator 适配器
 *
 * 将 Repository 的 query 接口适配为 EventIterator。
 * MetricsEngine 不直接依赖 Repository，只依赖 EventIterator。
 */
import type { EvaluationEvent, EventIterator, EvaluationRepository, TimeWindow, EventType } from './types'

export class RepositoryEventIterator implements EventIterator {
  private repo: EvaluationRepository

  constructor(repo: EvaluationRepository) {
    this.repo = repo
  }

  async getEvents(window: TimeWindow, options?: { type?: EventType }): Promise<EvaluationEvent[]> {
    return this.repo.query({
      since: window.since,
      until: window.until,
      type: options?.type,
    })
  }
}
