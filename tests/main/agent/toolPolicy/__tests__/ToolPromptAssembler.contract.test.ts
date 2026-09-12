/**
 * ADR-008 Contract Tests — ToolPromptAssembler
 *
 * 验证 7 项 Invariant 中的：
 *   I-5: auto 不注入 — preference === 'auto' 时 assemble() 返回 null
 *   I-7: ToolDecision 不可变（assembler 不修改输入）
 */

import { describe, it, expect } from 'vitest'
import { ToolPromptAssembler } from '@akemi-mio/intelligence/agent/toolPolicy/ToolPromptAssembler'
import { ToolDecisionReason } from '@akemi-mio/intelligence/agent/toolPolicy/types'
import type { ToolDecision } from '@akemi-mio/intelligence/agent/toolPolicy/types'

describe('ToolPromptAssembler — Contract (ADR-008 Invariants)', () => {
  const assembler = new ToolPromptAssembler()

  // ── I-5: auto 不注入 ──

  it('I-5: auto → null', () => {
    const decision: ToolDecision = {
      preference: 'auto',
      confidence: 0.5,
      reason: ToolDecisionReason.DEFAULT,
    }
    expect(assembler.assemble(decision)).toBeNull()
  })

  it('I-5: auto 不论 reason 都返回 null', () => {
    const reasons = Object.values(ToolDecisionReason)
    for (const reason of reasons) {
      const decision: ToolDecision = { preference: 'auto', confidence: 0.5, reason }
      expect(assembler.assemble(decision)).toBeNull()
    }
  })

  // ── 非 auto 行为验证 ──

  it('proactive → 返回字符串', () => {
    const decision: ToolDecision = {
      preference: 'proactive',
      confidence: 0.8,
      reason: ToolDecisionReason.EXECUTION_TASK,
    }
    const result = assembler.assemble(decision)
    expect(result).toBeTypeOf('string')
    expect(result!.length).toBeGreaterThan(0)
  })

  it('avoid → 返回字符串', () => {
    const decision: ToolDecision = {
      preference: 'avoid',
      confidence: 0.5,
      reason: ToolDecisionReason.DEFAULT,
    }
    const result = assembler.assemble(decision)
    expect(result).toBeTypeOf('string')
    expect(result!.length).toBeGreaterThan(0)
  })

  it('forbidden → 返回字符串', () => {
    const decision: ToolDecision = {
      preference: 'forbidden',
      confidence: 1.0,
      reason: ToolDecisionReason.SAFETY,
    }
    const result = assembler.assemble(decision)
    expect(result).toBeTypeOf('string')
    expect(result!.length).toBeGreaterThan(0)
  })

  // ── I-7: 不修改输入对象 ──

  it('I-7: assemble() 不修改 decision 对象', () => {
    const decision: ToolDecision = {
      preference: 'proactive',
      confidence: 0.8,
      reason: ToolDecisionReason.USER_REQUEST,
    }
    const snapshot = { ...decision }

    assembler.assemble(decision)

    expect(decision).toEqual(snapshot)
  })
})
