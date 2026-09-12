/**
 * social-publish 门禁策略 — 与 evolution workspace social/cli.mjs 的风控 / 模式规则对齐（设计 4.5）
 */

export type SocialMode = 'safe' | 'assisted' | 'autopilot'

/** 保留现有 risk() 关键词表（social/cli.mjs SENSITIVE） */
export const SENSITIVE_WORDS = ['政治', '宗教', '色情', '暴力', '赌博', '毒品', '敏感', '举报', '投诉', '违法', '欺诈'] as const

export interface RiskAssessment {
  requiresReview: boolean
  reasons: string[]
}

/**
 * 风险词过滤：每个命中词 +0.3；内容超长 +0.1；
 * score >= 0.6 或（safe 模式且 score >= 0.3）时 requires_review。
 */
export function assessRisk(text: string, mode: SocialMode): RiskAssessment {
  const reasons: string[] = []
  let score = 0
  for (const kw of SENSITIVE_WORDS) {
    if (text.includes(kw)) {
      reasons.push(kw)
      score += 0.3
    }
  }
  if (text.length > 2000) {
    reasons.push('过长')
    score += 0.1
  }
  const finalScore = Math.min(score, 1)
  return { requiresReview: finalScore >= 0.6 || (mode === 'safe' && finalScore >= 0.3), reasons }
}

export interface ModeAllowance {
  allowed: boolean
  action: string
}

/**
 * mode 策略（对齐 cli.mjs allow()，safe 不再放行自动发布）：
 * - safe：仅允许 draft / 人工确认，拒绝自动发布（含回复）；
 * - assisted：允许普通发布，拒绝自动回复类（reply_auto）；
 * - autopilot：允许普通发布与自动回复。
 */
export function modeAllowsPublish(mode: SocialMode, replyToId?: string): ModeAllowance {
  const action = replyToId ? 'reply_auto' : 'publish'
  if (mode === 'autopilot') return { allowed: true, action }
  if (mode === 'assisted') return { allowed: action === 'publish', action }
  return { allowed: false, action }
}

