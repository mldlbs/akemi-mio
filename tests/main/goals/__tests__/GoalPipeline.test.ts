import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { closeDatabase, initDatabase } from '@akemi-mio/core/db/connection'
import { useIsolatedTestDatabase } from '../../db/__tests__/testDatabase'
import { ExecutionGoalStore } from '@akemi-mio/evolution/goals/ExecutionGoalStore'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import { GoalPipeline, deriveSuccessCriteria } from '@akemi-mio/evolution/goals/GoalPipeline'
import type { ToolCallInfo } from '@akemi-mio/intelligence/llm/LlmService'
import type { ToolResult } from '@akemi-mio/intelligence/agent/ToolScheduler'

describe('GoalPipeline (M6.1)', () => {
  let dispose: () => void
  let pipeline: GoalPipeline
  let store: ExecutionGoalStore

  beforeEach(async () => {
    dispose = useIsolatedTestDatabase()
    await initDatabase()
    store = new ExecutionGoalStore()
    pipeline = new GoalPipeline(store)
  })

  afterEach(() => {
    closeDatabase()
    dispose()
  })

  it('derives deterministic success criteria from user text', () => {
    expect(deriveSuccessCriteria('帮我跑一下测试')).toContain('测试通过')
    expect(deriveSuccessCriteria('修复这个 bug')).toContain('文件修改成功')
    expect(deriveSuccessCriteria('生成一张海报')).toContain('产物生成成功')
    expect(deriveSuccessCriteria('执行构建命令')).toContain('命令执行成功')
    expect(deriveSuccessCriteria('随便聊聊')).toEqual([])
  })

  it('records evidence and completes the goal when criteria are met', () => {
    const goal = pipeline.createGoal({
      sessionId: 's1',
      objective: '修改文件并跑测试',
      successCriteria: ['测试通过', '文件修改成功'],
      planId: null,
    })
    pipeline.markExecuting(goal.id)

    const round = pipeline.recordRound(
      goal.id,
      [{ id: 'c1', name: 'edit_file', arguments: '{}' } as ToolCallInfo],
      [{ id: 'c1', name: 'edit_file', success: true, content: 'done', latencyMs: 1 } as ToolResult],
      0,
    )
    expect(round).not.toBeNull()
    expect(round!.evaluation.verdict).toBe('continue')

    const round2 = pipeline.recordRound(
      goal.id,
      [{ id: 'c2', name: 'run_command', arguments: '{}' } as ToolCallInfo],
      [{ id: 'c2', name: 'run_command', success: true, content: 'Tests passed: 5', latencyMs: 1 } as ToolResult],
      1,
    )
    expect(round2!.evaluation.verdict).toBe('completed')

    const updated = store.get(goal.id)!
    expect(updated.status).toBe('completed')
    expect(updated.completedAt).not.toBeNull()
    expect(updated.evidence).toHaveLength(2)
    expect(updated.currentStep).toBe(1)
  })

  it('blocks the goal when the test gate fails', () => {
    const goal = pipeline.createGoal({ sessionId: 's1', objective: '跑测试', successCriteria: ['测试通过'], planId: null })
    pipeline.markExecuting(goal.id)

    pipeline.recordRound(
      goal.id,
      [{ id: 'c1', name: 'run_command', arguments: '{}' } as ToolCallInfo],
      [{ id: 'c1', name: 'run_command', success: true, content: '2 failures', latencyMs: 1 } as ToolResult],
      0,
    )

    expect(store.get(goal.id)!.status).toBe('blocked')
  })

  it('abandons an unfinished goal, appends evidence, and treats it as terminal', () => {
    const goal = pipeline.createGoal({ sessionId: 's1', objective: '修复 bug', successCriteria: ['测试通过'], planId: null })
    pipeline.markExecuting(goal.id)

    const events: string[] = []
    const disposeEvent = eventBus.on('execution_goal.abandoned', (e) => events.push(`${e.id}:${e.reason}`))
    try {
      expect(pipeline.abandonGoal(goal.id, 'superseded_by_new_request')).toBe(true)

      const updated = store.get(goal.id)!
      expect(updated.status).toBe('abandoned')
      expect(updated.evidence.some((e) => e.type === 'abandoned' && e.value === 'superseded_by_new_request')).toBe(true)
      expect(events).toContain(`${goal.id}:superseded_by_new_request`)

      // 终态不可变
      expect(pipeline.abandonGoal(goal.id, 'again')).toBe(false)
      expect(pipeline.markExecuting(goal.id)).toBe(false)
      expect(store.get(goal.id)!.status).toBe('abandoned')
    } finally {
      disposeEvent()
    }
  })

  it('does not abandon completed or unknown goals', () => {
    const goal = pipeline.createGoal({ sessionId: 's1', objective: '已完成', successCriteria: ['测试通过'], planId: null })
    pipeline.markExecuting(goal.id)
    pipeline.recordRound(
      goal.id,
      [{ id: 'c1', name: 'run_command', arguments: '{}' } as ToolCallInfo],
      [{ id: 'c1', name: 'run_command', success: true, content: 'Tests passed: 5', latencyMs: 1 } as ToolResult],
      0,
    )
    expect(store.get(goal.id)!.status).toBe('completed')
    expect(pipeline.abandonGoal(goal.id, 'too_late')).toBe(false)
    expect(pipeline.abandonGoal('missing', 'x')).toBe(false)
  })

  it('emits lifecycle events on create and completion', () => {
    const events: string[] = []
    const disposeCreated = eventBus.on('execution_goal.created', (e) => events.push(`created:${e.id}`))
    const disposeCompleted = eventBus.on('execution_goal.completed', (e) => events.push(`completed:${e.id}`))
    try {
      const goal = pipeline.createGoal({ sessionId: 's1', objective: '改文件并测试', successCriteria: ['测试通过'], planId: null })
      pipeline.markExecuting(goal.id)
      pipeline.recordRound(
        goal.id,
        [{ id: 'c1', name: 'run_command', arguments: '{}' } as ToolCallInfo],
        [{ id: 'c1', name: 'run_command', success: true, content: 'Tests passed: 5', latencyMs: 1 } as ToolResult],
        0,
      )
      expect(events.some((e) => e.startsWith('created:'))).toBe(true)
      expect(events.some((e) => e.startsWith('completed:'))).toBe(true)
    } finally {
      disposeCreated()
      disposeCompleted()
    }
  })
  it('advances currentStep for read-only tool rounds', () => {
    const goal = pipeline.createGoal({ sessionId: 's1', objective: '??', successCriteria: [], planId: null })
    pipeline.markExecuting(goal.id)

    const round = pipeline.recordRound(
      goal.id,
      [{ id: 'c1', name: 'grep', arguments: '{}' } as ToolCallInfo],
      [{ id: 'c1', name: 'grep', success: true, content: 'hit', latencyMs: 1 } as ToolResult],
      4,
    )

    expect(round).toBeNull()
    expect(store.get(goal.id)!.currentStep).toBe(4)
  })

  it('returns null for read-only rounds and unknown goals', () => {
    const goal = pipeline.createGoal({ sessionId: 's1', objective: '观察', successCriteria: [], planId: null })
    const readOnly = pipeline.recordRound(
      goal.id,
      [{ id: 'c1', name: 'grep', arguments: '{}' } as ToolCallInfo],
      [{ id: 'c1', name: 'grep', success: true, content: 'hit', latencyMs: 1 } as ToolResult],
      0,
    )
    expect(readOnly).toBeNull()
    expect(store.get(goal.id)!.evidence).toEqual([])

    expect(pipeline.recordRound('missing', [], [], 0)).toBeNull()
  })
  it('appends verification evidence and emits event', async () => {
    const goal = pipeline.createGoal({ sessionId: 's1', objective: '跑测试', successCriteria: ['测试通过'], planId: null })
    pipeline.markExecuting(goal.id)
    pipeline.recordRound(
      goal.id,
      [{ id: 'c1', name: 'run_command', arguments: '{}' } as ToolCallInfo],
      [{ id: 'c1', name: 'run_command', success: true, content: 'Tests passed: 5', latencyMs: 1 } as ToolResult],
      0,
    )

    const events: string[] = []
    const disposeEvent = eventBus.on('execution_goal.verified', (e) => events.push(e.verdict))
    try {
      const result = await pipeline.verifyCompletion(goal.id, {
        chatText: async () => ({ reply: '{"verdict":"confirmed","reason":"ok"}' }),
      })
      expect(result?.verdict).toBe('confirmed')
      expect(store.get(goal.id)!.evidence.some((e) => e.type === 'verification')).toBe(true)
      expect(events).toContain('confirmed')
    } finally {
      disposeEvent()
    }
  })
})
