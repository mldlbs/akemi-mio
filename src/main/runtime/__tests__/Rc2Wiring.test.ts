/**
 * RC-2 接线验证 — 直接调用 SubAgentPoolAdapter.spawn()
 * 不走 LLM，不依赖 model 是否选工具。
 *
 * 验证链:
 *   SubAgentPoolAdapter.spawn()
 *     → ensureTask()
 *       → RuntimeManagerImpl.createTask('default') ← taskCount +1
 *         → RuntimeTaskImpl.spawnWorker()
 *           → Supervisor.spawnWorker()
 *             → WorkerHandle.start()
 */
import { RuntimeManagerImpl } from '../RuntimeManagerImpl'
import { SupervisedAgentSupervisorImpl } from '../SupervisedAgentSupervisorImpl'
import { ServerManager } from '../../mcp/ServerManager'

// mock LLM
const mockLlm = {
  setConfig: vi.fn(),
  chatWithTools: vi.fn().mockResolvedValue({ reply: 'mock' }),
}

vi.mock('../mcp/ServerManager', () => {
  const Mock = vi.fn()
  Mock.prototype.callTool = vi.fn().mockResolvedValue('mock_tool_result')
  return { ServerManager: Mock }
})

describe('RC-2 SubAgentPoolAdapter 接线验证', () => {

  it('spawn() → createTask() → taskCount+1 → Worker 注册', { timeout: 30000 }, async () => {
    const mcp = new ServerManager() as any
    const supFactory = () => new SupervisedAgentSupervisorImpl(mcp, 'mock_key', 'mock_key', mockLlm as any)
    const runtimeManager = new RuntimeManagerImpl(supFactory)

    const adapter = new (await import('../../agent/SubAgentPoolAdapter')).SubAgentPoolAdapter(mcp, 'mock_key', 'mock_key', runtimeManager)

    // 初始 task 数为 0
    expect(runtimeManager.listTasks().length).toBe(0)

    // spawn 触发 ensureTask → createTask
    const id1 = adapter.spawn('test worker A')
    expect(id1).toBeTruthy()

    // RuntimeManager 上多了一个 Task
    const tasks1 = runtimeManager.listTasks()
    expect(tasks1.length).toBe(1)
    expect(tasks1[0].name).toBe('default')

    // Task 里有 1 个 Worker
    const status1 = tasks1[0].getStatus()
    expect(status1.workerCount).toBe(1)
    expect(status1.workers[0].goal).toBe('test worker A')

    // 第二次 spawn 共用 default Task
    adapter.spawn('test worker B')
    const tasks2 = runtimeManager.listTasks()
    expect(tasks2.length).toBe(1)
    const status2 = tasks2[0].getStatus()
    expect(status2.workerCount).toBe(2)

    // collectCompleted 能收集到完成的 worker
    await vi.waitFor(
      () => expect(adapter.collectCompleted().length).toBe(2),
      { timeout: 15000, interval: 100 },
    )
  })

  it.skip('getStatus().completed 应在 worker 完成后同步', { timeout: 30000 }, async () => {
    const mcp = new ServerManager() as any
    const supFactory = () => new SupervisedAgentSupervisorImpl(mcp, 'mock_key', 'mock_key', mockLlm as any)
    const runtimeManager = new RuntimeManagerImpl(supFactory)
    const adapter = new (await import('../../agent/SubAgentPoolAdapter')).SubAgentPoolAdapter(mcp, 'mock_key', 'mock_key', runtimeManager)

    adapter.spawn('test worker A')
    adapter.spawn('test worker B')

    await vi.waitFor(
      () => expect(runtimeManager.listTasks()[0].getStatus().completed).toBe(2),
      { timeout: 15000, interval: 100 },
    )
  })

  it('spawnTask() 同样经过同一链路', async () => {
    const mcp = new ServerManager() as any
    const runtimeManager = new RuntimeManagerImpl(
      () => new SupervisedAgentSupervisorImpl(mcp, 'mock_key', 'mock_key', mockLlm as any),
    )
    const adapter = new (await import('../../agent/SubAgentPoolAdapter')).SubAgentPoolAdapter(mcp, 'mock_key', 'mock_key', runtimeManager)

    const result = await adapter.spawnTask('test awaitable task')
    expect(result).toBeTruthy()
    expect(result.status).toBe('completed')
    expect(runtimeManager.listTasks().length).toBe(1)
  })

  it('两个 Adapter 实例不互相干扰', async () => {
    const mcp = new ServerManager() as any
    const rm1 = new RuntimeManagerImpl(() => new SupervisedAgentSupervisorImpl(mcp, 'k', 'k', mockLlm as any))
    const rm2 = new RuntimeManagerImpl(() => new SupervisedAgentSupervisorImpl(mcp, 'k', 'k', mockLlm as any))

    const a1 = new (await import('../../agent/SubAgentPoolAdapter')).SubAgentPoolAdapter(mcp, 'k', 'k', rm1)
    const a2 = new (await import('../../agent/SubAgentPoolAdapter')).SubAgentPoolAdapter(mcp, 'k', 'k', rm2)

    a1.spawn('A1')
    a2.spawn('B1')
    a2.spawn('B2')

    expect(rm1.listTasks().length).toBe(1)
    expect(rm1.listTasks()[0].getStatus().workerCount).toBe(1)

    expect(rm2.listTasks().length).toBe(1)
    expect(rm2.listTasks()[0].getStatus().workerCount).toBe(2)
  })
})
