/**
 * ExecutionPolicy Contract Tests — Phase 3A
 *
 * 验证 ExecutionPolicy 作为全局治理门的正确性：
 *   Problem → ExecutionVerdict
 *
 * 不验证：
 *   - PipelineOrchestrator 集成（Phase 3A 不改执行逻辑）
 *   - ProposalValidator 接线（Phase 3B）
 *   - Evidence 接入（Phase 3C）
 *
 * 覆盖场景：
 *   | 场景                              | 期望                         |
 *   | --------------------------------- | ---------------------------- |
 *   | evidence source → Level 0         | 锁定记录                     |
 *   | memory source → Level 0           | 锁定记录                     |
 *   | agent source → Level 0            | 锁定记录                     |
 *   | tsc error → Level 2               | 可执行                       |
 *   | tsc warning → Level 2             | 可执行                       |
 *   | behavior warning → Level 1        | 阻断 + 建议                  |
 *   | feature error → Level 2           | error 提升一级               |
 *   | tool error → Level 2              | error 提升一级               |
 *   | info severity → Level 0           | 降级记录                     |
 *   | evidence error 仍为 Level 0       | 锁定不受 severity 影响       |
 *   | memory error 仍为 Level 0         | 锁定不受 severity 影响       |
 *   | blocks = true for Level 0         | 阻断执行                     |
 *   | blocks = true for Level 1         | 阻断执行                     |
 *   | blocks = false for Level 2        | 放行                         |
 *   | shouldPropose = false for Level 0 | 不生成 Proposal              |
 *   | shouldPropose = true for Level 1  | 生成 Proposal                |
 *   | shouldPropose = false for Level 2 | 不生成 Proposal              |
 */
import { describe, it, expect } from 'vitest'
import { ExecutionPolicy } from '../ExecutionPolicy'
import type { Problem, ProblemSource, Severity } from '../types'

// =============================================================================
// 辅助：快速构造 Problem
// =============================================================================
function makeProblem(
  source: ProblemSource,
  severity: Severity = 'warning',
  overrides?: Partial<Problem>,
): Problem {
  return {
    id: `test:${source}:${Date.now()}`,
    source,
    severity,
    title: `Test problem from ${source}`,
    description: `Test ${severity} problem from ${source}`,
    estimatedCostChars: 100,
    lastSeen: Date.now(),
    occurrenceCount: 1,
    context: { raw: 'test' },
    ...overrides,
  }
}

// =============================================================================
// 1. Level 0：锁定只记录
// =============================================================================
describe('ExecutionPolicy — Level 0', () => {
  const policy = new ExecutionPolicy()

  it('evidence source → Level 0', () => {
    const verdict = policy.evaluate(makeProblem('evidence'))
    expect(verdict.level).toBe('level_0_record')
    expect(verdict.blocks).toBe(true)
    expect(verdict.shouldPropose).toBe(false)
  })

  it('memory source → Level 0', () => {
    const verdict = policy.evaluate(makeProblem('memory'))
    expect(verdict.level).toBe('level_0_record')
  })

  it('agent source → Level 0', () => {
    const verdict = policy.evaluate(makeProblem('agent'))
    expect(verdict.level).toBe('level_0_record')
  })

  it('evidence error 仍为 Level 0（锁定不受 severity 影响）', () => {
    const verdict = policy.evaluate(makeProblem('evidence', 'error'))
    expect(verdict.level).toBe('level_0_record')
  })

  it('memory error 仍为 Level 0（锁定不受 severity 影响）', () => {
    const verdict = policy.evaluate(makeProblem('memory', 'error'))
    expect(verdict.level).toBe('level_0_record')
  })

  it('info severity → Level 0（降级）', () => {
    const verdict = policy.evaluate(makeProblem('tsc', 'info'))
    expect(verdict.level).toBe('level_0_record')
  })
})

