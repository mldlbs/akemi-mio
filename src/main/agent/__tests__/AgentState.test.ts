import { describe, it, expect, vi } from 'vitest'
import { AgentState, AGENT_MODES } from '../AgentState'

describe('AgentState', () => {
  const MODE = 'chat'
  const REQ_ID = 'req_test_001'

  // ─── 构造 ───

  it('构造后默认值正确', () => {
    const s = new AgentState(MODE, REQ_ID)
    expect(s.mode).toBe(MODE)
    expect(s.stage).toBe('idle')
    expect(s.lifecycle).toBe('ready')
    expect(s.previousStage).toBeNull()
    expect(s.meta.requestId).toBe(REQ_ID)
    expect(s.meta.step).toBe(0)
    expect(s.meta.tokensUsed).toBe(0)
    expect(s.meta.toolCount).toBe(0)
    expect(s.meta.startedAt).toBeLessThanOrEqual(Date.now())
    expect(s.guard).toEqual({ consecutiveErrors: 0, consecutiveTimeouts: 0, forcedContinueCount: 0 })
  })

  it('所有 AgentMode 均可构造', () => {
    for (const mode of AGENT_MODES) {
      const s = new AgentState(mode, REQ_ID)
      expect(s.mode).toBe(mode)
    }
  })

  // ─── stage 转换（有效） ───

  it.each([
    ['idle', 'observe'],
    ['idle', 'think'],
    ['idle', 'sleep'],
    ['observe', 'think'],
    ['observe', 'idle'],
    ['think', 'plan'],
    ['think', 'act'],
    ['think', 'idle'],
    ['think', 'observe'],
    ['plan', 'act'],
    ['plan', 'idle'],
    ['plan', 'think'],
    ['act', 'reflect'],
    ['act', 'observe'],
    ['act', 'idle'],
    ['reflect', 'idle'],
    ['reflect', 'sleep'],
    ['reflect', 'observe'],
    ['sleep', 'idle'],
  ] as const)('%s → %s 转换成功', (from, to) => {
    const s = new AgentState(MODE, REQ_ID)
    s.stage = from
    s.previousStage = null
    expect(s.transitionStage(to)).toBe(true)
    expect(s.stage).toBe(to)
    expect(s.previousStage).toBe(from)
  })

  // ─── stage 转换（无效） ───

  it.each([
    ['idle', 'act'],
    ['idle', 'plan'],
    ['idle', 'reflect'],
    ['observe', 'plan'],
    ['observe', 'act'],
    ['observe', 'reflect'],
    ['observe', 'sleep'],
    ['think', 'sleep'],
    ['think', 'reflect'],
    ['plan', 'observe'],
    ['plan', 'reflect'],
    ['plan', 'sleep'],
    ['act', 'think'],
    ['act', 'plan'],
    ['act', 'sleep'],
    ['reflect', 'plan'],
    ['reflect', 'act'],
    ['sleep', 'observe'],
    ['sleep', 'think'],
    ['sleep', 'plan'],
    ['sleep', 'act'],
    ['sleep', 'reflect'],
  ] as const)('%s → %s 转换失败', (from, to) => {
    const s = new AgentState(MODE, REQ_ID)
    s.stage = from
    const prev = from
    expect(s.transitionStage(to)).toBe(false)
    expect(s.stage).toBe(prev)
    expect(s.previousStage).toBeNull()
  })

  it('相同 stage 转换（如 idle→idle）失败', () => {
    const s = new AgentState(MODE, REQ_ID)
    expect(s.transitionStage('idle')).toBe(false)
    expect(s.stage).toBe('idle')
  })

  // ─── lifecycle 转换（有效） ───

  it.each([
    ['ready', 'running'],
    ['ready', 'completed'],
    ['ready', 'failed'],
    ['running', 'interrupted'],
    ['running', 'completed'],
    ['running', 'failed'],
    ['interrupted', 'running'],
    ['interrupted', 'completed'],
    ['interrupted', 'failed'],
    ['completed', 'ready'],
    ['failed', 'ready'],
  ] as const)('lifecycle %s → %s 转换成功', (from, to) => {
    const s = new AgentState(MODE, REQ_ID)
    s.lifecycle = from
    expect(s.transitionLifecycle(to)).toBe(true)
    expect(s.lifecycle).toBe(to)
  })

  // ─── lifecycle 转换（无效） ───

  it.each([
    ['ready', 'interrupted'],
    ['running', 'ready'],
    ['completed', 'running'],
    ['completed', 'failed'],
    ['failed', 'running'],
    ['failed', 'failed'],
    ['failed', 'interrupted'],
  ] as const)('lifecycle %s → %s 转换失败', (from, to) => {
    const s = new AgentState(MODE, REQ_ID)
    s.lifecycle = from
    expect(s.transitionLifecycle(to)).toBe(false)
    expect(s.lifecycle).toBe(from)
  })

  // ─── guard getter ───

  it('isRunning / isInterrupted', () => {
    const s = new AgentState(MODE, REQ_ID)
    expect(s.isRunning).toBe(false)
    expect(s.isInterrupted).toBe(false)
    s.transitionLifecycle('running')
    expect(s.isRunning).toBe(true)
    expect(s.isInterrupted).toBe(false)
    s.transitionLifecycle('interrupted')
    expect(s.isRunning).toBe(false)
    expect(s.isInterrupted).toBe(true)
  })

  // ─── 计数器 ───

  it('incrementStep', () => {
    const s = new AgentState(MODE, REQ_ID)
    s.incrementStep()
    expect(s.meta.step).toBe(1)
    s.incrementStep()
    s.incrementStep()
    expect(s.meta.step).toBe(3)
  })

  it('recordTokens 累加', () => {
    const s = new AgentState(MODE, REQ_ID)
    s.recordTokens(100)
    s.recordTokens(50)
    expect(s.meta.tokensUsed).toBe(150)
  })

  it('recordToolCall', () => {
    const s = new AgentState(MODE, REQ_ID)
    s.recordToolCall()
    s.recordToolCall()
    expect(s.meta.toolCount).toBe(2)
  })

  // ─── reset ───

  it('reset 清空所有状态（不更新 requestId）', () => {
    const s = new AgentState(MODE, REQ_ID)
    s.stage = 'act'
    s.lifecycle = 'interrupted'
    s.previousStage = 'think'
    s.meta.step = 5
    s.meta.tokensUsed = 999
    s.meta.toolCount = 3
    s.guard.consecutiveErrors = 2
    s.guard.consecutiveTimeouts = 1
    s.guard.forcedContinueCount = 3

    s.reset()
    expect(s.stage).toBe('idle')
    expect(s.lifecycle).toBe('ready')
    expect(s.previousStage).toBeNull()
    expect(s.meta.step).toBe(0)
    expect(s.meta.tokensUsed).toBe(0)
    expect(s.meta.toolCount).toBe(0)
    expect(s.meta.requestId).toBe(REQ_ID)
    expect(s.guard).toEqual({ consecutiveErrors: 0, consecutiveTimeouts: 0, forcedContinueCount: 0 })
  })

  it('reset 可更新 requestId 和 startedAt', () => {
    vi.useFakeTimers()
    const s = new AgentState(MODE, REQ_ID)
    const oldStartedAt = s.meta.startedAt
    vi.advanceTimersByTime(5000)
    s.reset('req_new_id')
    expect(s.meta.requestId).toBe('req_new_id')
    expect(s.meta.startedAt).toBeGreaterThan(oldStartedAt)
    vi.useRealTimers()
  })

  // ─── snapshot ───

  it('snapshot 返回不可变副本', () => {
    const s = new AgentState(MODE, REQ_ID)
    s.transitionStage('observe')
    s.transitionLifecycle('running')
    s.recordTokens(200)
    s.guard.consecutiveErrors = 1

    const snap = s.snapshot()
    expect(snap.mode).toBe(MODE)
    expect(snap.stage).toBe('observe')
    expect(snap.lifecycle).toBe('running')
    expect(snap.meta.tokensUsed).toBe(200)
    expect(snap.guard.consecutiveErrors).toBe(1)

    // 修改 snapshot 不影响源对象
    ;(snap.meta as any).tokensUsed = 0
    expect(s.meta.tokensUsed).toBe(200)
  })

  // ─── guard 独立性 ───

  it('guard 计数器独立运作', () => {
    const s = new AgentState(MODE, REQ_ID)
    s.guard.consecutiveErrors = 3
    s.guard.consecutiveTimeouts = 1
    s.guard.forcedContinueCount = 5
    s.reset()
    expect(s.guard.consecutiveErrors).toBe(0)
    expect(s.guard.consecutiveTimeouts).toBe(0)
    expect(s.guard.forcedContinueCount).toBe(0)
  })
})
