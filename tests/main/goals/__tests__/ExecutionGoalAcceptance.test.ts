import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { closeDatabase, initDatabase } from '@akemi-mio/core/db/connection'
import { useIsolatedTestDatabase } from '../../db/__tests__/testDatabase'
import { ExecutionGoalStore } from '@akemi-mio/evolution/goals/ExecutionGoalStore'
import { GoalPipeline } from '@akemi-mio/evolution/goals/GoalPipeline'
import type { ToolCallInfo } from '@akemi-mio/intelligence/llm/LlmService'
import type { ToolResult } from '@akemi-mio/intelligence/agent/ToolScheduler'

function call(name: string, id: string): ToolCallInfo {
  return { id, name, arguments: '{}' } as ToolCallInfo
}

function result(name: string, id: string, success: boolean, content = ''): ToolResult {
  return { id, name, success, content, latencyMs: 1 }
}

describe('ExecutionGoal acceptance scenarios (M6.1 dev acceptance)', () => {
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

  it('MCP contract fix: tool_required goal completes when tests pass', () => {
    const goal = pipeline.createGoal({
      sessionId: 's1',
      objective: '修复 MCP contract 测试',
      successCriteria: ['测试通过'],
      planId: null,
    })
    pipeline.markExecuting(goal.id)

    const round = pipeline.recordRound(goal.id, [call('run_command', 'c1')], [result('run_command', 'c1', true, 'Tests passed: 8')], 0)

    expect(round!.evaluation.verdict).toBe('completed')
    expect(store.get(goal.id)!.status).toBe('completed')
    expect(store.get(goal.id)!.completedAt).not.toBeNull()
    expect(store.get(goal.id)!.evidence).toHaveLength(1)
  })

  it('file modification: tool_first goal binds a plan and completes on edit_file', () => {
    const goal = pipeline.createGoal({
      sessionId: 's2',
      objective: '帮我修改项目配置文件',
      successCriteria: ['文件修改成功'],
      planId: 'plan_file_fix',
    })
    pipeline.markExecuting(goal.id)

    expect(store.get(goal.id)!.planId).toBe('plan_file_fix')

    const round = pipeline.recordRound(goal.id, [call('edit_file', 'c1')], [result('edit_file', 'c1', true, 'config updated')], 0)

    expect(round!.evaluation.verdict).toBe('completed')
    expect(store.get(goal.id)!.status).toBe('completed')
  })

  it('browser automation: tool chain converges through command and artifact evidence', () => {
    const goal = pipeline.createGoal({
      sessionId: 's3',
      objective: '浏览器自动化完成操作并导出截图',
      successCriteria: ['命令执行成功', '产物生成成功'],
      planId: null,
    })
    pipeline.markExecuting(goal.id)

    const first = pipeline.recordRound(goal.id, [call('browser_navigate', 'c1')], [result('browser_navigate', 'c1', true, 'navigated')], 0)
    expect(first!.evaluation.verdict).toBe('continue')

    const second = pipeline.recordRound(
      goal.id,
      [call('run_command', 'c2')],
      [result('run_command', 'c2', true, 'screenshot exported to out.png')],
      1,
    )

    expect(second!.evaluation.verdict).toBe('completed')
    expect(store.get(goal.id)!.status).toBe('completed')
    expect(store.get(goal.id)!.evidence.map((e) => e.type)).toEqual(['command_success', 'artifact_created'])
  })
})
