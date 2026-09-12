/**
 * ExecutionPolicy Contract Tests — Phase 3A / 3C
 *
 * 验证 ExecutionPolicy 作为全局治理门的正确性：
 *   Problem → ExecutionVerdict
 *
 * Phase 3C 变更：
 *   - action 字段为执行路径唯一依据
 *   - Level 2 路径关闭（error severity 不再提升）
 *
 * 覆盖场景：
 *   | 场景                              | 期望                         |
 *   | --------------------------------- | ---------------------------- |
 *   | evidence source → skip            | 治理跳过                     |
 *   | memory source → skip              | 治理跳过                     |
 *   | agent source → skip               | 治理跳过                     |
 *   | tsc warning → execute             | legacy fall-through          |
 *   | behavior warning → block          | 阻断 + 建议                  |
 *   | feature error → block (无提升)    | Phase 3C 冻结 Level 2        |
 *   | info severity → skip              | 降级跳过                     |
 *   | action 优先于 level               | 执行路径只看 action          |
 */
import { describe, it, expect } from 'vitest'
import { ExecutionPolicy } from '@akemi-mio/evolution/automation/ExecutionPolicy'
import type { Problem, ProblemSource, Severity } from '@akemi-mio/evolution/automation/types'

// =============================================================================
// 辅助：快速构造 Problem
// =============================================================================
function makeProblem(source: ProblemSource, severity: Severity = 'warning', overrides?: Partial<Problem>): Problem {
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
// 1. skip: Level 0（治理跳过）
// =============================================================================
describe('ExecutionPolicy — action: skip', () => {
  const policy = new ExecutionPolicy()

  it('evidence source → action=skip', () => {
    const verdict = policy.evaluate(makeProblem('evidence'))
    expect(verdict.action).toBe('skip')
    expect(verdict.level).toBe('level_0_record')
    expect(verdict.blocks).toBe(true)
    expect(verdict.shouldPropose).toBe(false)
  })

  it('memory source → action=skip', () => {
    const verdict = policy.evaluate(makeProblem('memory'))
    expect(verdict.action).toBe('skip')
    expect(verdict.level).toBe('level_0_record')
  })

  it('agent source → action=skip', () => {
    const verdict = policy.evaluate(makeProblem('agent'))
    expect(verdict.action).toBe('skip')
    expect(verdict.level).toBe('level_0_record')
  })

  it('evidence error 仍为 skip（锁定不受 severity 影响）', () => {
    const verdict = policy.evaluate(makeProblem('evidence', 'error'))
    expect(verdict.action).toBe('skip')
    expect(verdict.level).toBe('level_0_record')
  })

  it('memory error 仍为 skip（锁定不受 severity 影响）', () => {
    const verdict = policy.evaluate(makeProblem('memory', 'error'))
    expect(verdict.action).toBe('skip')
    expect(verdict.level).toBe('level_0_record')
  })

  it('info severity → action=skip（降级）', () => {
    const verdict = policy.evaluate(makeProblem('tsc', 'info'))
    expect(verdict.action).toBe('skip')
    expect(verdict.level).toBe('level_0_record')
  })
})

// =============================================================================
// 2. block: Level 1（治理阻断）
// =============================================================================
describe('ExecutionPolicy — action: block', () => {
  const policy = new ExecutionPolicy()

  it('behavior warning → action=block', () => {
    const verdict = policy.evaluate(makeProblem('behavior'))
    expect(verdict.action).toBe('block')
    expect(verdict.level).toBe('level_1_propose')
    expect(verdict.blocks).toBe(true)
    expect(verdict.shouldPropose).toBe(true)
  })

  it('feature warning → action=block', () => {
    const verdict = policy.evaluate(makeProblem('feature'))
    expect(verdict.action).toBe('block')
    expect(verdict.level).toBe('level_1_propose')
  })

  it('tool warning → action=block', () => {
    const verdict = policy.evaluate(makeProblem('tool'))
    expect(verdict.action).toBe('block')
    expect(verdict.level).toBe('level_1_propose')
  })

  it('tts warning → action=block', () => {
    const verdict = policy.evaluate(makeProblem('tts'))
    expect(verdict.action).toBe('block')
    expect(verdict.level).toBe('level_1_propose')
  })

  it('cicd warning → action=block', () => {
    const verdict = policy.evaluate(makeProblem('cicd'))
    expect(verdict.action).toBe('block')
    expect(verdict.level).toBe('level_1_propose')
  })
})

// =============================================================================
// 3. execute: Level 2（legacy fall-through，Phase 3C 保留但冻结）
// =============================================================================
describe('ExecutionPolicy — action: execute', () => {
  const policy = new ExecutionPolicy()

  it('tsc error → action=execute（level=level_2_execute）', () => {
    const verdict = policy.evaluate(makeProblem('tsc', 'error'))
    expect(verdict.action).toBe('execute')
    expect(verdict.level).toBe('level_2_execute')
    expect(verdict.blocks).toBe(false)
    expect(verdict.shouldPropose).toBe(false)
  })

  it('tsc warning → action=execute', () => {
    const verdict = policy.evaluate(makeProblem('tsc', 'warning'))
    expect(verdict.action).toBe('execute')
    expect(verdict.level).toBe('level_2_execute')
  })

  it('test warning → action=execute', () => {
    const verdict = policy.evaluate(makeProblem('test'))
    expect(verdict.action).toBe('execute')
    expect(verdict.level).toBe('level_2_execute')
  })

  it('runtime warning → action=execute', () => {
    const verdict = policy.evaluate(makeProblem('runtime'))
    expect(verdict.action).toBe('execute')
    expect(verdict.level).toBe('level_2_execute')
  })

  it('log warning → action=execute', () => {
    const verdict = policy.evaluate(makeProblem('log', 'warning'))
    expect(verdict.action).toBe('execute')
    expect(verdict.level).toBe('level_2_execute')
  })
})

// =============================================================================
// 4. error severity — Phase 3C 冻结 Level 2，不再提升
// =============================================================================
describe('ExecutionPolicy — error severity (Phase 3C frozen)', () => {
  const policy = new ExecutionPolicy()

  it('feature error → action=block（不再提升到 execute）', () => {
    const verdict = policy.evaluate(makeProblem('feature', 'error'))
    expect(verdict.action).toBe('block')
    expect(verdict.level).toBe('level_1_propose')
    expect(verdict.blocks).toBe(true)
  })

  it('tool error → action=block（不再提升到 execute）', () => {
    const verdict = policy.evaluate(makeProblem('tool', 'error'))
    expect(verdict.action).toBe('block')
    expect(verdict.level).toBe('level_1_propose')
  })

  it('tsc error 仍为 execute（保留 legacy fall-through）', () => {
    const verdict = policy.evaluate(makeProblem('tsc', 'error'))
    expect(verdict.action).toBe('execute')
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
    expect(a.action).toBe(b.action)
    expect(a.level).toBe(b.level)
    expect(a.blocks).toBe(b.blocks)
    expect(a.shouldPropose).toBe(b.shouldPropose)
  })

  it('action 决定 blocks（skip/block = true, execute = false）', () => {
    const record = policy.evaluate(makeProblem('evidence'))
    expect(record.action).toBe('skip')
    expect(record.blocks).toBe(true)

    const propose = policy.evaluate(makeProblem('behavior'))
    expect(propose.action).toBe('block')
    expect(propose.blocks).toBe(true)

    const exec = policy.evaluate(makeProblem('tsc', 'warning'))
    expect(exec.action).toBe('execute')
    expect(exec.blocks).toBe(false)
  })
})
