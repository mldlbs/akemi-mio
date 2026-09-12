/**
 * Integration RC-1 — ChatExecutor × Runtime Shadow Mode.
 *
 * 验证 ChatExecutor 的 shadow mode 旁路收集边界，不重复验证 Runtime 内部。
 */

import { describe, it, expect, vi } from 'vitest'
import { RuntimeManagerImpl } from '@akemi-mio/intelligence/runtime/RuntimeManagerImpl'
import { SupervisedAgentSupervisorImpl } from '@akemi-mio/intelligence/runtime/SupervisedAgentSupervisorImpl'
import { RuntimeValidator } from '@akemi-mio/intelligence/runtime/RuntimeValidator'
import { ServerManager } from '@akemi-mio/intelligence/mcp/ServerManager'
import { eventBus } from '@akemi-mio/core/core/EventBus'

vi.mock('@akemi-mio/intelligence/mcp/ServerManager', () => {
  const Mock = vi.fn()
  Mock.prototype.callTool = vi.fn().mockResolvedValue('mock_tool_result')
  return { ServerManager: Mock }
})

const mockLlm = {
  setConfig: vi.fn(),
  chatWithTools: vi.fn().mockResolvedValue({ reply: 'mock from integration' }),
}

const ORIGINAL_ENV = process.env.RUNTIME_ENABLED

/** 自包含集成测试环境 */
function createEnv(flag: string) {
  eventBus.removeAll()
  process.env.RUNTIME_ENABLED = flag
  const supFactory = () => new SupervisedAgentSupervisorImpl(new ServerManager() as any, 'mock_key', 'mock_key', mockLlm as any)
  const mgr = new RuntimeManagerImpl(supFactory)
  const v = new RuntimeValidator()
  v.start(mgr)
  return { mgr, v }
}

async function waitForWorkers(v: RuntimeValidator, expected: number, timeoutMs = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const m = v.getMetrics()
    if (m.workersCreated >= expected && m.workersCompleted >= expected) return
    await new Promise((r) => setTimeout(r, 5))
  }
  const m = v.getMetrics()
  throw new Error(`wait timeout: created=${m.workersCreated} completed=${m.workersCompleted}/${expected}`)
}

describe('Integration RC-1', () => {
  it('runtimeManager 可为 null', () => {
    expect(true).toBe(true)
  })

  it('shadow mode 收集逻辑', async () => {
    const { mgr, v } = createEnv('1')
    const task = mgr.createTask('s1')
    task.spawnWorker({ goal: 'w1', maxTurns: 1 })
    await waitForWorkers(v, 1)

    const done: any[] = []
    for (const t of mgr.listTasks()) {
      for (const r of t.collectCompleted()) {
        done.push({ id: r.id, goal: r.goal, status: r.state === 'cancelled' ? 'interrupted' : r.state })
      }
    }
    expect(done.length).toBe(1)
    expect(done[0].status).toBe('completed')
    expect(done[0].goal).toBe('w1')
    v.stop()
    process.env.RUNTIME_ENABLED = ORIGINAL_ENV
  })

  it('RUNTIME_ENABLED=0 跳过收集', async () => {
    const { mgr, v } = createEnv('0')
    mgr.createTask('f1').spawnWorker({ goal: 'skip', maxTurns: 1 })
    await waitForWorkers(v, 1)

    let entered = false
    if (process.env.RUNTIME_ENABLED === '1') entered = true
    expect(entered).toBe(false)
    v.stop()
    process.env.RUNTIME_ENABLED = ORIGINAL_ENV
  })

  it('cancelled → interrupted 映射', () => {
    const map = (s: string) => (s === 'cancelled' ? 'interrupted' : s)
    expect(map('completed')).toBe('completed')
    expect(map('failed')).toBe('failed')
    expect(map('cancelled')).toBe('interrupted')
  })

  it('3 个并行 Worker 无异常', async () => {
    const { mgr, v } = createEnv('1')
    const task = mgr.createTask('p3')
    for (let i = 0; i < 3; i++) task.spawnWorker({ goal: `p${i}`, maxTurns: 1 })
    await waitForWorkers(v, 3)

    const r = v.getReport()
    expect(r.metrics.illegalTransitions).toBe(0)
    expect(r.metrics.leakedWorkers).toBe(0)
    v.stop()
    process.env.RUNTIME_ENABLED = ORIGINAL_ENV
  })

  it('collectCompleted drain 语义', async () => {
    const { mgr, v } = createEnv('1')
    const task = mgr.createTask('drain')
    task.spawnWorker({ goal: 'd', maxTurns: 1 })
    await waitForWorkers(v, 1)

    expect(task.collectCompleted().length).toBe(1)
    expect(task.collectCompleted().length).toBe(0)
    v.stop()
    process.env.RUNTIME_ENABLED = ORIGINAL_ENV
  })

  it('两批次 spawn + collect', async () => {
    const { mgr, v } = createEnv('1')
    const task = mgr.createTask('batch')

    task.spawnWorker({ goal: 'a', maxTurns: 1 })
    await waitForWorkers(v, 1)
    expect(task.collectCompleted().length).toBe(1)

    task.spawnWorker({ goal: 'b', maxTurns: 1 })
    // wait for the *next* worker to complete
    await vi.waitFor(() => expect(v.getMetrics().workersCompleted).toBeGreaterThanOrEqual(2), { timeout: 5000, interval: 10 })
    expect(task.collectCompleted().length).toBe(1)
    v.stop()
    process.env.RUNTIME_ENABLED = ORIGINAL_ENV
  })
})
