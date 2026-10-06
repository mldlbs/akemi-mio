import { log } from './logger'
import type { ObserverLlmService } from './ObserverLlmService'

/**
 * QualityGate — 发布前质量评审
 *
 * Observer 主链曾有两条「写完即 published」的路径（WritingGate 自由写作、
 * InsightComposer 五段成稿）：没有任何质量动作，除了禁用词表和 length>20。
 * QualityGate 在 saveEssay 前做两层评审：
 *
 *   1. offline —— 纯代码检查，零成本、确定性：
 *      空文 / 过短 / AI 腔词密集。空文与过短直接判负，不再浪费一次 LLM 调用。
 *   2. review —— LLM 严编评审（逻辑连贯、事实与推测是否分层、信息量、AI 腔），
 *      输出 0-100 分；>= QUALITY_PASS_SCORE 才允许 published，否则降级 draft。
 *
 * 评审不可用（LLM 故障）时保守降级为 draft：内容不丢，但绝不虚标「已发布」。
 */

export interface QualityReview {
  pass: boolean
  /** 0-100; -1 means the LLM review could not run (only offline checks applied). */
  score: number
  issues: string[]
  /** false when only the offline layer ran. */
  reviewed: boolean
}

export const QUALITY_PASS_SCORE = 70
export const MIN_ESSAY_CHARS = 120
const CLICHE_LIMIT = 5

// Same ban list InsightComposer feeds to the section prompts — the gate is
// where it stops being a request and becomes a check.
export const BANNED_CLICHES = [
  '然而', '不仅', '而且', '因此', '总之', '显而易见',
  '不可忽视', '值得关注', '引人深思', '从某种意义上说', '由此可见', '综上所述',
]

export class QualityGate {
  private llm: ObserverLlmService

  constructor(llm: ObserverLlmService) {
    this.llm = llm
  }

  offlineIssues(content: string): string[] {
    const trimmed = (content || '').trim()
    if (!trimmed) return ['empty content']
    const issues: string[] = []
    if (trimmed.length < MIN_ESSAY_CHARS) {
      issues.push(`too short (${trimmed.length} < ${MIN_ESSAY_CHARS} chars)`)
    }
    let hits = 0
    for (const word of BANNED_CLICHES) hits += trimmed.split(word).length - 1
    if (hits >= CLICHE_LIMIT) issues.push(`AI-cliche density (${hits} hits)`)
    return issues
  }

  async review(content: string): Promise<QualityReview> {
    const offline = this.offlineIssues(content)
    if (offline.includes('empty content')) {
      log('WARN', 'quality_gate_reject_offline', { issues: offline })
      return { pass: false, score: 0, issues: offline, reviewed: false }
    }

    const trimmed = content.trim()
    // An obviously unfit draft (e.g. a truncated 30-char stub) fails without
    // spending a call; anything else gets the real editorial review.
    const fatal = offline.some((i) => i.startsWith('too short'))
    if (fatal) {
      log('WARN', 'quality_gate_reject_offline', { issues: offline })
      return { pass: false, score: 0, issues: offline, reviewed: false }
    }

    const prompt = `请以严格编辑的标准评审以下中文随笔/文章片段，只输出 JSON：
{"score": 0-100, "issues": ["具体问题", ...]}

评分维度：
1. 逻辑连贯：段落之间是否有推进，因果链是否完整，有无跳步。
2. 事实分层：是否把推测/传言写成了事实；有无具体依据支撑论断。
3. 信息量：是否有具体的观察、案例或细节；空话套话不给分。
4. 表达：自然、克制、有个人视角；AI 腔、排比堆砌要扣分。

${offline.length > 0 ? `已知的机械检查问题（一并计入扣分）：${offline.join('；')}\n` : ''}
文章内容：
"""
${trimmed.slice(0, 6000)}
"""`

    const result = await this.llm.generateJson<{ score?: number; issues?: string[] }>(prompt, {
      system: '你是一名苛刻但公正的中文编辑。只输出 JSON，不要解释。',
      temperature: 0.2,
      maxTokens: 1024,
    })

    if (result.error || !result.data || typeof result.data !== 'object') {
      // Review unavailable: hold as draft rather than claim a pass.
      log('WARN', 'quality_gate_review_unavailable', { error: result.error })
      return {
        pass: false,
        score: -1,
        issues: [`review unavailable: ${result.error || 'no data'}`, ...offline],
        reviewed: false,
      }
    }

    const score = clampScore(result.data.score)
    const issues = Array.isArray(result.data.issues)
      ? result.data.issues.filter((i): i is string => typeof i === 'string')
      : []
    const pass = score >= QUALITY_PASS_SCORE
    if (!pass) {
      log('WARN', 'quality_gate_reject', { score, issues })
    }
    return { pass, score, issues: [...issues, ...offline], reviewed: true }
  }
}

function clampScore(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : NaN
  if (Number.isNaN(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}
