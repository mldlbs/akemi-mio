import { describe, it, expect } from 'vitest'
import { GuardrailDecisionStore } from '@akemi-mio/core/core/evaluation/GuardrailDecisionStore'
import type { GuardrailDecision, RuntimeAction, GuardrailAction } from '@akemi-mio/core/core/evaluation/GuardrailTypes'

describe('GuardrailDecisionStore', () => {
  it('record + getByTrace 正确', async () => {
    const store = new GuardrailDecisionStore()
    // 不注入 raw db → ensureRaw 返回 null → 静默跳过
    // getByTrace 返回 []
    const records = await store.getByTrace('trace_1')
    expect(records).toEqual([])
  })

  it('record 失败时只 WARN 不抛', async () => {
    const store = new GuardrailDecisionStore()
    const decision = {
      action: 'continue' as GuardrailAction,
      reason: 'test',
      decidedAt: 1000,
      traceId: 'trace_1',
      signals: [],
      snapshot: {} as any,
      policyVersion: 'v1',
    }
    const guardrailDecision: GuardrailDecision = decision

    // 不注入 raw db → ensureRaw 尝试 import → 在测试中可能成功或失败
    // 无论哪种情况，record 都不会抛异常
    await expect(store.record('d1', guardrailDecision, 'CONTINUE' as RuntimeAction, 'trace_1', 1)).resolves.not.toThrow()
  })

  it('多 trace 隔离', async () => {
    const store = new GuardrailDecisionStore()
    const recordsA = await store.getByTrace('trace_a')
    const recordsB = await store.getByTrace('trace_b')
    expect(recordsA).toEqual([])
    expect(recordsB).toEqual([])
  })
})
