import { eventBus } from '@akemi-mio/core/core/EventBus'
import { log } from '@akemi-mio/core/logger/Logger'
import type { CreativitySource, FermentLogEntry, Hypothesis, HypothesisFermentationPatch, IdeaStoreLike } from './types'

export interface FermentResult {
  promoted: string[]
  rejected: string[]
  merged: number
  kept: number
  skipped: boolean
}

const FERMENT_SYSTEM_PROMPT = `你是一个点子发酵师。
你负责评估"还在发酵中"的创意点子（draft 状态）：
- 结合最近的新信号判断点子是否成熟到可以落地；
- 可以强化点子、合并互补点子、或淘汰失去价值的点子。
只输出 JSON，不要输出其他内容。`

function clampScore(value: any, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(10, Math.min(100, Math.round(n)))
}

/**
 * IdeaFermentationEngine — 创意点子发酵引擎
 *
 * 读取 draft 状态的 hypothesis，结合来源总线的新信号，
 * 由 LLM 逐条评估并给出 promote / keep / reject / merge 判定。
 */
export class IdeaFermentationEngine {
  private store: IdeaStoreLike
  private chatJson: (
    userText: string,
    options?: { system?: string; temperature?: number; timeoutMs?: number; requestId?: string },
  ) => Promise<{ data?: any; error?: string }>
  private getSignals: () => CreativitySource[]
  private minFermentRounds = 1
  private minAgeMs = 15 * 60 * 1000
  private maxPromotePerRound = 10
  private maxFermentRounds = 3
  private batchSize = 8
  private llmTimeoutMs = 180000

  constructor(
    store: IdeaStoreLike,
    chatJson: (
      userText: string,
      options?: { system?: string; temperature?: number; timeoutMs?: number; requestId?: string },
    ) => Promise<{ data?: any; error?: string }>,
    getSignals: () => CreativitySource[],
  ) {
    this.store = store
    this.chatJson = chatJson
    this.getSignals = getSignals
  }

  async ferment(): Promise<FermentResult> {
    const candidates = this.store.getFermentableHypotheses(this.batchSize)
    if (candidates.length === 0) {
      log('INFO', 'idea_ferment_empty')
      return { promoted: [], rejected: [], merged: 0, kept: 0, skipped: false }
    }

    const signals = this.getSignals()
    const prompt = this.buildPrompt(candidates, signals)

    log('INFO', 'idea_ferment_start', { candidates: candidates.length, signals: signals.length })

    const result = await this.chatJson(prompt, {
      system: FERMENT_SYSTEM_PROMPT,
      temperature: 0.5,
      timeoutMs: this.llmTimeoutMs,
    })

    if (result.error) {
      log('WARN', 'idea_ferment_failed', { error: result.error })
      return { promoted: [], rejected: [], merged: 0, kept: 0, skipped: true }
    }

    const results = Array.isArray(result.data?.results) ? result.data.results : []
    return this.applyVerdicts(candidates, results)
  }

  private buildPrompt(candidates: Hypothesis[], signals: CreativitySource[]): string {
    const candidateText = candidates
      .map(
        (h, i) =>
          `${i + 1}. [${h.id}] ${h.title}\n` +
          `   内容: ${h.idea}\n` +
          `   新颖度 ${h.novelty} / 可行性 ${h.feasibility} / 影响 ${h.impact}\n` +
          `   已发酵轮数: ${h.fermentCount ?? 0}\n` +
          `   风险: ${h.risk}`,
      )
      .join('\n')

    const signalText =
      signals.length > 0
        ? signals.map((s) => `- [${s.type}] ${s.name}: ${s.content}`).join('\n')
        : '（无）'

    return `以下是需要发酵的 ${candidates.length} 个创意点子（draft 状态）：

${candidateText}

近期新信号（可能对点子有影响）：
${signalText}

请逐条评估每个点子，输出 JSON：
{
  "results": [
    {
      "id": "点子id",
      "verdict": "promote | keep | reject | merge",
      "reason": "一句话理由",
      "novelty": 0-100,
      "feasibility": 0-100,
      "impact": 0-100,
      "enrichedIdea": "可选，强化后的点子描述",
      "mergeWithId": "可选，verdict=merge 时合并的目标点子id",
      "mergedIdea": { "title": "", "idea": "", "expectedBenefit": "", "risk": "", "sourceLabels": [], "novelty": 0, "feasibility": 0, "impact": 0 }
    }
  ]
}

评判标准：
- promote：仅当点子足够成熟且当前信号支持落地；
- merge：仅当两个点子互补可合并（mergedIdea 给出合并后的完整点子）；
- reject：点子已失去价值或明确不可行；
- keep：其余情况，留在发酵池继续观察。`
  }

