import { log } from '../logger/Logger'
import type { ObserverLlmService } from './ObserverLlmService'
import type { ObserverStore } from './ObserverStore'
import type { TrendReport, TopicCandidate, TopicSelection, EvolutionWeights } from './types'
import { DEFAULT_EVOLUTION_WEIGHTS } from './types'

const EXPLOIT_RATE = 0.8

const FALLBACK_TOPICS = ['今日观察到的事物之间的联系', '近期技术趋势中的矛盾与张力', '碎片信息中浮现的模式']

/**
 * TensionFieldEngine — 选题张力场（多因子版）
 *
 * 升级点：
 * - tension = contradiction + uncertainty + impact + velocity 四因子显式计算
 */
export class TensionFieldEngine {
  private llm: ObserverLlmService
  private store: ObserverStore

  constructor(llm: ObserverLlmService, store: ObserverStore) {
    this.llm = llm
    this.store = store
  }

  async selectTopic(trends: TrendReport, weights?: EvolutionWeights): Promise<TopicSelection> {
    const w = weights ?? this.store.readEvolutionParams()?.weights ?? DEFAULT_EVOLUTION_WEIGHTS

    // Level 0: 正常选题
    if (trends.signals.length > 0) {
      const candidates = await this.buildCandidates(trends, w)
      if (candidates.length > 0) {
        const selected = this.pickCandidate(candidates)
        const selection: TopicSelection = {
          selectedAt: new Date().toISOString(),
          topic: selected,
          fallback: false,
        }
        this.store.saveTopicSelection(selection)
        log('INFO', 'tension_topic_selected', { topic: selected.topic, probability: selected.probability })
        return selection
      }
    }

    // Level 1: 有 observations 但 trends 为空
    if (trends.sourceSummary.totalItemsReceived > 0) {
      const llmTopics = await this.suggestFromObservations(trends)
      if (llmTopics.length > 0) {
        const selection: TopicSelection = {
          selectedAt: new Date().toISOString(),
          topic: {
            topic: llmTopics[0].topic,
            popularity: 0.3,
            novelty: 0.5,
            diversity: 0.5,
            memoryGap: 0.5,
            tension: 0.5,
            probability: 0.5,
          },
          fallback: true,
          fallbackReason: 'trend_signals_empty_llm_suggest',
        }
        this.store.saveTopicSelection(selection)
        return selection
      }
    }

    // Level 3: 终极 fallback
    const fallbackTopic = FALLBACK_TOPICS[Math.floor(Math.random() * FALLBACK_TOPICS.length)]
    const selection: TopicSelection = {
      selectedAt: new Date().toISOString(),
      topic: {
        topic: fallbackTopic,
        popularity: 0.2,
        novelty: 0.5,
        diversity: 0.5,
        memoryGap: 0.5,
        tension: 0.3,
        probability: 0.3,
      },
      fallback: true,
      fallbackReason: 'full_fallback_no_signals_no_obs',
    }
    this.store.saveTopicSelection(selection)
    return selection
  }

  // ── private ──────────────────────────────────────────────

  private async buildCandidates(trends: TrendReport, w: EvolutionWeights): Promise<TopicCandidate[]> {
    const recentTopics = this.store.getRecentTopics(7)
    const recentTopicNames = recentTopics.map((s) => s.topic.topic)
    const world = this.store.readWorldModel()
    const worldEntityNames = world.entities.map((e) => e.name)
    const uncertainties = world.uncertainties ?? []

    const candidates: TopicCandidate[] = []

    for (const signal of trends.signals.slice(0, 10)) {
      const popularity = signal.score
      const novelty = await this.rateNovelty(signal.keyword, worldEntityNames)
      const diversity = this.calcDiversity(signal.keyword, recentTopicNames)
      const memoryGap = this.calcMemoryGap(signal.keyword, recentTopicNames)
      const tension = await this.calcMultiTension(signal.keyword, uncertainties, signal)
      const probability = w.alpha * popularity + w.beta * novelty + w.gamma * diversity + w.delta * memoryGap + w.epsilon * tension

      candidates.push({
        topic: signal.keyword,
        popularity,
        novelty,
        diversity,
        memoryGap,
        tension,
        probability: parseFloat(probability.toFixed(4)),
      })
    }

    candidates.sort((a, b) => b.probability - a.probability)
    return candidates
  }

