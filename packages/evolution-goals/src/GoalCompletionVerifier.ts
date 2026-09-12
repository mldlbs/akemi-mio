import type { ExecutionGoal } from './types'

export interface GoalCompletionVerifierLlm {
  chatText(
    userText: string,
    options?: {
      system?: string
      temperature?: number
      timeoutMs?: number
      requestId?: string
    },
  ): Promise<{ reply?: string; error?: string }>
}

export interface GoalVerificationResult {
  verdict: 'confirmed' | 'contested'
  reason: string
}

/** 构造完成复核 prompt：仅基于 objective + successCriteria + evidence 判断。 */
export function buildGoalVerificationPrompt(goal: ExecutionGoal): string {
  const evidenceLines = goal.evidence.map((e) => `- [${e.type}] ${e.value}${e.detail ? `：${e.detail}` : ''}`).join('\n')
  return [
    '请复核以下执行目标是否真的完成。',
    '',
    `目标：${goal.objective}`,
    `成功标准：${goal.successCriteria.join('、') || '（未设置）'}`,
    '',
    '已收集证据：',
    evidenceLines || '（无）',
    '',
    '请只返回 JSON：',
    '{"verdict":"confirmed"|"contested","reason":"简短理由"}',
  ].join('\n')
}

/** 从 LLM 回复中解析 verdict；解析失败返回 null。 */
export function parseGoalVerificationReply(reply?: string): GoalVerificationResult | null {
  if (!reply?.trim()) return null
  let value: unknown
  try {
    value = JSON.parse(
      reply
        .replace(/^```json\s*/i, '')
        .replace(/```$/i, '')
        .trim(),
    )
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  const verdict = obj.verdict
  const reason = obj.reason
  if ((verdict !== 'confirmed' && verdict !== 'contested') || typeof reason !== 'string') return null
  return { verdict, reason: reason.trim().slice(0, 200) }
}

/** 调用 LLM 复核目标完成状态；LLM 不可用或解析失败时返回 null（调用方降级）。 */
export async function verifyGoalCompletion(
  goal: ExecutionGoal,
  llm: GoalCompletionVerifierLlm,
  requestId?: string,
): Promise<GoalVerificationResult | null> {
  const result = await llm.chatText(buildGoalVerificationPrompt(goal), {
    system: '你是目标完成复核器，只基于证据判断，返回 JSON。',
    temperature: 0.1,
    timeoutMs: 30000,
    requestId,
  })
  if (result.error || !result.reply) return null
  return parseGoalVerificationReply(result.reply)
}
