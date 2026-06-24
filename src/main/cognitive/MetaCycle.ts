import { log } from '../logger/Logger'
import { getRawDb } from '../db/connection'
import { eventBus } from '../core/EventBus'
import type { IdentityModule } from '../identity'
import type { EngineeringMemory } from '../memory/EngineeringMemory'
import type { ProceduralMemory } from '../agent/ProceduralMemory'
import type { LlmService } from '../llm/LlmService'

export interface MetaReview {
  id: string
  periodStart: number
  periodEnd: number
  summary: string
  patterns: string[]
  improvements: string[]
  traitDeltas: Record<string, number>
  createdAt: number
}

const REVIEW_PROMPT = `你正在进行一次周期性自我评估。分析以下数据并输出 JSON 格式的评估报告。

当前特征值：
{traitSummary}

周期内统计：
{sessionStats}

最近的失败模式：
{failurePatterns}

常用流程：
{procedures}

{lastReview}

输出 JSON，不要多余文字：
{
  "summary": "一句话总结本周表现",
  "patterns": ["观察到的模式，最多3条"],
  "improvements": ["改进建议，最多3条"],
  "traitAdjustments": { "goal_alignment": 0.75, "tool_efficiency": 0.68 },
  "confidence": 0.0-1.0
}

traitAdjustments 中的值应为 0-1 之间的浮点数，用于更新特征值。如果没有需要调整的，设为空对象 {}。`

export class MetaCycle {
  private identity: IdentityModule | null = null
  private engineeringMemory: EngineeringMemory | null = null
  private proceduralMemory: ProceduralMemory | null = null
  private llmService: LlmService | null = null
  private lastReview: MetaReview | null = null
  private periodStart = 0

  initialize(deps: {
    identity: IdentityModule
    engineeringMemory: EngineeringMemory
    proceduralMemory: ProceduralMemory
    llmService: LlmService
  }): void {
    this.identity = deps.identity
    this.engineeringMemory = deps.engineeringMemory
    this.proceduralMemory = deps.proceduralMemory
    this.llmService = deps.llmService
    this.lastReview = this.loadLatestReview()
    this.periodStart = this.lastReview?.periodEnd || Date.now() - 7 * 24 * 60 * 60 * 1000
    log('INFO', 'meta_cycle_initialized', { hasLastReview: !!this.lastReview })
  }

  /** 收集快照数据 */
  collectSnapshot(): {
    traits: string
    metrics: string
    failurePatterns: string
    procedures: string
  } {
    const snapshot = this.identity?.getSnapshot()
    const traitStr = snapshot?.traits
      ? snapshot.traits.map((t) => `${t.name}=${t.value}(${t.trend},${t.sampleCount}samples)`).join(', ')
      : '无特征数据'

    const metrics = snapshot?.metrics
    const metricsStr = metrics
      ? `${metrics.sessionsCompleted} sessions, ${metrics.toolsUsed} tools, ${metrics.goalsCompleted} goals, ${metrics.goalsDrifted} drifted, avg_score=${metrics.avgScore.toFixed(2)}`
      : '无统计数据'

    const patterns = this.engineeringMemory?.query({ types: ['failure_pattern'], topK: 5 }) || []
    const patternsStr = patterns.length ? patterns.map((p) => `- ${p.content.slice(0, 120)}`).join('\n') : '无失败模式'

    const procedures = this.proceduralMemory?.listAll() || []
    const procStr = procedures.length
      ? procedures
          .slice(0, 5)
          .map((p) => `- ${p.name}: ${p.description.slice(0, 60)} (${p.successCount}/${p.failCount})`)
          .join('\n')
      : '无保存流程'

    return {
      traits: traitStr,
      metrics: metricsStr,
      failurePatterns: patternsStr,
      procedures: procStr,
    }
  }

  /** 调用 LLM 生成评估报告 */
  async generateReview(context: { traits: string; metrics: string; failurePatterns: string; procedures: string }): Promise<{
    summary: string
    patterns: string[]
    improvements: string[]
    traitAdjustments: Record<string, number>
    confidence: number
  } | null> {
    if (!this.llmService) {
      log('WARN', 'meta_llm_unavailable')
      return null
    }

    const lastReviewStr = this.lastReview ? `上次评估建议：\n${this.lastReview.improvements.map((i) => `- ${i}`).join('\n')}` : ''

    const prompt = REVIEW_PROMPT.replace('{traitSummary}', context.traits)
      .replace('{sessionStats}', context.metrics)
      .replace('{failurePatterns}', context.failurePatterns)
      .replace('{procedures}', context.procedures)
      .replace('{lastReview}', lastReviewStr)

    const result = await this.llmService.chatJson(prompt, {
      system: '你是一个自我评估引擎。输出 JSON only，严格遵循要求的格式。',
      temperature: 0.3,
      timeoutMs: 90000,
      requestId: `meta_review_${Date.now()}`,
    })

    if (result.error || !result.data) {
      log('WARN', 'meta_review_llm_failed', { error: result.error })
      return null
    }

    const data = typeof result.data === 'string' ? JSON.parse(result.data) : result.data
    if (!data.summary || data.confidence === undefined) {
      log('WARN', 'meta_review_invalid_response', { data })
      return null
    }

    return {
      summary: data.summary,
      patterns: Array.isArray(data.patterns) ? data.patterns : [],
      improvements: Array.isArray(data.improvements) ? data.improvements : [],
      traitAdjustments: data.traitAdjustments || {},
      confidence: data.confidence,
    }
  }

