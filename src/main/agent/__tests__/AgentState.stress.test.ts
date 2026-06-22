import { describe, it, expect } from 'vitest'
import { AgentState } from '../AgentState'

describe('AgentState 压力测试', () => {
  const MODE = 'chat'

  it('10000 次交替有效/无效 transition 后状态不崩溃', () => {
    const s = new AgentState(MODE, 'stress_001')
    const validPairs: Array<[string, string]> = [
      ['idle', 'observe'],
      ['observe', 'think'],
      ['think', 'act'],
      ['act', 'idle'],
      ['idle', 'think'],
      ['think', 'plan'],
      ['plan', 'act'],
      ['act', 'reflect'],
      ['reflect', 'sleep'],
      ['sleep', 'idle'],
    ]
    const invalidPairs: Array<[string, string]> = [
      ['idle', 'act'],
      ['think', 'sleep'],
      ['act', 'plan'],
      ['reflect', 'act'],
      ['sleep', 'think'],
    ]
    for (let i = 0; i < 10000; i++) {
      const [from, to] = i % 3 === 0 ? invalidPairs[i % invalidPairs.length] : validPairs[i % validPairs.length]
      s.stage = from as any
      const ok = s.transitionStage(to as any)
      if (i % 3 === 0) {
        expect(ok).toBe(false)
        expect(s.stage).toBe(from)
      } else {
        expect(ok).toBe(true)
        expect(s.stage).toBe(to)
      }
    }
  })

  it('10000 次 lifecycle 交替后状态一致', () => {
    const s = new AgentState(MODE, 'stress_002')
    const cycle = ['ready', 'running', 'interrupted', 'running', 'completed', 'ready'] as const
    for (let i = 0; i < 2000; i++) {
      for (const target of cycle) s.transitionLifecycle(target)
      expect(s.lifecycle).toBe('ready')
    }
  })

  it('10000 次 reset 后不泄露', () => {
    for (let i = 0; i < 10000; i++) {
      const s = new AgentState(MODE, `req_${i}`)
      s.transitionStage('observe')
      s.transitionLifecycle('running')
      s.recordTokens(100)
      s.recordToolCall()
      s.incrementStep()
      s.reset(`req_new_${i}`)
      expect(s.stage).toBe('idle')
      expect(s.lifecycle).toBe('ready')
      expect(s.meta.step).toBe(0)
      expect(s.meta.tokensUsed).toBe(0)
      expect(s.meta.toolCount).toBe(0)
      expect(s.guard.consecutiveErrors).toBe(0)
    }
  })

  it('10000 次 snapshot 不改变原始状态', () => {
    const s = new AgentState(MODE, 'stress_003')
    s.transitionStage('think')
    s.transitionLifecycle('running')
    s.recordTokens(500)
    for (let i = 0; i < 10000; i++) {
      const snap = s.snapshot()
      expect(snap.stage).toBe('think')
      expect(snap.meta.tokensUsed).toBe(500)
    }
  })

  it('5000 轮完整交互生命周期', () => {
    const s = new AgentState(MODE, 'stress_004')
    for (let i = 0; i < 5000; i++) {
      s.transitionLifecycle('running')
      expect(s.transitionStage('observe')).toBe(true)
      expect(s.transitionStage('think')).toBe(true)
      expect(s.transitionStage('act')).toBe(true)
      s.recordTokens(Math.floor(Math.random() * 500))
      s.recordToolCall()
      s.incrementStep()
      expect(s.transitionStage('reflect')).toBe(true)
      expect(s.transitionStage('idle')).toBe(true)
      expect(s.transitionLifecycle('completed')).toBe(true)
      s.reset(`round_${i}`)
    }
    expect(s.meta.requestId).toBe('round_4999')
    expect(s.stage).toBe('idle')
  })

  it('所有 AgentMode 各跑 1000 次 transition', () => {
    for (const mode of ['chat', 'task', 'evolution', 'background'] as const) {
      const s = new AgentState(mode, 'multi_mode')
      for (let i = 0; i < 1000; i++) {
        s.transitionStage('observe')
        s.transitionStage('think')
        s.transitionLifecycle('running')
        s.recordTokens(50)
        s.incrementStep()
        s.transitionLifecycle('completed')
        s.reset()
      }
      expect(s.stage).toBe('idle')
      expect(s.mode).toBe(mode)
    }
  })

  it('guard 极端值后 reset 归零', () => {
    const s = new AgentState(MODE, 'guard_stress')
    for (let i = 0; i < 1000; i++) {
      s.guard.consecutiveErrors++
      s.guard.consecutiveTimeouts++
      s.guard.forcedContinueCount++
    }
    expect(s.guard.consecutiveErrors).toBe(1000)
    s.reset()
    expect(s.guard).toEqual({ consecutiveErrors: 0, consecutiveTimeouts: 0, forcedContinueCount: 0 })
  })

  it('随机游走 5000 步不进入无效状态', () => {
    const s = new AgentState(MODE, 'random_walk')
    const stages = ['idle', 'observe', 'think', 'plan', 'act', 'reflect', 'sleep'] as const
    for (let i = 0; i < 5000; i++) {
      const from = s.stage
      const to = stages[Math.floor(Math.random() * stages.length)]
      const ok = s.transitionStage(to)
      expect(ok ? s.stage === to : s.stage === from).toBe(true)
    }
  })

  it('full cycle + snapshot 交替 2000 次', () => {
    const s = new AgentState(MODE, 'mix')
    let totalSteps = 0
    for (let i = 0; i < 2000; i++) {
      s.reset()
      s.transitionLifecycle('running')
      s.transitionStage('observe')
      s.transitionStage('think')
      s.transitionStage('act')
      s.recordTokens(100)
      s.recordToolCall()
      s.incrementStep()
      totalSteps++
      const snap = s.snapshot()
      expect(snap.meta.toolCount).toBe(1)
      s.transitionStage('reflect')
      s.transitionStage('idle')
      s.transitionLifecycle('completed')
    }
    // reset 后 step=0，但总步数记录在 totalSteps
    expect(s.stage).toBe('idle')
    expect(totalSteps).toBe(2000)
  })
})
