import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { closeDatabase, initDatabase } from '@akemi-mio/core/db/connection'
import { useIsolatedTestDatabase } from '../../db/__tests__/testDatabase'
import { ExecutionGoalStore } from '@akemi-mio/evolution/goals/ExecutionGoalStore'
import type { Evidence } from '@akemi-mio/evolution/goals/types'

describe('ExecutionGoalStore', () => {
  let dispose: () => void
  let store: ExecutionGoalStore

  beforeEach(async () => {
    dispose = useIsolatedTestDatabase()
    await initDatabase()
    store = new ExecutionGoalStore()
  })

  afterEach(() => {
    closeDatabase()
    dispose()
  })

  it('creates a goal with planning status and defaults', () => {
    const goal = store.create({
      sessionId: 'session-1',
      objective: '优化 MCP 管理',
      successCriteria: ['capability/provider 映射稳定', 'contract test 通过'],
    })

    expect(goal.id).toMatch(/^exec_goal_/)
    expect(goal.status).toBe('planning')
    expect(goal.currentStep).toBe(0)
    expect(goal.evidence).toEqual([])
    expect(goal.completedAt).toBeNull()
    expect(goal.planId).toBeNull()

    const loaded = store.get(goal.id)
    expect(loaded).toEqual(goal)
  })

  it('persists successCriteria and optional planId', () => {
    const goal = store.create({
      sessionId: null,
      objective: '修复 binding',
      successCriteria: ['npm test 通过', '无回归'],
      planId: 'plan_123',
    })

    const loaded = store.get(goal.id)!
    expect(loaded.successCriteria).toEqual(['npm test 通过', '无回归'])
    expect(loaded.planId).toBe('plan_123')
    expect(loaded.sessionId).toBeNull()
  })

  it('runs the lifecycle planning -> executing -> completed and stamps completedAt', () => {
    const goal = store.create({ sessionId: 's1', objective: '完成某任务', successCriteria: ['ok'] })

    expect(store.markExecuting(goal.id)).toBe(true)
    expect(store.get(goal.id)!.status).toBe('executing')

    expect(store.markBlocked(goal.id)).toBe(true)
    expect(store.get(goal.id)!.status).toBe('blocked')

    expect(store.complete(goal.id)).toBe(true)
    const completed = store.get(goal.id)!
    expect(completed.status).toBe('completed')
    expect(completed.completedAt).not.toBeNull()
  })

  it('treats completed and abandoned as terminal', () => {
    const goal = store.create({ sessionId: 's1', objective: '任务', successCriteria: [] })
    store.complete(goal.id)

    expect(store.markExecuting(goal.id)).toBe(false)
    expect(store.markBlocked(goal.id)).toBe(false)
    expect(store.abandon(goal.id)).toBe(false)
    expect(store.get(goal.id)!.status).toBe('completed')

    const abandoned = store.create({ sessionId: 's1', objective: '任务2', successCriteria: [] })
    store.abandon(abandoned.id)
    expect(store.complete(abandoned.id)).toBe(false)
    expect(store.get(abandoned.id)!.status).toBe('abandoned')
  })

  it('appends evidence in order', () => {
    const goal = store.create({ sessionId: 's1', objective: '跑测试', successCriteria: ['test passed'] })
    const ev1: Evidence = { type: 'command_success', value: 'ok', tool: 'run_command', step: 1, success: true, createdAt: 1 }
    const ev2: Evidence = { type: 'test_result', value: 'passed', tool: 'run_command', step: 2, success: true, createdAt: 2 }

    expect(store.appendEvidence(goal.id, ev1)).toBe(true)
    expect(store.appendEvidence(goal.id, ev2)).toBe(true)

    const loaded = store.get(goal.id)!
    expect(loaded.evidence).toHaveLength(2)
    expect(loaded.evidence[0]).toEqual(ev1)
    expect(loaded.evidence[1]).toEqual(ev2)
  })

  it('binds a plan and advances the current step', () => {
    const goal = store.create({ sessionId: 's1', objective: '按计划执行', successCriteria: [] })

    expect(store.bindPlan(goal.id, 'plan_x')).toBe(true)
    expect(store.advanceStep(goal.id, 2)).toBe(true)

    const loaded = store.get(goal.id)!
    expect(loaded.planId).toBe('plan_x')
    expect(loaded.currentStep).toBe(2)

    expect(store.advanceStep(goal.id, -1)).toBe(false)
    expect(store.get(goal.id)!.currentStep).toBe(2)
  })

  it('lists goals by session and active status', () => {
    const a = store.create({ sessionId: 's1', objective: 'A', successCriteria: [] })
    const b = store.create({ sessionId: 's1', objective: 'B', successCriteria: [] })
    const c = store.create({ sessionId: 's2', objective: 'C', successCriteria: [] })
    store.complete(b.id)

    const s1 = store.listBySession('s1')
    expect(s1.map((g) => g.id)).toEqual([a.id, b.id])

    const active = store.listActive()
    expect(active.map((g) => g.id)).toEqual([a.id, c.id])
  })

  it('computes completion-rate stats', () => {
    const a = store.create({ sessionId: 's1', objective: 'A', successCriteria: [] })
    const b = store.create({ sessionId: 's1', objective: 'B', successCriteria: [] })
    const c = store.create({ sessionId: 's1', objective: 'C', successCriteria: [] })
    const d = store.create({ sessionId: 's1', objective: 'D', successCriteria: [] })
    store.complete(a.id)
    store.complete(b.id)
    store.markBlocked(c.id)
    store.abandon(d.id)

    const stats = store.getStats()
    expect(stats.total).toBe(4)
    expect(stats.completed).toBe(2)
    expect(stats.blocked).toBe(1)
    expect(stats.abandoned).toBe(1)
    expect(stats.active).toBe(0)
    expect(stats.completionRate).toBeCloseTo(0.5)

    const since = store.getStats(Date.now() + 1)
    expect(since.total).toBe(0)
    expect(since.completionRate).toBe(0)
  })
  it('returns null / false for unknown ids', () => {
    expect(store.get('missing')).toBeNull()
    expect(store.setStatus('missing', 'executing')).toBe(false)
    expect(store.appendEvidence('missing', { type: 'x', value: 'y', tool: 't', step: 0, success: true, createdAt: 0 })).toBe(false)
    expect(store.bindPlan('missing', 'plan')).toBe(false)
    expect(store.advanceStep('missing', 1)).toBe(false)
  })
  it('persists methodology binding', () => {
    const goal = store.create({
      sessionId: 's1',
      objective: '修复 bug',
      successCriteria: ['测试通过'],
      methodology: 'systematic_debugging',
    })

    expect(goal.methodology).toBe('systematic_debugging')
    expect(store.get(goal.id)!.methodology).toBe('systematic_debugging')

    const without = store.create({ sessionId: 's1', objective: '无方法论', successCriteria: [] })
    expect(without.methodology).toBeNull()
  })
  it('computes methodology-grouped stats', () => {
    const a = store.create({ sessionId: 's1', objective: 'A', successCriteria: [], methodology: 'systematic_debugging' })
    const b = store.create({ sessionId: 's1', objective: 'B', successCriteria: [], methodology: 'executing_plan' })
    store.complete(a.id)
    store.markBlocked(b.id)

    const stats = store.getMethodologyStats()
    expect(stats).toHaveLength(2)

    const debug = stats.find((s) => s.methodology === 'systematic_debugging')!
    expect(debug.total).toBe(1)
    expect(debug.completed).toBe(1)
    expect(debug.completionRate).toBe(1)

    const exec = stats.find((s) => s.methodology === 'executing_plan')!
    expect(exec.total).toBe(1)
    expect(exec.blocked).toBe(1)
    expect(exec.completionRate).toBe(0)
  })
})
