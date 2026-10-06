import { log } from './logger'
import type { ObserverLlmService } from './ObserverLlmService'
import type { ObserverStore } from './ObserverStore'
import type { AssociationCluster, AssociationResult } from './types'

// 单次发酵的输出上限：没有上限时模型可以一次给几十个 cluster、
// 每个挂几十个关联词，周文件与下一轮的"近期主题"都会被撑爆。
const MAX_CLUSTERS = 12
const MAX_ASSOCIATIONS = 8
const MAX_PREVIOUS_THEMES = 20

// strength 归一：模型偶尔按 0-100 输出（85 而不是 0.85）。不归一的话
// WritingGate 的 0.7 线形同虚设——任何百分数都能直接触发成文。
// 非有限值返回 null，该 cluster 被丢弃而不是带着 NaN 进入排序。
function normalizeStrength(value: unknown): number | null {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const scaled = n > 1 ? n / 100 : n
  return Math.min(1, Math.max(0, scaled))
}

function sanitizeClusters(raw: unknown): AssociationCluster[] {
  if (!Array.isArray(raw)) return []
  const out: AssociationCluster[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const c = item as Record<string, unknown>
    const theme = String(c.theme ?? '').trim().slice(0, 40)
    if (!theme) continue
    const strength = normalizeStrength(c.strength)
    if (strength === null || strength < 0.3) continue
    const assocRaw = Array.isArray(c.associations) ? c.associations : []
    const associations = [
      ...new Set(assocRaw.map((a) => String(a).trim()).filter(Boolean)),
    ].slice(0, MAX_ASSOCIATIONS)
    out.push({ theme, associations, observations: [], strength })
  }
  return out.sort((a, b) => b.strength - a.strength).slice(0, MAX_CLUSTERS)
}

/**
 * FermentationEngine — 发酵引擎
 *
 * 读取近期 observations，调用 Observer-Mio 做关联，
 * 输出 association clusters。
 * strength > 0.7 的 cluster 触发写作。
 */
export class FermentationEngine {
  private llm: ObserverLlmService
  private store: ObserverStore
  private writingThreshold = 0.7

  constructor(llm: ObserverLlmService, store: ObserverStore) {
    this.llm = llm
    this.store = store
  }

  /**
   * 执行一次发酵
   * @param sessionLabel 时段标签: 'morning' | 'afternoon' | 'night'
   */
  async ferment(sessionLabel: string): Promise<AssociationResult> {
    log('INFO', 'fermentation_start', { session: sessionLabel })

    const observations = this.store.readRecent(3)
    if (observations.length === 0) {
      log('INFO', 'fermentation_empty')
      return { generatedAt: new Date().toISOString(), clusters: [] }
    }

    const obsText = observations
      .slice(0, 60)
      .map((o) => `[${o.source}] ${o.content}`)
      .join('\n')

    const previous = this.store.readRecentAssociations(3)
    const prevText =
      previous.length > 0
        ? '\n\n近期关联主题：\n' +
          previous
            .flatMap((r) => r.clusters)
            .slice(-MAX_PREVIOUS_THEMES)
            .map((c) => `- ${c.theme} (${(c.associations ?? []).join(', ')})`)
            .join('\n')
        : ''

    const prompt = `你是一个观察者，下面是近期收集到的生活碎片。请从这些碎片中找出 recurring themes——那些反复出现、相互呼应的片段。

关联必须能指回碎片本身：允许模糊的解读、允许矛盾，但不得编造碎片里没有出现过的内容；宁可少而真，不要多而空。

${obsText}${prevText}

按以下 JSON 格式输出关联结果，不要包含其他内容：
{
  "clusters": [
    {
      "theme": "简短的主题名（≤15字）",
      "associations": ["关联词1", "关联词2"],
      "strength": 0.8
    }
  ]
}

每个 cluster 的 strength 是 0-1 之间的小数（不要用百分数），越强的关联越可能发展成文字。strength 低于 0.3 的不要输出。最多输出 ${MAX_CLUSTERS} 个 cluster，每个 cluster 不超过 ${MAX_ASSOCIATIONS} 个关联词；不要为了凑数重复近期关联主题里已有的条目。`

    const result = await this.llm.generateJson<AssociationResult>(prompt, {
      temperature: 0.6,
      maxTokens: 2048,
    })

    if (result.error) {
      log('WARN', 'fermentation_failed', { error: result.error })
      return { generatedAt: new Date().toISOString(), clusters: [] }
    }

    const clusters = sanitizeClusters(result.data?.clusters)

    const output: AssociationResult = {
      generatedAt: new Date().toISOString(),
      clusters,
    }

    this.store.saveAssociation(output)

    log('INFO', 'fermentation_done', {
      session: sessionLabel,
      clusters: clusters.length,
      strong: clusters.filter((c) => c.strength >= this.writingThreshold).length,
    })

    return output
  }

  getWritingThreshold(): number {
    return this.writingThreshold
  }

  setWritingThreshold(t: number): void {
    this.writingThreshold = Math.max(0, Math.min(1, t))
  }
}
