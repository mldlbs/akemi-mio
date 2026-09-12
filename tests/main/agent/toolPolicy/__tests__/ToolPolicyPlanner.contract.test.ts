/**
 * ADR-008 Contract Tests — ToolPolicyPlanner
 *
 * 验证 7 项 Invariant 中的：
 *   I-1: 确定性 — 相同输入必然产生完全相同的 ToolDecision
 *   I-2: 无副作用 — decide() 不修改任何外部状态
 *   I-3: 无 LLM 调用 — 纯本地同步逻辑（由依赖审计保证，此处验证同步返回值）
 *   I-6: Safety Filter < ToolDecision — toToolFilter() 不影响 decide()
 *   I-7: ToolDecision 不可变 — 输出后不可修改
 */

import { describe, it, expect } from 'vitest'
import { ToolPolicyPlanner } from '@akemi-mio/intelligence/agent/toolPolicy/ToolPolicyPlanner'
import { ToolDecisionReason } from '@akemi-mio/intelligence/agent/toolPolicy/types'

describe('ToolPolicyPlanner — Contract (ADR-008 Invariants)', () => {
  const planner = new ToolPolicyPlanner()

  // ── I-1: 确定性 ──

  it('I-1: 相同输入必然产生完全相同的 ToolDecision', () => {
    const input = { scene: 'quick_qa' as const, text: '你好' }
    const a = planner.decide(input.scene, input.text)
    const b = planner.decide(input.scene, input.text)

    expect(a).toEqual(b)
    // 严格引用不同但值相同
    expect(a).not.toBe(b)
  })

  it('I-1: 信号命中场景也满足确定性', () => {
    const input = { scene: 'casual_chat' as const, text: '今天天气怎么样' }
    const a = planner.decide(input.scene, input.text)
    const b = planner.decide(input.scene, input.text)

    expect(a).toEqual(b)
  })

  // ── I-2: 无副作用（decide 不修改外部状态）──

  it('I-2: decide() 不修改输入参数', () => {
    const scene = 'code_debugging' as const
    const text = '帮我实现一个排序函数'
    const textBefore = text
    const context = { hasRecentToolCalls: false }
    const contextBefore = { ...context }

    planner.decide(scene, text, context)

    expect(text).toBe(textBefore)
    expect(context).toEqual(contextBefore)
  })

  it('I-2: toToolFilter() 不修改 decision 对象', () => {
    const decision = planner.decide('quick_qa' as const, '你好')
    const prefBefore = decision.preference
    const reasonBefore = decision.reason

    planner.toToolFilter(decision)

    expect(decision.preference).toBe(prefBefore)
    expect(decision.reason).toBe(reasonBefore)
  })

  // ── I-3: 同步无异步 ──

  it('I-3: decide() 返回普通对象，非 Promise', () => {
    const result = planner.decide('casual_chat' as const, '今天心情不错')
    expect(result).not.toBeInstanceOf(Promise)
    expect(result).toHaveProperty('preference')
    expect(result).toHaveProperty('confidence')
    expect(result).toHaveProperty('reason')
  })

  // ── I-6: Safety Filter < ToolDecision ──

  it('I-6: toToolFilter() 的调用不影响后续 decide()', () => {
    // 先调用 filter
    const d1 = planner.decide('casual_chat' as const, '你好')
    planner.toToolFilter(d1)

    // 再调用 decide，结果应不受影响
    const d2 = planner.decide('casual_chat' as const, '你好')
    expect(d2).toEqual(d1)
  })

  it('I-6: avoid → []', () => {
    const decision = planner.decide('quick_qa' as const, '你好')
    expect(decision.preference).toBe('avoid')
    expect(planner.toToolFilter(decision)).toEqual([])
  })

  it('I-6: forbidden 无信号命中时走 scene 默认，但直接构造测试 forbidden', () => {
    // 构造一个 forbidden 的 decision 测试 filter
    const d = { preference: 'forbidden' as const, confidence: 1, reason: ToolDecisionReason.SAFETY }
    expect(planner.toToolFilter(d)).toEqual([])
  })

  it('I-6: proactive → undefined', () => {
    const decision = planner.decide('code_debugging' as const, '帮我修bug')
    expect(decision.preference).toBe('proactive')
    expect(planner.toToolFilter(decision)).toBeUndefined()
  })

  it('I-6: auto → undefined', () => {
    const decision = planner.decide('deep_discussion' as const, '你怎么看这个架构设计')
    expect(decision.preference).toBe('auto')
    expect(planner.toToolFilter(decision)).toBeUndefined()
  })

  // ── I-7: ToolDecision 不可变 ──

  it('I-7: decide() 每次返回新对象', () => {
    const results = Array.from({ length: 5 }, () => planner.decide('casual_chat' as const, '你好'))
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).not.toBe(results[i - 1])
    }
  })

  it('I-7: toToolFilter() 每次返回新数组/undefined', () => {
    const d = planner.decide('quick_qa' as const, '你好')
    const f1 = planner.toToolFilter(d)
    const f2 = planner.toToolFilter(d)
    if (Array.isArray(f1) && Array.isArray(f2)) {
      expect(f1).not.toBe(f2)
      expect(f1).toEqual(f2)
    }
  })
})
