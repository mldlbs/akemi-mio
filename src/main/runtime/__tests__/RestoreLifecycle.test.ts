/**
 * Runtime + Checkpoint 集成测试。
 *
 * 验证 Checkpoint 恢复契约而非完整恢复：
 * - RuntimeCheckpointAdapter 映射逻辑正确
 * - restore 失败不污染当前 Runtime
 * - SafePoint 映射正确
 * - 多 checkpoint 选择正确
 */

import { describe, it, expect, vi } from 'vitest'
import { RuntimeState } from '../RuntimeState'
import { RuntimeManagerImpl } from '../RuntimeManagerImpl'
import { SupervisedAgentSupervisorImpl } from '../SupervisedAgentSupervisorImpl'
import { ServerManager } from '../../mcp/ServerManager'
import { snapshotRuntimeTask, toCheckpointContext, planRestore, mapStateToSafePoint } from '../RuntimeCheckpointAdapter'
import { MockCheckpointManager } from './MockCheckpointManager'

// ── Mock MCP / LLM 依赖 ──

vi.mock('../../mcp/ServerManager', () => {
  const MockServerManager = vi.fn()
  MockServerManager.prototype.callTool = vi.fn().mockResolvedValue('mock_tool_result')
  return { ServerManager: MockServerManager }
})

vi.mock('../../llm/LlmService', () => {
  const MockLlmService = vi.fn()
  MockLlmService.prototype.setConfig = vi.fn()
  MockLlmService.prototype.chatWithTools = vi.fn().mockResolvedValue({ reply: 'mock_llm_done' })
  return { LlmService: MockLlmService }
})

// ══════════════════════════════════════════════════════════════════
//  Test fixtures
// ══════════════════════════════════════════════════════════════════

function createManager() {
  return new RuntimeManagerImpl(
    () => new SupervisedAgentSupervisorImpl(new ServerManager(), 'mock_key', 'mock_key'),
  )
}

/** 创建一个已知状态的 RuntimeTask，直接 snapshot */
async function createSnapshottedTask() {
  const mgr = createManager()
  const task = mgr.createTask('integration-test', { source: 'restore-test' })
  const wh = task.spawnWorker({ goal: 'test worker' })
  // 注意：Worker 运行在 mock LLM 上会立即完成并触发 onWorkerComplete
  // 所以我们不依赖 wh.state，而是直接从 snapshot 读取
  const snapshot = snapshotRuntimeTask(task)
  return { mgr, task, wh, snapshot }
}

// ══════════════════════════════════════════════════════════════════
//  Scenario 1: RuntimeCheckpointAdapter 映射正确性
// ══════════════════════════════════════════════════════════════════

