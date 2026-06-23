import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EvolutionScheduler, EvolutionSchedulerState } from '../EvolutionScheduler'
import { eventBus } from '../../core/EventBus'

vi.mock('../../logger/Logger', () => ({ log: vi.fn() }))

function resetEvents() {
  eventBus.removeAll()
}

describe('EvolutionScheduler', () => {
  let scheduler: EvolutionScheduler
  let agentService: any
  let callbacks: any

  beforeEach(() => {
    resetEvents()
    agentService = { isBusy: vi.fn(() => false), abortSelfTask: vi.fn() }
    callbacks = { onAnalyze: vi.fn().mockResolvedValue(undefined), onExecute: vi.fn().mockResolvedValue(undefined) }
    scheduler = new EvolutionScheduler(agentService, callbacks, eventBus, { analysisTimeoutMs: 60000, analysisStuckTimeoutMs: 60000 })
  })

  afterEach(() => {
    scheduler.stop()
  })

  it('初始状态 IDLE', () => {
    expect(scheduler.getState()).toBe(EvolutionSchedulerState.IDLE)
  })

  it('transitionState 改变状态并发射事件', () => {
    const events: any[] = []
    eventBus.on('evolution.scheduler.state' as any, (p: any) => events.push(p))
    scheduler.transitionState(EvolutionSchedulerState.ANALYZING, '测试')
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[0].from).toBe('IDLE')
    expect(events[0].to).toBe('ANALYZING')
  })

  it('IDLE tick 触发 onAnalyze 回调', async () => {
    await scheduler.schedulerTick()
    expect(callbacks.onAnalyze).toHaveBeenCalled()
  })

  it('tick 后状态切换 ANALYZING', async () => {
    await scheduler.schedulerTick()
    expect(scheduler.getState()).toBe(EvolutionSchedulerState.ANALYZING)
  })

  it('ANALYZING stuck 超时', async () => {
    scheduler.lastAnalysisTime = Date.now() - 120001
    scheduler.currentState = EvolutionSchedulerState.ANALYZING
    await scheduler.schedulerTick()
    expect(agentService.abortSelfTask).toHaveBeenCalled()
  })

  it('EXECUTING stuck 超时', async () => {
    scheduler.lastExecutionTime = Date.now() - 600001
    scheduler.currentState = EvolutionSchedulerState.EXECUTING
    await scheduler.schedulerTick()
    expect(agentService.abortSelfTask).toHaveBeenCalled()
  })

  it('VERIFYING 超时返回 IDLE', async () => {
    scheduler.lastExecutionTime = Date.now() - 900001
    scheduler.currentState = EvolutionSchedulerState.VERIFYING
    await scheduler.schedulerTick()
    expect(scheduler.getState()).toBe(EvolutionSchedulerState.IDLE)
  })

  it('COOLDOWN 不操作', async () => {
    scheduler.currentState = EvolutionSchedulerState.COOLDOWN
    await scheduler.schedulerTick()
    expect(scheduler.getState()).toBe(EvolutionSchedulerState.COOLDOWN)
  })

  it('agent busy 不触发分析', async () => {
    agentService.isBusy = vi.fn(() => true)
    await scheduler.schedulerTick()
    expect(callbacks.onAnalyze).not.toHaveBeenCalled()
  })

  it('getRecoveryCooldown 返回剩余', () => {
    scheduler.recoveryCooldownUntil = Date.now() + 30000
    const cd = scheduler.getRecoveryCooldown()
    expect(cd.active).toBe(true)
    expect(cd.remainingMs).toBeGreaterThan(0)
  })

  it('hasPendingPlanStep 无 planManager 返回 false', () => {
    expect(scheduler.hasPendingPlanStep(null)).toBe(false)
  })

  it('1000 次 tick 状态转换不崩溃', async () => {
    for (let i = 0; i < 1000; i++) {
      scheduler.currentState = EvolutionSchedulerState.IDLE
      scheduler.lastAnalysisTime = 0
      await scheduler.schedulerTick()
    }
    expect(scheduler.getState()).toBe(EvolutionSchedulerState.ANALYZING)
  })

  it('start 不抛出', () => {
    scheduler.start()
    expect(true).toBe(true)
  })
})
