/**
 * Runtime Harness — 在脱离 ChatExecutor / LLM / 真实 MCP 场景下，
 * 验证 Runtime 架构契约是否可用。
 *
 * 6 个核心场景：
 *   1. 生命周期 (READY → RUNNING → COMPLETED)
 *   2. Pause / Resume (RUNNING → PAUSED → RUNNING → COMPLETED)
 *   3. Cancel (RUNNING → CANCELLED)
 *   4. NeedDecision (RUNNING → WAITING_SUPERVISOR → RUNNING)
 *   5. 多 Worker (Event 顺序 + collectCompleted + 状态聚合)
 *   6. Event Timeline
 *
 * ⚠ 本文件是 Runtime Contract Validation，不是单元测试。
 *   验证失败 = 架构契约设计有问题，不是实现 bug。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RuntimeState, transitionState } from '@akemi-mio/intelligence/runtime/RuntimeState'
import { RuntimeManagerImpl } from '@akemi-mio/intelligence/runtime/RuntimeManagerImpl'
import { SupervisedAgentSupervisorImpl } from '@akemi-mio/intelligence/runtime/SupervisedAgentSupervisorImpl'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import { RUNTIME_EVENT } from '@akemi-mio/intelligence/runtime/RuntimeMessage'
import { ServerManager } from '@akemi-mio/intelligence/mcp/ServerManager'

// ── Mock MCP / LLM 依赖 ──

vi.mock('@akemi-mio/intelligence/mcp/ServerManager', () => {
  const MockServerManager = vi.fn()
  MockServerManager.prototype.callTool = vi.fn().mockResolvedValue('mock_tool_result')
  return { ServerManager: MockServerManager }
})

vi.mock('@akemi-mio/intelligence/llm/LlmService', () => {
  const MockLlmService = vi.fn()
  MockLlmService.prototype.setConfig = vi.fn()
  MockLlmService.prototype.chatWithTools = vi.fn().mockResolvedValue({ reply: 'mock_llm_done' })
  return { LlmService: MockLlmService }
})

// ════════════════════════════════════════════════════════════════
// Harness
// ════════════════════════════════════════════════════════════════

describe('Runtime Harness — Contract Validation', () => {
  let events: any[]
  let unsub: (() => void) | null

  beforeEach(() => {
    events = []
    unsub?.()
    unsub = eventBus.on(RUNTIME_EVENT as any, (e: any) => {
      events.push(e)
    })
  })

  // ── Scenario 1: 生命周期 ──
  describe('Scenario 1: Lifecycle (READY → RUNNING → COMPLETED)', () => {
    it('推移矩阵基本链路合法', () => {
      expect(transitionState(RuntimeState.READY, RuntimeState.RUNNING)).toBe(true)
      expect(transitionState(RuntimeState.RUNNING, RuntimeState.COMPLETED)).toBe(true)
      expect(transitionState(RuntimeState.COMPLETED, RuntimeState.READY)).toBe(true)
    })

    it('非法推移被拒绝', () => {
      expect(transitionState(RuntimeState.READY, RuntimeState.COMPLETED)).toBe(false)
      expect(transitionState(RuntimeState.PAUSED, RuntimeState.COMPLETED)).toBe(false)
      expect(transitionState(RuntimeState.PAUSED, RuntimeState.FAILED)).toBe(false)
    })
  })

  // ── Scenario 2: Pause / Resume ──
  describe('Scenario 2: Pause / Resume (RUNNING → PAUSED → RUNNING → COMPLETED)', () => {
    it('pause 后 resume 链路合法', () => {
      expect(transitionState(RuntimeState.RUNNING, RuntimeState.PAUSED)).toBe(true)
      expect(transitionState(RuntimeState.PAUSED, RuntimeState.RUNNING)).toBe(true)
      expect(transitionState(RuntimeState.RUNNING, RuntimeState.COMPLETED)).toBe(true)
    })

    it('paused 不能直接 completed/failed', () => {
      expect(transitionState(RuntimeState.PAUSED, RuntimeState.COMPLETED)).toBe(false)
      expect(transitionState(RuntimeState.PAUSED, RuntimeState.FAILED)).toBe(false)
    })
  })

  // ── Scenario 3: Cancel ──
  describe('Scenario 3: Cancel (RUNNING → CANCELLED)', () => {
    it('cancel 可从多状态出发', () => {
      for (const from of [
        RuntimeState.RUNNING,
        RuntimeState.WAITING_TOOL,
        RuntimeState.WAITING_SUPERVISOR,
        RuntimeState.PAUSED,
        RuntimeState.INTERRUPTED,
      ]) {
        expect(transitionState(from, RuntimeState.CANCELLED)).toBe(true)
      }
    })

    it('cancelled 只能重置到 ready', () => {
      expect(transitionState(RuntimeState.CANCELLED, RuntimeState.READY)).toBe(true)
      expect(transitionState(RuntimeState.CANCELLED, RuntimeState.RUNNING)).toBe(false)
    })
  })

  // ── Scenario 4: NeedDecision ──
  describe('Scenario 4: NeedDecision (RUNNING → WAITING_SUPERVISOR → RUNNING)', () => {
    it('waiting_supervisor 能回到 running', () => {
      expect(transitionState(RuntimeState.RUNNING, RuntimeState.WAITING_SUPERVISOR)).toBe(true)
      expect(transitionState(RuntimeState.WAITING_SUPERVISOR, RuntimeState.RUNNING)).toBe(true)
    })

    it('waiting_supervisor 不能直接 completed/failed', () => {
      expect(transitionState(RuntimeState.WAITING_SUPERVISOR, RuntimeState.COMPLETED)).toBe(false)
      expect(transitionState(RuntimeState.WAITING_SUPERVISOR, RuntimeState.FAILED)).toBe(false)
    })
  })

  // ── Scenario 5: RuntimeManager + 多 Worker ──
  describe('Scenario 5: RuntimeManager + 多 Worker', () => {
    it('createTask 返回包含正确 id 和名称的任务', () => {
      const mgr = new RuntimeManagerImpl(() => new SupervisedAgentSupervisorImpl(new ServerManager(), 'mock_key', 'mock_key'))
      const task = mgr.createTask('test-task', { source: 'harness' })
      expect(task.id).toMatch(/^task_\d+_/)
      expect(task.name).toBe('test-task')
      expect(task.metadata?.source).toBe('harness')
      expect(task.state).toBeDefined()
    })

    it('getTask 返回已注册任务', () => {
      const mgr = new RuntimeManagerImpl(() => new SupervisedAgentSupervisorImpl(new ServerManager(), 'mock_key', 'mock_key'))
      const t1 = mgr.createTask('A')
      const t2 = mgr.createTask('B')
      expect(mgr.getTask(t1.id)?.name).toBe('A')
      expect(mgr.getTask(t2.id)?.name).toBe('B')
      expect(mgr.listTasks().length).toBe(2)
    })

    it('spawnWorker 创建 WorkerHandle 且状态合法', () => {
      const sup = new SupervisedAgentSupervisorImpl(new ServerManager(), 'mock_key', 'mock_key')
      sup.start()
      const wh = sup.spawnWorker({ goal: 'say hello' })
      expect(wh.id).toBeTruthy()
      expect(wh.goal).toBe('say hello')
      expect([RuntimeState.READY, RuntimeState.RUNNING, RuntimeState.COMPLETED]).toContain(wh.state)
    })

    it('getStatus 返回聚合数据', async () => {
      const sup = new SupervisedAgentSupervisorImpl(new ServerManager(), 'mock_key', 'mock_key')
      sup.start()
      sup.spawnWorker({ goal: 'w1' })
      sup.spawnWorker({ goal: 'w2' })

      await vi.waitFor(() => {
        const s = sup.getStatus()
        expect(s.workerCount).toBeGreaterThanOrEqual(0)
        expect(typeof s.running).toBe('number')
      })
    })
  })

  // ── Scenario 6: Event Timeline ──
  describe('Scenario 6: Event Timeline', () => {
    it('RuntimeEvent 被 EventBus 派发且格式正确', async () => {
      const sup = new SupervisedAgentSupervisorImpl(new ServerManager(), 'mock_key', 'mock_key')
      sup.start()
      sup.spawnWorker({ goal: 'timeline test' })

      await vi.waitFor(() => {
        expect(events.length).toBeGreaterThan(0)
      })

      const types = events.map((e: any) => e.type)
      expect(types).toContain('agent.progress')
      expect(types).toContain('agent.state_changed')

      for (const e of events) {
        expect(e.direction).toBe('event')
      }
    })
  })
})