  private pickCandidate(candidates: TopicCandidate[]): TopicCandidate {
    if (candidates.length === 0) throw new Error('empty candidates')
    const total = candidates.reduce((s, c) => s + c.probability, 0)
    if (total <= 0) return candidates[0]

    if (Math.random() < EXPLOIT_RATE) {
      const pool = candidates.slice(0, 3)
      const poolTotal = pool.reduce((s, c) => s + c.probability, 0)
      let r = Math.random() * poolTotal
      for (const c of pool) {
        r -= c.probability
        if (r <= 0) return c
      }
      return pool[0]
    } else {
      return candidates[Math.floor(Math.random() * candidates.length)]
    }
  }

  private async rateNovelty(keyword: string, worldEntities: string[]): Promise<number> {
    if (worldEntities.length === 0) return 0.8
    const pool = worldEntities.slice(0, 20).join('\n')
    const prompt = `关键词：「${keyword}」

已知实体：
${pool}

这个关键词和已知实体的语义相似度有多高？
0 = 完全不同, 1 = 完全相同

只输出一个 0-1 之间的数字。`
    const result = await this.llm.generateJson<number>(prompt, { temperature: 0.1, maxTokens: 128 })
    const similarity = typeof result.data === 'number' ? result.data : 0.5
    return parseFloat((1 - Math.min(1, Math.max(0, similarity))).toFixed(2))
  }

  private async calcMultiTension(
    keyword: string,
    uncertainties: { topic: string; confidence: number }[],
    signal: { score: number; sourceDiversity: number; occurrenceCount: number; lastSeenAt: string },
  ): Promise<number> {
    // contradiction — 关键词本身是否有冲突内涵
    const contradiction = await this.rateContradiction(keyword)
    // uncertainty — 世界模型中该实体的不确定度 (1 - 置信度均值)
    const related = uncertainties.filter((u) => u.topic.includes(keyword) || keyword.includes(u.topic))
    const uncertainty = related.length > 0 ? 1 - related.reduce((s, u) => s + u.confidence, 0) / related.length : 0.3
    // impact — 热度 × 源多样性的几何平均
    const impact = Math.sqrt(signal.score * signal.sourceDiversity)
    // velocity — 单位时间频率
    const now = Date.now()
    const lastSeen = new Date(signal.lastSeenAt).getTime()
    const ageHours = Math.max(1, (now - lastSeen) / 3_600_000)
    const velocity = Math.min(1, (signal.occurrenceCount / ageHours) * 2)

    const tension = (contradiction + uncertainty + impact + velocity) / 4
    return parseFloat(tension.toFixed(4))
  }

  private async rateContradiction(keyword: string): Promise<number> {
    const prompt = `主题：「${keyword}」

这个主题内部是否存在固有矛盾、竞争性观点或利益冲突？
0 = 完全一致没有冲突, 1 = 高度矛盾

只输出一个 0-1 之间的数字。`
    const result = await this.llm.generateJson<number>(prompt, { temperature: 0.3, maxTokens: 128 })
    return typeof result.data === 'number' ? parseFloat(Math.min(1, Math.max(0, result.data)).toFixed(2)) : 0.5
  }

  private calcDiversity(keyword: string, recentTopics: string[]): number {
    if (recentTopics.length === 0) return 1.0
    const kwWords = new Set(keyword.split(/[\s,，、/\\]+/).filter(Boolean))
    if (kwWords.size === 0) return 0.5
    let maxOverlap = 0
    for (const rt of recentTopics) {
      const rtWords = new Set(rt.split(/[\s,，、/\\]+/).filter(Boolean))
      let overlap = 0
      for (const w of kwWords) {
        if (rtWords.has(w)) overlap++
      }
      maxOverlap = Math.max(maxOverlap, overlap / kwWords.size)
    }
    return parseFloat((1 - maxOverlap).toFixed(2))
  }

  private calcMemoryGap(keyword: string, recentTopics: string[]): number {
    if (recentTopics.length === 0) return 1.0
    const found = recentTopics.some((rt) => rt.includes(keyword) || keyword.includes(rt))
    return found ? 0.2 : 0.9
  }

  private async suggestFromObservations(trends: TrendReport): Promise<{ topic: string }[]> {
    const prompt = `基于 ${trends.sourceSummary.totalItemsReceived} 条观察，请推荐 1-3 个值得研究的热门话题。只输出 JSON 数组：["topic1", "topic2"]`
    const result = await this.llm.generateJson<string[]>(prompt, { temperature: 0.5, maxTokens: 1024 })
    if (result.error || !result.data) return []
    return result.data.slice(0, 3).map((t) => ({ topic: t }))
  }
}
