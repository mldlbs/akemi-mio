import { log } from './logger'
import type { ObserverLlmService } from './ObserverLlmService'
import type { ObserverStore } from './ObserverStore'
import type { Observation, TrendSignal, TrendReport } from './types'

// ── 源权重校准 ──────────────────────────────────────────────
const SOURCE_WEIGHTS: Record<string, number> = {
  'weibo-hot': 0.3,
  rss: 0.7,
  system: 0.5,
  chat: 0.4,
}

const DEFAULT_SOURCE_WEIGHT = 0.4
const RECENCY_WINDOW_H = 48

/** 清理断开的关键词：去掉未闭合括号和尾部标点 */
function sanitizeKeyword(kw: string): string {
  let s = kw.trim().slice(0, 40)
  const pairs: Record<string, string> = { '(': ')', '（': '）', '[': ']', '【': '】', '"': '"', "'": "'" }
  for (const [open, close] of Object.entries(pairs)) {
    const lastOpen = s.lastIndexOf(open)
    if (lastOpen >= 0 && !s.slice(lastOpen).includes(close)) {
      s = s.slice(0, lastOpen).trim()
    }
  }
  s = s.replace(/[，,、。！？;；:：]{2,}$/g, '').trim()
  return s.length > 1 ? s : kw.trim()
}

/**
 * TrendEngine — 热点引擎
 *
 * 从近期 observations 中提取关键词、计算热度评分、
 * 通过 LLM 语义去重后输出 TrendReport。
 *
 * 评分公式（适配无 views/engagement 的数据源）：
 *   score = log(freq+1)×0.4 + diversity×0.3 + sourceWeight×0.2 + recency×0.1
 */
export class TrendEngine {
  private llm: ObserverLlmService
  private store: ObserverStore

  constructor(llm: ObserverLlmService, store: ObserverStore) {
    this.llm = llm
    this.store = store
  }

  /**
   * 执行趋势检测
   * @param days  回看天数，默认 3
   */
  async detectTrends(days = 3): Promise<TrendReport> {
    const now = new Date()
    const observations = this.store.readRecent(days)
    const generatedAt = now.toISOString()

    if (observations.length === 0) {
      log('INFO', 'trend_empty_observations', { days })
      return {
        generatedAt,
        signals: [],
        topN: 0,
        sourceSummary: { feedsContacted: 0, totalItemsReceived: 0, uniqueKeywords: 0 },
      }
    }

    // Step 1: LLM 关键词提取
    const keywordMap = await this.extractKeywords(observations)

    if (Object.keys(keywordMap).length === 0) {
      log('WARN', 'trend_keyword_extraction_empty', { obsCount: observations.length })
      return this.fallbackCounting(observations, generatedAt)
    }

    // Step 2: 语义去重
    const deduped = await this.deduplicate(keywordMap)

    if (deduped.length === 0) {
      return this.fallbackCounting(observations, generatedAt)
    }

    // Step 3: 评分
    const nowMs = now.getTime()
    const signals: TrendSignal[] = deduped.map(({ keyword, obsList }) => {
      const cleanKw = sanitizeKeyword(keyword)
      const occ = obsList.length
      const freq = Math.log(occ + 1) / Math.log(11)

      const sources = new Set(obsList.map((o) => o.source))
      const srcWeight = SOURCE_WEIGHTS[obsList[0].source] ?? DEFAULT_SOURCE_WEIGHT
      // 源多样性：除以已知源类型数
      const knownSources = ['weibo-hot', 'rss', 'bilibili-hot', 'douyin-hot', 'github-trending', 'system', 'chat']
      const diversity = sources.size / knownSources.length

      const timestamps = obsList.map((o) => new Date(o.timestamp).getTime()).filter((t) => !isNaN(t))
      const latestTs = timestamps.length > 0 ? Math.max(...timestamps) : nowMs
      const ageH = (nowMs - latestTs) / 3_600_000
      const recency = Math.max(0, 1 - ageH / RECENCY_WINDOW_H)

      const score = freq * 0.4 + diversity * 0.3 + srcWeight * 0.2 + recency * 0.1

      const allTs = obsList.map((o) => o.timestamp).sort()
      return {
        keyword: cleanKw,
        score: Math.min(1, parseFloat(score.toFixed(4))),
        sourceDiversity: parseFloat(diversity.toFixed(2)),
        source: obsList[0].source,
        firstSeenAt: allTs[0] ?? generatedAt,
        lastSeenAt: allTs[allTs.length - 1] ?? generatedAt,
        occurrenceCount: occ,
        recentObservationIds: obsList.slice(0, 10).map((o) => o.id),
      }
    })

    signals.sort((a, b) => b.score - a.score)
    const topN = signals.length

    const report: TrendReport = {
      generatedAt,
      signals: signals.slice(0, 20),
      topN,
      sourceSummary: {
        feedsContacted: new Set(observations.map((o) => o.source)).size,
        totalItemsReceived: observations.length,
        uniqueKeywords: signals.length,
      },
    }

    this.store.saveTrendReport(report)
    log('INFO', 'trend_detected', { signals: signals.length, topScore: signals[0]?.score ?? 0 })
    return report
  }