  private applyVerdicts(
    candidates: Hypothesis[],
    results: Array<Record<string, any>>,
  ): FermentResult {
    const byId = new Map(candidates.map((c) => [c.id, c]))
    const now = Date.now()
    let promotedCount = 0
    const promoted: string[] = []
    const rejected: string[] = []
    let merged = 0
    let kept = 0
    const mergeResults: Array<Record<string, any>> = []

    for (const r of results) {
      const h = byId.get(r?.id)
      if (!h) continue
      const rounds = (h.fermentCount ?? 0) + 1
      const entry: FermentLogEntry = { at: now, verdict: r.verdict ?? 'keep', reason: r.reason ?? '' }

      if (r.verdict === 'promote') {
        const ageOk = now - h.createdAt >= this.minAgeMs
                // 后置去重: active 池中已有相似假设则跳过 promote
                const activeHyps = candidates.filter(c => c.status === 'active' || c.status === 'experimenting')
                if (rounds >= this.minFermentRounds && ageOk && promotedCount < this.maxPromotePerRound && !this.isDuplicate(h, activeHyps)) {
          this.store.updateHypothesisFermentation(h.id, {
            status: 'active',
            fermentCount: rounds,
            lastFermentedAt: now,
            fermentLog: [...(h.fermentLog ?? []), entry],
            novelty: clampScore(r.novelty, h.novelty),
            feasibility: clampScore(r.feasibility, h.feasibility),
            impact: clampScore(r.impact, h.impact),
          })
          promoted.push(h.id)
                    promotedCount++
                    eventBus.emit('creativity.hypothesis.promoted', { hypothesisId: h.id, timestamp: Date.now() })
                    continue
        }
        this.applyKeep(h, r, rounds, now)
        kept++
        continue
      }

      if (r.verdict === 'reject') {
        this.store.updateHypothesisFermentation(h.id, {
          status: 'rejected',
          fermentCount: rounds,
          lastFermentedAt: now,
          fermentLog: [...(h.fermentLog ?? []), entry],
        })
        rejected.push(h.id)
        continue
      }

      if (r.verdict === 'merge') {
        mergeResults.push(r)
        continue
      }

      this.applyKeep(h, r, rounds, now)
      kept++
    }

    // 第二轮处理 merge
    const processed = new Set<string>()
    let mergeIndex = 0
    for (const r of mergeResults) {
      const h = byId.get(r.id)
      if (!h || processed.has(h.id)) continue
      const mergedIdea = r.mergedIdea
      if (!mergedIdea || typeof mergedIdea.title !== 'string' || typeof mergedIdea.idea !== 'string') {
        this.applyKeep(h, r, (h.fermentCount ?? 0) + 1, now)
        kept++
        continue
      }

      const newId = `hyp_merge_${now}_${++mergeIndex}`
      const newHyp: Hypothesis = {
        id: newId,
        title: mergedIdea.title,
        idea: mergedIdea.idea,
        expectedBenefit: String(mergedIdea.expectedBenefit ?? ''),
        risk: String(mergedIdea.risk ?? ''),
        sourceLabels: Array.isArray(mergedIdea.sourceLabels) ? mergedIdea.sourceLabels : h.sourceLabels,
        novelty: clampScore(mergedIdea.novelty, h.novelty),
        feasibility: clampScore(mergedIdea.feasibility, h.feasibility),
        impact: clampScore(mergedIdea.impact, h.impact),
        status: 'draft',
        createdAt: now,
      }
      this.store.addHypothesis(newHyp)

      const entry: FermentLogEntry = { at: now, verdict: 'merge', reason: r.reason ?? '合并' }
      this.store.updateHypothesisFermentation(h.id, {
        status: 'rejected',
        fermentCount: (h.fermentCount ?? 0) + 1,
        lastFermentedAt: now,
        fermentLog: [...(h.fermentLog ?? []), entry],
        mergedInto: newId,
      })
      processed.add(h.id)

      const partner = typeof r.mergeWithId === 'string' ? byId.get(r.mergeWithId) : undefined
      if (partner && !processed.has(partner.id) && partner.id !== h.id) {
        this.store.updateHypothesisFermentation(partner.id, {
          status: 'rejected',
          fermentCount: (partner.fermentCount ?? 0) + 1,
          lastFermentedAt: now,
          fermentLog: [...(partner.fermentLog ?? []), { at: now, verdict: 'merge', reason: r.reason ?? '合并' }],
          mergedInto: newId,
        })
        processed.add(partner.id)
      }
      merged++
    }

    log('INFO', 'idea_ferment_done', {
      promoted: promoted.length,
      rejected: rejected.length,
      merged,
      kept,
    })

    return { promoted, rejected, merged, kept, skipped: false }
  }