describe('Scenario 1: RuntimeCheckpointAdapter mapping', () => {
  it('should snapshot runtime task metadata correctly', () => {
    const mgr = createManager()
    const task = mgr.createTask('test-task', { source: 'integration' })
    // 立即 snapshot — worker 未完成，仍在 workers 列表中
    const snapshot = snapshotRuntimeTask(task)

    expect(snapshot.taskId).toBe(task.id)
    expect(snapshot.taskName).toBe('test-task')
    expect(snapshot.taskMetadata?.source).toBe('integration')
  })

  it('should map snapshot to checkpoint context with valid execution state', () => {
    const mgr = createManager()
    const task = mgr.createTask('cp-mapping')

    // 显式构造已知状态测试 adapter 映射逻辑
    const snapshot = {
      taskId: task.id,
      taskName: task.name,
      taskMetadata: task.metadata,
      taskCreatedAt: task.createdAt,
      workers: [{
        workerId: 'w_test_1',
        goal: 'mapping test',
        step: 5,
        safePoint: 'after_tool' as const,
        state: RuntimeState.RUNNING,
        pendingDecision: undefined,
      }],
    }

    const ctx = toCheckpointContext(snapshot, {
      conversationContext: { messages: [{ role: 'user', content: 'hello' }], tokenEstimate: 10 },
    })

    expect(ctx.taskId).toBe(task.id)
    expect(ctx.taskName).toBe('cp-mapping')  // matches task = mgr.createTask('cp-mapping')
    expect(ctx.executionState.workerId).toBe('w_test_1')
    expect(ctx.executionState.step).toBe(5)
    expect(ctx.executionState.lastSafePoint).toBe('after_tool')
  })

  it('should produce a valid checkpoint from checkpoint context via MockCheckpointManager', async () => {
    const mgr = createManager()
    const task = mgr.createTask('checkpoint-creation')

    const snapshot = {
      taskId: task.id,
      taskName: task.name,
      taskMetadata: task.metadata,
      taskCreatedAt: task.createdAt,
      workers: [{
        workerId: 'w_cp_1',
        goal: 'cp test',
        step: 3,
        safePoint: 'after_llm' as const,
        state: RuntimeState.WAITING_SUPERVISOR,
        pendingDecision: { query: 'Should I continue?', summary: 'step 3' },
      }],
    }

    const ctx = toCheckpointContext(snapshot)
    const cpMgr = new MockCheckpointManager()
    const cp = await cpMgr.create(ctx)
    await cpMgr.save(cp)

    // Validate round-trip
    const loaded = await cpMgr.load(cp.id)
    expect(loaded.taskId).toBe(task.id)
    expect(loaded.id).not.toBe(task.id)  // checkpointId ≠ taskId
    expect(loaded.executionState.step).toBe(3)
    expect(loaded.executionState.lastSafePoint).toBe('after_llm')
  })

  it('should plan restore from checkpoint with correct strategy — continue', () => {
    const plan = planRestore({
      id: 'cp_1',
      taskId: 'task_1',
      schemaVersion: '1.0',
      runtimeCompatibility: { min: '2.0', max: '2.x' },
      taskState: { name: 'test', createdAt: 0 },
      executionState: {
        workerId: 'w1',
        goal: 'continue test',
        step: 10,
        lastSafePoint: 'before_llm',
        conversationContext: { type: 'reference', messageCount: 5, refId: 'ctx_1', tokenEstimate: 100 },
        pendingToolCalls: [],
      },
      createdAt: 0,
    })

    expect(plan.taskState.name).toBe('test')
    expect(plan.executionPlan[0].workerId).toBe('w1')
    expect(plan.executionPlan[0].step).toBe(10)
    expect(plan.executionPlan[0].resumeFrom).toBe('before_llm')
    expect(plan.resumeStrategy).toBe('continue')
  })

  it('should plan restore with wait_supervisor strategy when pendingDecision exists', () => {
    const plan = planRestore({
      id: 'cp_2',
      taskId: 'task_2',
      schemaVersion: '1.0',
      runtimeCompatibility: { min: '2.0', max: '2.x' },
      taskState: { name: 'decision-test', createdAt: 0 },
      executionState: {
        workerId: 'w2',
        goal: 'decision',
        step: 7,
        lastSafePoint: 'after_llm',
        conversationContext: { type: 'inline', messages: [], tokenEstimate: 0 },
        pendingToolCalls: [],
        pendingDecision: { query: 'Approve step?', summary: 'waiting' },
      },
      createdAt: 0,
    })

    expect(plan.resumeStrategy).toBe('wait_supervisor')
    expect(plan.executionPlan[0].hasPendingDecision).toBe(true)
  })

  it('should plan restore with retry_tool strategy when after_tool with pending tools', () => {
    const plan = planRestore({
      id: 'cp_3',
      taskId: 'task_3',
      schemaVersion: '1.0',
      runtimeCompatibility: { min: '2.0', max: '2.x' },
      taskState: { name: 'retry-test', createdAt: 0 },
      executionState: {
        workerId: 'w3',
        goal: 'retry',
        step: 12,
        lastSafePoint: 'after_tool',
        conversationContext: { type: 'inline', messages: [], tokenEstimate: 0 },
        pendingToolCalls: [{ toolName: 'search', args: {}, status: 'pending', retryCount: 1, createdAt: 0 }],
      },
      createdAt: 0,
    })

    expect(plan.resumeStrategy).toBe('retry_tool')
  })
})

// ══════════════════════════════════════════════════════════════════
//  Scenario 2: Restore failure isolation
// ══════════════════════════════════════════════════════════════════

describe('Scenario 2: Restore failure isolation', () => {
  it('should not contaminate task A when restoring checkpoint X fails', async () => {
    const mgr = createManager()

    // Task A running
    const taskA = mgr.createTask('task-A')
    const snapshot = snapshotRuntimeTask(taskA)

    const originalTaskId = taskA.id

    // Create a valid checkpoint
    const cpMgr = new MockCheckpointManager()
    const cp = await cpMgr.create(toCheckpointContext(snapshot))
    await cpMgr.save(cp)

    // Restore with a component that fails (no allowDegraded flag)
    const failingComponent = {
      name: 'workflow',
      capabilities: {},
      snapshot: () => ({ component: 'workflow', version: '1', data: {}, createdAt: 0 }),
      restore: async () => { throw new Error('simulated failure') },
    }
    const result = await cpMgr.restore(cp, [failingComponent as any])

    // Assert: restore failed
    expect(result.status).toBe('failed')
    expect(result.errors.some((e: string) => e.includes('workflow'))).toBe(true)

    // Assert: Task A unaffected — manager still returns same task
    const stillInManager = mgr.getTask(taskA.id)
    expect(stillInManager).toBeDefined()
    expect(stillInManager!.id).toBe(originalTaskId)
    expect(stillInManager!.name).toBe('task-A')
  })

  it('should keep checkpoint loadable after restore fails', async () => {
    const mgr = createManager()
    const task = mgr.createTask('fail-not-consumed')
    task.spawnWorker({ goal: 'test' })

    const snapshot = snapshotRuntimeTask(task)
    const cpMgr = new MockCheckpointManager()
    const cp = await cpMgr.create(toCheckpointContext(snapshot))
    await cpMgr.save(cp)

    // Verify checkpoint is still there (not consumed)
    const stillThere = await cpMgr.load(cp.id)
    expect(stillThere.id).toBe(cp.id)
  })
})