  /** 应用评估结果 */
  applyReview(review: {
    summary: string
    patterns: string[]
    improvements: string[]
    traitAdjustments: Record<string, number>
    confidence: number
  }): void {
    const now = Date.now()

    // 更新身份特征
    if (this.identity) {
      for (const [traitName, score] of Object.entries(review.traitAdjustments)) {
        const reasonMap: Record<string, 'session_positive' | 'session_negative'> = {
          goal_alignment: 'goal_drift_positive',
          tool_efficiency: 'tool_success',
          response_quality: 'session_positive',
        }
        const reason = reasonMap[traitName] || 'session_positive'
        this.identity.updateTraits({ score, reason, context: 'meta_review' })
      }
    }

    // 存储到 DB
    const db = getRawDb()
    const id = `meta_${now}`
    db.run(
      `INSERT INTO meta_reviews (id, period_start, period_end, summary, patterns, improvements, trait_deltas, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        this.periodStart,
        now,
        review.summary,
        JSON.stringify(review.patterns),
        JSON.stringify(review.improvements),
        JSON.stringify(review.traitAdjustments),
        now,
      ],
    )

    // 存入工程记忆
    this.engineeringMemory?.store({
      type: 'architecture_pattern',
      content: `【自评】${review.summary}\n改进：${review.improvements.join('; ')}`,
      source: 'meta_cycle',
      confidence: review.confidence,
      relatedFiles: [],
      tags: review.patterns.map((p) => p.slice(0, 20)),
    })

    // 更新状态
    this.lastReview = {
      id,
      periodStart: this.periodStart,
      periodEnd: now,
      summary: review.summary,
      patterns: review.patterns,
      improvements: review.improvements,
      traitDeltas: review.traitAdjustments,
      createdAt: now,
    }
    this.periodStart = now

    eventBus.emit('meta.review.completed', {
      summary: review.summary,
      traitAdjustments: review.traitAdjustments,
    })

    log('INFO', 'meta_review_applied', {
      summary: review.summary.slice(0, 40),
      adjustments: Object.keys(review.traitAdjustments).length,
    })
  }

  /** 完整运行一次评估循环 */
  async run(): Promise<void> {
    try {
      log('INFO', 'meta_cycle_started', { periodStart: new Date(this.periodStart).toISOString() })
      const context = this.collectSnapshot()
      const review = await this.generateReview(context)
      if (!review) {
        log('WARN', 'meta_cycle_skipped', { reason: 'generateReview returned null' })
        return
      }
      this.applyReview(review)
      log('INFO', 'meta_cycle_completed', { summary: review.summary.slice(0, 60) })
    } catch (err: any) {
      log('ERROR', 'meta_cycle_failed', { error: String(err) })
    }
  }

  /** 格式化上下文注入 */
  getFormattedContext(): string {
    if (!this.lastReview) return ''

    const adjustStr = Object.entries(this.lastReview.traitDeltas)
      .map(([name, val]) => {
        const trait = this.identity?.getSnapshot().traits.find((t) => t.name === name)
        const trend = trait?.trend || 'stable'
        const arrow = trend === 'growing' ? '↑' : trend === 'declining' ? '↓' : '→'
        return `${name}: ${arrow}${val.toFixed(2)} ${trend}`
      })
      .join('\n')

    const improveStr = this.lastReview.improvements.map((i, idx) => `${idx + 1}. ${i}`).join('\n')

    return [
      '---',
      '【自评总结】',
      adjustStr,
      '',
      `最近回顾: ${this.lastReview.summary}`,
      improveStr ? `改进建议:\n${improveStr}` : '',
      '---',
    ]
      .filter(Boolean)
      .join('\n')
  }

  private loadLatestReview(): MetaReview | null {
    try {
      const db = getRawDb()
      const rows = db.exec('SELECT * FROM meta_reviews ORDER BY created_at DESC LIMIT 1')[0]
      if (!rows || !rows.values.length) return null
      const v = rows.values[0]
      const obj: any = {}
      for (let i = 0; i < rows.columns.length; i++) obj[rows.columns[i]] = v[i]
      return {
        id: obj.id,
        periodStart: obj.period_start,
        periodEnd: obj.period_end,
        summary: obj.summary,
        patterns: JSON.parse(obj.patterns || '[]'),
        improvements: JSON.parse(obj.improvements || '[]'),
        traitDeltas: JSON.parse(obj.trait_deltas || '{}'),
        createdAt: obj.created_at,
      }
    } catch {
      return null
    }
  }
}