  private applyKeep(h: Hypothesis, r: Record<string, any>, rounds: number, now: number): void {
    const entry: FermentLogEntry = {
      at: now,
      verdict: 'keep',
      reason: r.reason ?? '',
      score: { novelty: h.novelty, feasibility: h.feasibility, impact: h.impact },
    }
    const patch: HypothesisFermentationPatch = {
      fermentCount: rounds,
      lastFermentedAt: now,
      fermentLog: [...(h.fermentLog ?? []), entry],
      novelty: r.novelty != null ? Math.round(h.novelty * 0.4 + clampScore(r.novelty, h.novelty) * 0.6) : h.novelty,
      feasibility: r.feasibility != null ? Math.round(h.feasibility * 0.4 + clampScore(r.feasibility, h.feasibility) * 0.6) : h.feasibility,
      impact: r.impact != null ? Math.round(h.impact * 0.4 + clampScore(r.impact, h.impact) * 0.6) : h.impact,
    }
    if (typeof r.enrichedIdea === 'string' && r.enrichedIdea.trim().length > 0) {
      patch.idea = r.enrichedIdea
    }
    if (rounds >= this.maxFermentRounds) {
      patch.status = 'rejected'
    }
    this.store.updateHypothesisFermentation(h.id, patch)
  }

  /**
   * 去重检查：如果已有 active 假设与当前假设标题高度相似（Jaccard > 0.5），视为重复
   * 避免 promote 后出现 duplicate idea 占满管道
   */
  private isDuplicate(h: Hypothesis, activeHyps: Hypothesis[]): boolean {
    const tokensA = this.tokenize(h.title + ' ' + h.idea)
    for (const existing of activeHyps) {
      if (existing.id === h.id) continue
      const tokensB = this.tokenize(existing.title + ' ' + existing.idea)
      let intersection = 0
      for (const t of tokensA) if (tokensB.has(t)) intersection++
      const union = tokensA.size + tokensB.size - intersection
      if (union > 0 && intersection / union > 0.5) {
        log('INFO', 'idea_ferment_dedup', { id: h.id, duplicateOf: existing.id, similarity: (intersection / union).toFixed(2) })
        return true
      }
    }
    return false
  }

  private tokenize(text: string): Set<string> {
    return new Set((text || '').toLowerCase().split(/[\s,，。.、：:;；()（）[\]【】]+/).filter(t => t.length > 1))
  }

}