// =============================================================================
// 2. Level 1：阻断 + 建议
// =============================================================================
describe('ExecutionPolicy — Level 1', () => {
  const policy = new ExecutionPolicy()

  it('behavior warning → Level 1', () => {
    const verdict = policy.evaluate(makeProblem('behavior'))
    expect(verdict.level).toBe('level_1_propose')
    expect(verdict.blocks).toBe(true)
    expect(verdict.shouldPropose).toBe(true)
  })

  it('feature warning → Level 1', () => {
    const verdict = policy.evaluate(makeProblem('feature'))
    expect(verdict.level).toBe('level_1_propose')
  })

  it('tool warning → Level 1', () => {
    const verdict = policy.evaluate(makeProblem('tool'))
    expect(verdict.level).toBe('level_1_propose')
  })

  it('tts warning → Level 1', () => {
    const verdict = policy.evaluate(makeProblem('tts'))
    expect(verdict.level).toBe('level_1_propose')
  })

  it('cicd warning → Level 1', () => {
    const verdict = policy.evaluate(makeProblem('cicd'))
    expect(verdict.level).toBe('level_1_propose')
  })
})

// =============================================================================
// 3. Level 2：可执行
// =============================================================================
describe('ExecutionPolicy — Level 2', () => {
  const policy = new ExecutionPolicy()

  it('tsc error → Level 2', () => {
    const verdict = policy.evaluate(makeProblem('tsc', 'error'))
    expect(verdict.level).toBe('level_2_execute')
    expect(verdict.blocks).toBe(false)
    expect(verdict.shouldPropose).toBe(false)
  })

  it('tsc warning → Level 2', () => {
    const verdict = policy.evaluate(makeProblem('tsc', 'warning'))
    expect(verdict.level).toBe('level_2_execute')
  })

  it('test warning → Level 2', () => {
    const verdict = policy.evaluate(makeProblem('test'))
    expect(verdict.level).toBe('level_2_execute')
  })

  it('runtime warning → Level 2', () => {
    const verdict = policy.evaluate(makeProblem('runtime'))
    expect(verdict.level).toBe('level_2_execute')
  })

  it('log warning → Level 2', () => {
    const verdict = policy.evaluate(makeProblem('log', 'warning'))
    expect(verdict.level).toBe('level_2_execute')
  })
})

// =============================================================================
// 4. error severity 提升
// =============================================================================
describe('ExecutionPolicy — error 提升', () => {
  const policy = new ExecutionPolicy()

  it('feature error 从 Level 1 提升到 Level 2', () => {
    const verdict = policy.evaluate(makeProblem('feature', 'error'))
    expect(verdict.level).toBe('level_2_execute')
    expect(verdict.blocks).toBe(false)
  })

  it('tool error 从 Level 1 提升到 Level 2', () => {
    const verdict = policy.evaluate(makeProblem('tool', 'error'))
    expect(verdict.level).toBe('level_2_execute')
  })

  it('tsc error 本身已是 Level 2，不提升', () => {
    const verdict = policy.evaluate(makeProblem('tsc', 'error'))
    expect(verdict.level).toBe('level_2_execute')
  })
})

// =============================================================================
// 5. 边界条件
// =============================================================================
describe('ExecutionPolicy — 边界', () => {
  const policy = new ExecutionPolicy()

  it('evaluate 不修改输入 problem', () => {
    const problem = makeProblem('tsc', 'warning')
    const frozen = JSON.stringify(problem)
    policy.evaluate(problem)
    expect(JSON.stringify(problem)).toBe(frozen)
  })

  it('未知 source 默认 Level 1', () => {
    const problem = makeProblem('blog' as ProblemSource, 'warning')
    const verdict = policy.evaluate(problem)
    // blog 在默认映射中为 level_1_propose
    expect(verdict.level).toBe('level_1_propose')
  })

  it('连续调用相同输入产生相同输出（纯函数）', () => {
    const problem = makeProblem('tool', 'warning')
    const a = policy.evaluate(problem)
    const b = policy.evaluate(problem)
    expect(a.level).toBe(b.level)
    expect(a.blocks).toBe(b.blocks)
    expect(a.shouldPropose).toBe(b.shouldPropose)
  })

  it('blocks = true 代表阻断', () => {
    const record = policy.evaluate(makeProblem('evidence'))
    expect(record.blocks).toBe(true)

    const propose = policy.evaluate(makeProblem('behavior'))
    expect(propose.blocks).toBe(true)
  })

  it('blocks = false 代表放行', () => {
    const verdict = policy.evaluate(makeProblem('tsc', 'warning'))
    expect(verdict.blocks).toBe(false)
  })
})
