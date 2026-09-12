import { describe, it, expect, vi } from 'vitest'
import { buildGoalVerificationPrompt, parseGoalVerificationReply, verifyGoalCompletion } from '@akemi-mio/evolution/goals/GoalCompletionVerifier'
import type { ExecutionGoal } from '@akemi-mio/evolution/goals/types'

function goal(overrides: Partial<ExecutionGoal> = {}): ExecutionGoal {
  return {
    id: 'g1',
    sessionId: 's1',
    objective: '修复 bug',
    successCriteria: ['测试通过'],
    status: 'completed',
    planId: null,
    methodology: 'systematic_debugging',
    currentStep: 1,
    evidence: [{ type: 'test_result', value: 'passed', tool: 'run_command', step: 1, success: true, createdAt: 1 }],
    createdAt: 1,
    updatedAt: 2,
    completedAt: 3,
    ...overrides,
  }
}

describe('parseGoalVerificationReply', () => {
  it('parses confirmed verdict', () => {
    expect(parseGoalVerificationReply('{"verdict":"confirmed","reason":"tests passed"}')).toEqual({
      verdict: 'confirmed',
      reason: 'tests passed',
    })
  })

  it('parses fenced JSON', () => {
    expect(parseGoalVerificationReply('```json\n{"verdict":"contested","reason":"missing file"}\n```')?.verdict).toBe('contested')
  })

  it.each(['not json', '{"verdict":"maybe","reason":"x"}', '{"verdict":"confirmed"}'])('returns null for %s', (reply) => {
    expect(parseGoalVerificationReply(reply)).toBeNull()
  })
})

describe('verifyGoalCompletion', () => {
  it('calls llm and returns parsed result', async () => {
    const llm = {
      chatText: vi.fn().mockResolvedValue({ reply: '{"verdict":"confirmed","reason":"ok"}' }),
    }
    const result = await verifyGoalCompletion(goal(), llm, 'req-1')
    expect(result).toEqual({ verdict: 'confirmed', reason: 'ok' })
    expect(llm.chatText).toHaveBeenCalledWith(expect.stringContaining('修复 bug'), expect.any(Object))
  })

  it('returns null when llm errors', async () => {
    const llm = { chatText: vi.fn().mockResolvedValue({ error: 'API_ERROR' }) }
    await expect(verifyGoalCompletion(goal(), llm)).resolves.toBeNull()
  })
})

describe('buildGoalVerificationPrompt', () => {
  it('includes objective, criteria and evidence', () => {
    const prompt = buildGoalVerificationPrompt(goal())
    expect(prompt).toContain('修复 bug')
    expect(prompt).toContain('测试通过')
    expect(prompt).toContain('test_result')
  })
})
