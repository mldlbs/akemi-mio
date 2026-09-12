import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EvolutionExecutor } from '@akemi-mio/evolution/pipeline/EvolutionExecutor'

vi.mock('@akemi-mio/core/logger/Logger', () => ({ log: vi.fn() }))

describe('EvolutionExecutor', () => {
  let executor: EvolutionExecutor
  let agentService: any
  let planManager: any

  beforeEach(() => {
    agentService = {
      runAgentTask: vi.fn().mockResolvedValue({ success: true, summary: 'OK' }),
      isBusy: vi.fn(() => false),
      abortSelfTask: vi.fn(),
    }
    planManager = {
      getActivePlan: vi.fn().mockReturnValue(null),
      listPlans: vi.fn().mockReturnValue([]),
      getFormattedContext: vi.fn(() => ''),
      updateStep: vi.fn(),
      completePlan: vi.fn(),
      abandonPlan: vi.fn(),
    }
    executor = new EvolutionExecutor(agentService, planManager)
  })

  it('init 状态转换', async () => {
    expect((executor as any).state).toBe('created')
    await executor.init()
    expect((executor as any).state).toBe('ready')
  })

  it('hasPendingStep 无 planManager 返回 false', () => {
    expect(new EvolutionExecutor(agentService, null).hasPendingStep()).toBe(false)
  })

  it('hasPendingStep 无活跃计划返回 false', () => {
    expect(executor.hasPendingStep()).toBe(false)
  })

  it('hasPendingStep 有 pending 步骤返回 true', () => {
    planManager.getActivePlan = vi
      .fn()
      .mockReturnValue({ id: 'p1', steps: [{ id: 's1', description: 's1', status: 'pending' }], status: 'active' })
    expect(executor.hasPendingStep()).toBe(true)
  })

  it('getPlanProgress 无计划返回 0/0', () => {
    expect(executor.getPlanProgress()).toEqual({ completed: 0, total: 0 })
  })

  it('getPlanProgress 返回进度', () => {
    planManager.getActivePlan = vi.fn().mockReturnValue({
      id: 'p1',
      steps: [
        { id: 's1', description: 's1', status: 'done' },
        { id: 's2', description: 's2', status: 'pending' },
      ],
      status: 'active',
    })
    expect(executor.getPlanProgress()).toEqual({ completed: 1, total: 2 })
  })

  it('executeNextStep review 模式直接返回', async () => {
    executor.setSafetyMode('review')
    const r = await executor.executeNextStep({ planId: 'p1', stepIndex: 0, stepDescription: '步骤', planCtx: '', cognitiveCtx: '' })
    expect(r.success).toBe(false)
    expect(r.error).toContain('review')
  })

  it('executeNextStep 无 planManager 返回错误', async () => {
    const e = new EvolutionExecutor(agentService, null)
    const r = await e.executeNextStep({ planId: 'p1', stepIndex: 0, stepDescription: 's', planCtx: '', cognitiveCtx: '' })
    expect(r.success).toBe(false)
  })

  it('executeNextStep 完成所有步骤', async () => {
    planManager.getActivePlan = vi.fn().mockReturnValue({
      id: 'p1',
      title: '测试',
      description: 'd',
      steps: [{ id: 's1', description: '完成', status: 'done' }],
      status: 'active',
    })
    planManager.listPlans = vi
      .fn()
      .mockReturnValue([
        { id: 'p1', title: '测试', description: 'd', steps: [{ id: 's1', description: '完成', status: 'done' }], status: 'active' },
      ])
    const r = await executor.executeNextStep({ planId: 'p1', stepIndex: 0, stepDescription: '', planCtx: '', cognitiveCtx: '' })
    expect(r.planCompleted).toBe(true)
  })

  it('resetFailures 重置计数器', () => {
    executor.resetFailures()
    expect(executor.getExecuteFailures()).toBe(0)
  })
})
