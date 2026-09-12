/**
 * MetricsCollector 测试
 *
 * 验证监听 EventBus 事件并正确聚合指标
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => process.cwd() },
}))

import { MetricsCollector } from '@akemi-mio/intelligence/observability/MetricsCollector'
import { EventBus } from '@akemi-mio/core/core/EventBus'

function createEventBus(): EventBus {
  return new (EventBus as any)()
}

describe('MetricsCollector', () => {
  let bus: EventBus
  let collector: MetricsCollector

  beforeEach(() => {
    bus = createEventBus()
    collector = new MetricsCollector(bus)
  })

  afterEach(() => {
    collector.destroy()
  })

  it('初始快照全部为零', () => {
    const s = collector.getSnapshot()
    expect(s.evolution.totalCycles).toBe(0)
    expect(s.evolution.successCount).toBe(0)
    expect(s.plans.totalCreated).toBe(0)
    expect(s.tools.totalCalls).toBe(0)
    expect(s.apiCalls.total).toBe(0)
  })

  describe('进化循环指标', () => {
    it('成功的循环应递增 successCount', () => {
      bus.emit('evolution.cycle.completed', {
        success: true,
        summary: '分析完成',
        timestamp: Date.now(),
      })
      const s = collector.getSnapshot()
      expect(s.evolution.totalCycles).toBe(1)
      expect(s.evolution.successCount).toBe(1)
      expect(s.evolution.failureCount).toBe(0)
    })

    it('失败的循环应递增 failureCount', () => {
      bus.emit('evolution.cycle.completed', {
        success: false,
        summary: 'API 错误',
        timestamp: Date.now(),
      })
      const s = collector.getSnapshot()
      expect(s.evolution.totalCycles).toBe(1)
      expect(s.evolution.successCount).toBe(0)
      expect(s.evolution.failureCount).toBe(1)
    })

    it('超时应递增 timeoutCount', () => {
      bus.emit('evolution.cycle.completed', {
        success: false,
        summary: 'timeout: evolution_cycle_timeout',
        timestamp: Date.now(),
      })
      const s = collector.getSnapshot()
      expect(s.evolution.timeoutCount).toBe(1)
    })

    it('多次循环计数正确', () => {
      bus.emit('evolution.cycle.completed', { success: true, summary: 'ok', timestamp: 1 })
      bus.emit('evolution.cycle.completed', { success: false, summary: 'fail', timestamp: 2 })
      bus.emit('evolution.cycle.completed', { success: true, summary: 'ok', timestamp: 3 })

      const s = collector.getSnapshot()
      expect(s.evolution.totalCycles).toBe(3)
      expect(s.evolution.successCount).toBe(2)
      expect(s.evolution.failureCount).toBe(1)
    })
  })

  describe('计划指标', () => {
    it('计划创建应递增 totalCreated 和 activeCount', () => {
      bus.emit('agent.plan.created', { planId: 'p1', title: '计划1' })
      const s = collector.getSnapshot()
      expect(s.plans.totalCreated).toBe(1)
      expect(s.plans.activeCount).toBe(1)
    })

    it('计划完成应递增 totalCompleted 并递减 activeCount', () => {
      bus.emit('agent.plan.created', { planId: 'p1', title: '计划1' })
      bus.emit('agent.plan.completed', { planId: 'p1' })
      const s = collector.getSnapshot()
      expect(s.plans.totalCreated).toBe(1)
      expect(s.plans.totalCompleted).toBe(1)
      expect(s.plans.activeCount).toBe(0)
      expect(s.plans.completionRate).toBe(1)
    })

    it('多个计划的完成率正确', () => {
      bus.emit('agent.plan.created', { planId: 'p1', title: '计划1' })
      bus.emit('agent.plan.created', { planId: 'p2', title: '计划2' })
      bus.emit('agent.plan.created', { planId: 'p3', title: '计划3' })
      bus.emit('agent.plan.completed', { planId: 'p1' })
      bus.emit('agent.plan.completed', { planId: 'p2' })
      const s = collector.getSnapshot()
      expect(s.plans.totalCreated).toBe(3)
      expect(s.plans.totalCompleted).toBe(2)
      expect(s.plans.completionRate).toBeCloseTo(0.667, 2)
    })

    it('totalAbandoned 由推导得出', () => {
      bus.emit('agent.plan.created', { planId: 'p1', title: '计划1' })
      bus.emit('agent.plan.created', { planId: 'p2', title: '计划2' })
      bus.emit('agent.plan.created', { planId: 'p3', title: '计划3' })
      bus.emit('agent.plan.completed', { planId: 'p1' })
      // p2 和 p3 未完成 → activeCount=2
      const s = collector.getSnapshot()
      expect(s.plans.totalAbandoned).toBe(0) // 3-1-2=0
      // 如果 activeCount 变为 0（所有完成/放弃）
    })
  })

  describe('工具调用指标', () => {
    it('工具调用计数正确', () => {
      bus.emit('agent.tool.invoked', { tool: 'read_file', args: { path: '/x' } })
      bus.emit('agent.tool.completed', { tool: 'read_file', result: 'ok' })

      const s = collector.getSnapshot()
      expect(s.tools.totalCalls).toBe(1)
      expect(s.tools.successCount).toBe(1)
      expect(s.tools.failureCount).toBe(0)
      expect(s.apiCalls.total).toBe(1)
    })

    it('工具失败计数正确', () => {
      bus.emit('agent.tool.invoked', { tool: 'write_file', args: { path: '/x' } })
      bus.emit('agent.tool.failed', { tool: 'write_file', error: '权限不足' })

      const s = collector.getSnapshot()
      expect(s.tools.successCount).toBe(0)
      expect(s.tools.failureCount).toBe(1)
    })

    it('按工具名统计', () => {
      bus.emit('agent.tool.invoked', { tool: 'read_file', args: {} })
      bus.emit('agent.tool.completed', { tool: 'read_file', result: 'ok' })
      bus.emit('agent.tool.invoked', { tool: 'read_file', args: {} })
      bus.emit('agent.tool.failed', { tool: 'read_file', error: 'err' })
      bus.emit('agent.tool.invoked', { tool: 'write_file', args: {} })
      bus.emit('agent.tool.completed', { tool: 'write_file', result: 'ok' })

      const s = collector.getSnapshot()
      expect(s.tools.byTool['read_file'].calls).toBe(2)
      expect(s.tools.byTool['read_file'].errors).toBe(1)
      expect(s.tools.byTool['write_file'].calls).toBe(1)
      expect(s.tools.byTool['write_file'].errors).toBe(0)
    })
  })

  describe('快照完整性', () => {
    it('返回快照包含所有字段', () => {
      const s = collector.getSnapshot()
      expect(s).toHaveProperty('evolution')
      expect(s).toHaveProperty('plans')
      expect(s).toHaveProperty('tools')
      expect(s).toHaveProperty('apiCalls')
      expect(s).toHaveProperty('memory')
      expect(s).toHaveProperty('uptime')
      expect(s).toHaveProperty('timestamp')
      expect(typeof s.memory.heapUsedMB).toBe('number')
    })
  })

  describe('reset', () => {
    it('重置所有指标到零', () => {
      bus.emit('evolution.cycle.completed', { success: true, summary: 'ok', timestamp: 1 })
      bus.emit('agent.plan.created', { planId: 'p1', title: '计划1' })
      bus.emit('agent.tool.invoked', { tool: 'read_file', args: {} })
      bus.emit('agent.tool.completed', { tool: 'read_file', result: 'ok' })

      collector.reset()
      const s = collector.getSnapshot()
      expect(s.evolution.totalCycles).toBe(0)
      expect(s.plans.totalCreated).toBe(0)
      expect(s.tools.totalCalls).toBe(0)
    })
  })

  describe('destroy', () => {
    it('销毁后应取消事件订阅', () => {
      collector.destroy()
      // 再 emit 事件不应改变指标
      bus.emit('evolution.cycle.completed', { success: true, summary: 'ok', timestamp: 1 })
      const s = collector.getSnapshot()
      expect(s.evolution.totalCycles).toBe(0)
    })
  })

  describe('execution goal metrics', () => {
    it('counts created/completed/blocked/abandoned events', () => {
      bus.emit('execution_goal.created', { id: 'g1', sessionId: 's1', objective: 'task', criteriaCount: 1, timestamp: 1 })
      bus.emit('execution_goal.completed', { id: 'g1', sessionId: 's1', matchedCriteria: ['x'], evidenceCount: 1, timestamp: 2 })
      bus.emit('execution_goal.blocked', { id: 'g2', sessionId: 's1', failedCriteria: ['y'], reason: 'failed', timestamp: 3 })
      bus.emit('execution_goal.abandoned', { id: 'g3', sessionId: 's1', reason: 'user_stopped', evidenceCount: 0, timestamp: 4 })

      const snap = collector.getSnapshot()
      expect(snap.executionGoals.created).toBe(1)
      expect(snap.executionGoals.completed).toBe(1)
      expect(snap.executionGoals.blocked).toBe(1)
      expect(snap.executionGoals.abandoned).toBe(1)
    })

    it('resets execution goal metrics', () => {
      bus.emit('execution_goal.created', { id: 'g1', sessionId: 's1', objective: 'task', criteriaCount: 1, timestamp: 1 })
      bus.emit('execution_goal.abandoned', { id: 'g2', sessionId: 's1', reason: 'no_reply', evidenceCount: 0, timestamp: 2 })
      collector.reset()
      expect(collector.getSnapshot().executionGoals.created).toBe(0)
      expect(collector.getSnapshot().executionGoals.abandoned).toBe(0)
    })
  })
})