  // ── private ──────────────────────────────────────────────

  private async extractKeywords(observations: Observation[]): Promise<Record<string, Observation[]>> {
    const batch = observations.slice(0, 60)
    const obsText = batch.map((o) => `[${o.source}] ${o.content}`).join('\n')

    const prompt = `从以下观察中提取 5-15 个关键词/短语（中文）。
每个关键词对应 1-5 条原始观察。
如果一个观察同时匹配多个主题，允许重复计数。

观察：
${obsText}

只输出 JSON 数组，格式：
[{"keyword": "xxx", "matched_ids": ["id1","id2"]}]`

    const result = await this.llm.generateJson<{ keyword: string; matched_ids: string[] }[]>(prompt, {
      temperature: 0.2,
      maxTokens: 4096,
    })

    if (result.error || !result.data || !Array.isArray(result.data)) {
      log('WARN', 'trend_llm_keyword_failed', { error: result.error })
      return {}
    }

    const obsById = new Map(observations.map((o) => [o.id, o]))
    const keywordMap: Record<string, Observation[]> = {}

    for (const entry of result.data) {
      if (!entry.keyword || !Array.isArray(entry.matched_ids)) continue
      const obs = entry.matched_ids.map((id) => obsById.get(id)).filter((o): o is Observation => o !== undefined)
      if (obs.length === 0) continue
      const kw = entry.keyword.trim().slice(0, 50)
      if (kw.length < 2) continue
      keywordMap[kw] = obs
    }

    return keywordMap
  }

  private async deduplicate(keywordMap: Record<string, Observation[]>): Promise<{ keyword: string; obsList: Observation[] }[]> {
    const keywords = Object.keys(keywordMap)
    if (keywords.length <= 1) {
      return keywords.map((k) => ({ keyword: k, obsList: keywordMap[k] }))
    }

    const list = keywords.join('\n')
    const prompt = `以下关键词列表中，哪些语义相同或高度相似（如"AI"和"人工智能"）？
将相似的分到同一组，每组保留一个最能代表全部意思的关键词。

列表：
${list}

只输出 JSON 数组：
["key1", "key2", ...]`

    const result = await this.llm.generateJson<string[]>(prompt, { temperature: 0.1, maxTokens: 2048 })

    if (result.error || !result.data || !Array.isArray(result.data) || result.data.length === 0) {
      log('INFO', 'trend_dedup_skipped', { reason: 'LLM dedup failed, using raw' })
      return keywords.map((k) => ({ keyword: k, obsList: keywordMap[k] }))
    }

    const deduped: { keyword: string; obsList: Observation[] }[] = []
    const seenKeywords = new Set(keywords)

    for (const kept of result.data) {
      const trimmed = kept.trim()
      if (!trimmed || trimmed.length < 2) continue
      const match = keywords.find((k) => k.includes(trimmed) || trimmed.includes(k))
      if (match) {
        deduped.push({ keyword: trimmed, obsList: keywordMap[match] })
        seenKeywords.delete(match)
        seenKeywords.delete(trimmed)
      } else {
        deduped.push({ keyword: trimmed, obsList: [] })
      }
    }

    for (const remaining of seenKeywords) {
      deduped.push({ keyword: remaining, obsList: keywordMap[remaining] })
    }

    return deduped
  }

  private fallbackCounting(observations: Observation[], generatedAt: string): TrendReport {
    const freq: Record<string, { count: number; obs: Observation[] }> = {}
    for (const obs of observations) {
      const key = obs.content.slice(0, 8).trim()
      if (key.length < 2) continue
      if (!freq[key]) freq[key] = { count: 0, obs: [] }
      freq[key].count++
      freq[key].obs.push(obs)
    }

    const signals: TrendSignal[] = Object.entries(freq)
      .map(([keyword, { count, obs }]) => ({
        keyword,
        score: Math.min(1, parseFloat((Math.log(count + 1) / Math.log(11)).toFixed(4))),
        sourceDiversity: 0,
        source: obs[0]?.source ?? 'unknown',
        firstSeenAt: obs[0]?.timestamp ?? generatedAt,
        lastSeenAt: obs[obs.length - 1]?.timestamp ?? generatedAt,
        occurrenceCount: count,
        recentObservationIds: obs.slice(0, 10).map((o) => o.id),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)

    const report: TrendReport = {
      generatedAt,
      signals,
      topN: signals.length,
      sourceSummary: {
        feedsContacted: new Set(observations.map((o) => o.source)).size,
        totalItemsReceived: observations.length,
        uniqueKeywords: signals.length,
      },
    }

    this.store.saveTrendReport(report)
    log('INFO', 'trend_fallback_count', { signals: signals.length })
    return report
  }
}