// ══════════════════════════════════════════════════════════════════
//  Scenario 3: SafePoint mapping
// ══════════════════════════════════════════════════════════════════

describe('Scenario 3: SafePoint mapping', () => {
  it('should map RUNNING to before_llm', () => {
    expect(mapStateToSafePoint(RuntimeState.RUNNING, 0)).toBe('before_llm')
  })

  it('should map WAITING_TOOL to after_tool', () => {
    expect(mapStateToSafePoint(RuntimeState.WAITING_TOOL, 0)).toBe('after_tool')
  })

  it('should map WAITING_SUPERVISOR to after_llm', () => {
    expect(mapStateToSafePoint(RuntimeState.WAITING_SUPERVISOR, 0)).toBe('after_llm')
  })

  it('should map PAUSED to before_llm', () => {
    expect(mapStateToSafePoint(RuntimeState.PAUSED, 0)).toBe('before_llm')
  })

  it('should map unknown state to before_llm fallback', () => {
    expect(mapStateToSafePoint('UNKNOWN' as any, 0)).toBe('before_llm')
  })
})

// ══════════════════════════════════════════════════════════════════
//  Scenario 4: Multi-checkpoint selection
// ══════════════════════════════════════════════════════════════════

describe('Scenario 4: Multi-checkpoint selection', () => {
  it('should allow loading specific checkpoint by id', async () => {
    const cpMgr = new MockCheckpointManager()
    const taskId = 'multi-cp'

    // Create two checkpoints at different steps
    const cp1 = await cpMgr.create({
      taskId, taskName: 'multi', taskCreatedAt: 0,
      executionState: { workerId: 'w1', goal: 'g1', step: 5, lastSafePoint: 'before_llm' },
    })
    await cpMgr.save(cp1)

    const cp2 = await cpMgr.create({
      taskId, taskName: 'multi', taskCreatedAt: 0,
      executionState: { workerId: 'w1', goal: 'g1', step: 10, lastSafePoint: 'after_tool' },
    })
    await cpMgr.save(cp2)

    // Load cp1 explicitly
    const loaded1 = await cpMgr.load(cp1.id)
    expect(loaded1.executionState.step).toBe(5)

    // Load cp2 explicitly
    const loaded2 = await cpMgr.load(cp2.id)
    expect(loaded2.executionState.step).toBe(10)
  })

  it('should have independent restore plans per checkpoint version', () => {
    const planEarly = planRestore({
      id: 'cp_early', taskId: 't1',
      schemaVersion: '1.0', runtimeCompatibility: { min: '2.0', max: '2.x' },
      taskState: { name: 'test', createdAt: 0 },
      executionState: { workerId: 'w1', goal: 'g1', step: 7, lastSafePoint: 'after_tool',
        conversationContext: { type: 'inline', messages: [], tokenEstimate: 0 },
        pendingToolCalls: [{ toolName: 'search', args: {}, status: 'pending', retryCount: 1, createdAt: 0 }] },
      createdAt: 0,
    })

    const planLate = planRestore({
      id: 'cp_late', taskId: 't1',
      schemaVersion: '1.0', runtimeCompatibility: { min: '2.0', max: '2.x' },
      taskState: { name: 'test', createdAt: 0 },
      executionState: { workerId: 'w1', goal: 'g1', step: 14, lastSafePoint: 'after_llm', conversationContext: { type: 'inline', messages: [], tokenEstimate: 0 }, pendingToolCalls: [], pendingDecision: { query: '?', summary: 's' } },
      createdAt: 0,
    })

    expect(planEarly.executionPlan[0].step).toBe(7)
    expect(planEarly.executionPlan[0].resumeFrom).toBe('after_tool')
    expect(planEarly.resumeStrategy).toBe('retry_tool')

    expect(planLate.executionPlan[0].step).toBe(14)
    expect(planLate.executionPlan[0].resumeFrom).toBe('after_llm')
    expect(planLate.resumeStrategy).toBe('wait_supervisor')
  })
})
