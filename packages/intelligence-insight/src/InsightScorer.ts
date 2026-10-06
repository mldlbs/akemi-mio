import type { RawDetection, Insight, DetectionContext } from '@akemi-mio/intelligence-insight/types'

export class InsightScorer {
  score(rawDetections: RawDetection[], ctx: DetectionContext): Insight[] {
    return rawDetections
      .map((r, i) => {
        const score = this.calculateScore(r)
        const confidence = this.calculateConfidence(r, ctx)
        return {
          id: `insight_${Date.now()}_${i}`,
          detector: r.detector,
          title: r.title,
          description: r.description,
          evidence: r.evidence,
          score,
          confidence,
          createdAt: Date.now(),
          ...(r.infoType ? { infoType: r.infoType } : {}),
        }
      })
      .sort((a, b) => b.score - a.score)
  }

  private calculateScore(raw: RawDetection): number {
    const dims = [raw.novelty, raw.impact, raw.actionability].map((v) => Number(v))
    // 模型偶尔按 0-1 的习惯输出而不是 0-100（schema 写了也拦不住）：
    // 三个维度都落在 [0,1] 时按 0-1 尺度归一到 0-100，否则
    // score < 20 会让 filterLowValue 把整批静默吞掉。之后统一 clamp。
    const scale = dims.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) ? 100 : 1
    const [n, i, a] = dims.map((v) => (Number.isFinite(v) ? Math.min(100, Math.max(0, v * scale)) : 0))
    const score = n * 0.4 + i * 0.4 + a * 0.2
    return Math.round(Math.min(100, Math.max(0, score)) * 100) / 100
  }

  private calculateConfidence(raw: RawDetection, ctx: DetectionContext): number {
    // evidence 可能是字符串或缺失（LLM 原样输出）：非数组时按单条处理，
    // 否则 .length 变成字符数会把 confidence 直接顶满。
    const evidence = Array.isArray(raw.evidence)
      ? raw.evidence.map((e) => String(e))
      : raw.evidence === null || raw.evidence === undefined
        ? []
        : [String(raw.evidence)]
    const evidenceCount = evidence.length
    const evidenceQuality = this.evidenceQuality(evidence)
    const dataFreshness = this.dataFreshness(ctx)

    const rawConfidence = evidenceCount * 0.25 * evidenceQuality * dataFreshness
    return Math.round(Math.min(Math.max(rawConfidence, 0), 1) * 100) / 100
  }

  private evidenceQuality(evidence: string[]): number {
    if (evidence.length === 0) return 0.3
    const avgLen = evidence.reduce((s, e) => s + e.length, 0) / evidence.length
    if (avgLen > 50) return 1.0
    if (avgLen > 20) return 0.8
    if (avgLen > 10) return 0.6
    return 0.4
  }

  private dataFreshness(ctx: DetectionContext): number {
    if (ctx.interactionCount === 0) {
      // CLI 路径没有交互流（硬编码 0），旧逻辑一律 0.2 会把 confidence
      // 永久压在高价值线 0.7 以下——`mio insight status` 的 highValue 因此
      // 恒为 0。改用最近记忆的新鲜度：没有记忆才回落 0.2。
      const recency = this.memoryRecency(ctx)
      return recency === null ? 0.2 : recency
    }
    if (ctx.memoryEntries.length === 0) return 0.3
    const freshness = Math.min(ctx.interactionCount / 100, 1)
    return 0.5 + 0.5 * freshness
  }

  private memoryRecency(ctx: DetectionContext): number | null {
    if (ctx.memoryEntries.length === 0) return null
    let newest = -Infinity
    for (const entry of ctx.memoryEntries) {
      const t = Number(entry.createdAt)
      if (Number.isFinite(t) && t > newest) newest = t
    }
    if (!Number.isFinite(newest)) return 0.4
    const ageMs = Date.now() - newest
    if (ageMs <= 24 * 60 * 60 * 1000) return 1.0
    if (ageMs <= 7 * 24 * 60 * 60 * 1000) return 0.7
    return 0.4
  }

  filterLowValue(insights: Insight[]): Insight[] {
    return insights.filter((i) => i.score >= 20)
  }
}
