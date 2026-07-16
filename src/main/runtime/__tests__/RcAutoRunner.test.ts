/**
 * ReplayRunner — RC 自动化场景验证
 *
 * 运行: npx vitest run src/main/runtime/__tests__/RcAutoRunner.test.ts
 */

import { describe, it, expect, vi } from 'vitest'
import { RuntimeManagerImpl } from '../RuntimeManagerImpl'
import { SupervisedAgentSupervisorImpl } from '../SupervisedAgentSupervisorImpl'
import { RuntimeValidator } from '../RuntimeValidator'
import { ReplayRunner, SCENARIO_SINGLE_TASK, SCENARIO_PARALLEL_5 } from '../ReplayRunner'
import { ServerManager } from '../../mcp/ServerManager'
import { eventBus } from '../../core/EventBus'

vi.mock('../../mcp/ServerManager', () => {
  const Mock = vi.fn()
  Mock.prototype.callTool = vi.fn().mockResolvedValue('mock_tool_result')
  return { ServerManager: Mock }
})

/**
 * 自包含测试环境。EventBus 单例会跨测试泄漏事件，因此我们在
 * 每次运行前完全清理 EventBus，记录基线，然后对比增量。
 */
async function isolatedRun<T>(
  fn: (mgr: RuntimeManagerImpl, val: RuntimeValidator, run: ReplayRunner, baseline: ReturnType<RuntimeValidator['getMetrics']>) => Promise<T>,
): Promise<T> {
  // 完全清理 EventBus，防止旧 Supervisor/Worker 的异步事件泄漏
  eventBus.removeAll()

  const mockLlm = {
    setConfig: vi.fn(),
    chatWithTools: vi.fn().mockResolvedValue({ reply: 'mock reply from runner' }),
  }
  const supFactory = () => new SupervisedAgentSupervisorImpl(new ServerManager() as any, 'mock_key', 'mock_key', mockLlm as any)
  const mgr = new RuntimeManagerImpl(supFactory)
  const validator = new RuntimeValidator()
  validator.start(mgr)
  const runner = new ReplayRunner(mgr, validator)
  const baseline = validator.getMetrics()
  try {
    return await fn(mgr, validator, runner, baseline)
  } finally {
    validator.stop()
  }
}

function delta(baseline: ReturnType<RuntimeValidator['getMetrics']>, metrics: ReturnType<RuntimeValidator['getMetrics']>) {
  return {
    tasksCreated: metrics.tasksCreated - baseline.tasksCreated,
    workersCreated: metrics.workersCreated - baseline.workersCreated,
    workersCompleted: metrics.workersCompleted - baseline.workersCompleted,
    illegalTransitions: metrics.illegalTransitions - baseline.illegalTransitions,
    leakedWorkers: metrics.leakedWorkers - baseline.leakedWorkers,
    rollbackCount: metrics.rollbackCount - baseline.rollbackCount,
    behaviorMismatch: metrics.behaviorMismatch - baseline.behaviorMismatch,
  }
}

describe('Runtime RC Auto-Runner', () => {
  it('single-task', async () => {
    await isolatedRun(async (_, __, runner, bl) => {
      const report = await runner.runScenario(SCENARIO_SINGLE_TASK)
      const d = delta(bl, report.metrics)
      // 使用 >= 而非精确相等 — EventBus 单例会跨 test file 泄漏
      expect(d.tasksCreated).toBeGreaterThanOrEqual(1)
      expect(d.workersCreated).toBeGreaterThanOrEqual(1)
      // 异常指标必须为零（这是 RC 核心要求）
      expect(d.illegalTransitions).toBe(0)
      expect(d.leakedWorkers).toBe(0)
    })
  })

  it('parallel-5', async () => {
    await isolatedRun(async (_, __, runner, bl) => {
      const report = await runner.runScenario(SCENARIO_PARALLEL_5)
      const d = delta(bl, report.metrics)
      expect(d.tasksCreated).toBeGreaterThanOrEqual(1)
      expect(d.workersCreated).toBeGreaterThanOrEqual(5)
      expect(d.workersCompleted).toBeGreaterThanOrEqual(5)
      expect(d.illegalTransitions).toBe(0)
      expect(d.leakedWorkers).toBe(0)
    })
  })

  it('push to RC-2 (>= 100 workers, zero anomalies)', async () => {
    await isolatedRun(async (_, __, runner, bl) => {
      const report = await runner.runUntilPhase('rc-2_default', 10, 12)
      expect(report.blocked).toBe(false)
      expect(report.phase).toBe('rc-2_default')
      const d = delta(bl, report.metrics)
      expect(d.workersCompleted).toBeGreaterThanOrEqual(100)
      expect(d.illegalTransitions).toBe(0)
      expect(d.leakedWorkers).toBe(0)
      expect(d.rollbackCount).toBe(0)
      expect(d.behaviorMismatch).toBe(0)
    })
  })

  it('push to retirement_ready (>= 500 workers, zero anomalies)', async () => {
    await isolatedRun(async (_, __, runner, bl) => {
      const report = await runner.runUntilPhase('retirement_ready', 25, 22)
      expect(report.blocked).toBe(false)
      expect(report.phase).toBe('retirement_ready')
      const d = delta(bl, report.metrics)
      expect(d.workersCompleted).toBeGreaterThanOrEqual(500)
      expect(d.illegalTransitions).toBe(0)
      expect(d.leakedWorkers).toBe(0)
      expect(d.rollbackCount).toBe(0)
      expect(d.behaviorMismatch).toBe(0)
    })
  })
})
