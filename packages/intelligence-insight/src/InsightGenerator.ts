import type { RawDetection, Insight, DetectionContext } from '@akemi-mio/intelligence-insight/types'
import { InsightScorer } from '@akemi-mio/intelligence-insight/InsightScorer'
import { INSIGHT_SYSTEM_PROMPT, buildInsightPrompt } from '@akemi-mio/intelligence-insight/InsightPrompt'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import { log } from '@akemi-mio/core/logger/Logger'

interface LlmDetector {
  name: string
  instance: any
}

// 一次生成最多入库的条数：模型偶发给 500 条时不能整包写进 insights.json。
const MAX_DETECTIONS = 10

// 逐条归一：一条坏记录（evidence 缺失是字符串/undefined、title 为空、
// severity 拼错）以前会把整批拖进 InsightScorer 的 catch 里 return []，
// 或让 evidence.length 变成字符数。坏条目直接跳过，好的照常入库。
function normalizeDetection(d: unknown): RawDetection | null {
  if (!d || typeof d !== 'object') return null
  const raw = d as Record<string, unknown>
  const title = String(raw.title ?? '').trim().slice(0, 20)
  if (!title) return null
  const rawEvidence = Array.isArray(raw.evidence)
    ? raw.evidence
    : raw.evidence === null || raw.evidence === undefined
      ? []
      : [raw.evidence]
  const evidence = rawEvidence
    .map((e) => String(e).trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, 20)
  const severity =
    raw.severity === 'low' || raw.severity === 'high' || raw.severity === 'medium'
      ? raw.severity
      : 'medium'
  return {
    title,
    description: String(raw.description ?? '').slice(0, 200),
    detector: raw.detector === 'conflict' ? 'conflict' : 'insight_llm',
    type: raw.detector === 'conflict' ? 'conflict' : 'hot_topic',
    evidence,
    novelty: Number(raw.novelty),
    impact: Number(raw.impact),
    actionability: Number(raw.actionability),
    severity,
    infoType: typeof raw.infoType === 'string' ? raw.infoType.slice(0, 10) : undefined,
  }
}

export interface InsightGeneratorDeps {
  chatJson: (
    userText: string,
    options?: {
      system?: string
      temperature?: number
      timeoutMs?: number
      requestId?: string
      maxTokens?: number
      /** 提示词要求顶层数组：llm-client 据此省略 response_format json_object（L1） */
      responseFormat?: 'object' | 'array'
    },
  ) => Promise<{ data?: any; error?: string }>
}

export class InsightGenerator {
  private scorer = new InsightScorer()
  private llm: InsightGeneratorDeps

  /** 保留原有 detector 引用，但已不再主动运行它们 */
  private detectors: LlmDetector[] = []

  constructor(llm: InsightGeneratorDeps) {
    this.llm = llm
  }

  async generate(ctx: DetectionContext): Promise<Insight[]> {
    const t0 = Date.now()
    log('INFO', 'insight_generation_start', {
      entries: ctx.memoryEntries.length,
      summaries: ctx.summaries.length,
      plans: ctx.plans.length,
    })
    eventBus.emit('insight.analysis.started', {})

    // 无数据时跳过
    if (ctx.memoryEntries.length === 0 && ctx.summaries.length === 0) {
      log('INFO', 'insight_generation_skip_no_data', { duration_ms: Date.now() - t0 })
      return []
    }

    try {
      // 构造 LLM prompt
      const userPrompt = buildInsightPrompt(ctx)

      // 调 LLM。maxTokens 必须给：llm-client 只在传了的时候才带
      // max_tokens，不传意味着输出无界，而超时只有 15s——越长越容易
      // 整批超时 return []。
      const result = await this.llm.chatJson(userPrompt, {
        system: INSIGHT_SYSTEM_PROMPT,
        temperature: 0.3,
        timeoutMs: 15000,
        maxTokens: 2000,
        responseFormat: 'array',
      })

      if (result.error) {
        log('WARN', 'insight_llm_error', { error: result.error, duration_ms: Date.now() - t0 })
        return []
      }

      const rawDetections: unknown[] = Array.isArray(result.data) ? result.data : []

      if (rawDetections.length === 0) {
        log('INFO', 'insight_generation_empty', { duration_ms: Date.now() - t0 })
        return []
      }

      eventBus.emit('insight.candidate.generated', { count: rawDetections.length })

      // 转换 LLM 输出为 RawDetection 格式，继续用 scorer。坏条目跳过，
      // 不允许一条坏记录毁掉整批。
      const detections: RawDetection[] = []
      for (const d of rawDetections) {
        const normalized = normalizeDetection(d)
        if (normalized) detections.push(normalized)
        if (detections.length >= MAX_DETECTIONS) break
      }

      if (detections.length === 0) {
        log('WARN', 'insight_generation_all_invalid', {
          raw: rawDetections.length,
          duration_ms: Date.now() - t0,
        })
        return []
      }

      const scored = this.scorer.score(detections, ctx)
      const filtered = this.scorer.filterLowValue(scored)

      log('INFO', 'insight_generation_done', {
        raw: rawDetections.length,
        dropped_invalid: rawDetections.length - detections.length,
        scored: scored.length,
        filtered: filtered.length,
        dropped_low_value: scored.length - filtered.length,
        duration_ms: Date.now() - t0,
      })

      return filtered
    } catch (err: any) {
      log('ERROR', 'insight_generation_error', { error: String(err), duration_ms: Date.now() - t0 })
      return []
    }
  }
}
