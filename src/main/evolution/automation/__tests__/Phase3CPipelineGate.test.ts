/**
 * Phase 3C Contract Tests — PipelineOrchestrator × ExecutionPolicy Gate
 *
 * 验证 ExecutionPolicy 插入 PipelineOrchestrator.runOnce() 的正确性：
 *   pop() → evaluate() → route by action
 *
 * 覆盖：
 *   | 场景                                      | 期望                                |
 *   | ----------------------------------------- | ----------------------------------- |
 *   | 无 ExecutionPolicy 时，旧行为不变          | tryFix 正常执行                     |
 *   | evidence source → action=skip             | queue.skip(), 不调用 executor       |
 *   | behavior source → action=block            | queue.block(), 不调用 executor      |
 *   | tsc source → action=execute               | fall-through 到 tryFix()           |
 *   | skip/block 不进入 completed/failed         | 独立 tracking set                  |
 *   | policy.decision 事件含固定 schema          | eventBus 发出                       |
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PipelineOrchestrator } from '../PipelineOrchestrator'
import { ExecutionPolicy } from '../ExecutionPolicy'
import type { SignalCollector, FixExecutor, AssignedProblem, FixResult, Problem, ProblemSource, Severity } from '../types'

// =============================================================================
// Fake: deterministic collector + executor
// =============================================================================
class FakeCollector implements SignalCollector {
  readonly name = 'fake'
  readonly source: ProblemSource = 'tsc'
  private problems: Problem[] = []

  setProblems(p: Problem[]): void {
    this.problems = p
  }

  shouldRun(): boolean {
    return true
  }

  async collect(): Promise<Problem[]> {
    return this.problems
  }
}

class FakeExecutor implements FixExecutor {
  readonly name = 'fake-exec'
  supportedSources: ProblemSource[] = ['tsc', 'test', 'lint', 'runtime']
  timeoutMs = 5000
  private _available = true
  public executed: AssignedProblem[] = []

  setAvailable(v: boolean): void {
    this._available = v
  }

  isAvailable(): boolean {
    return this._available
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    this.executed.push(problem)
    return { problemId: problem.id, success: true, summary: 'fake fix', durationMs: 0 }
  }
}

// =============================================================================
// Helper: build pipeline with controlled collector
// =============================================================================
function makePipeline(
  collector: FakeCollector,
  executor: FakeExecutor,
  policy?: ExecutionPolicy,
): PipelineOrchestrator {
  const tmpDir = process.env.TEMP || '/tmp'
  const pipeline = new PipelineOrchestrator({
    projectRoot: process.cwd(),
    persistDir: tmpDir,
    maxFixesPerCycle: 3,
  })
  pipeline.addCollector(collector)
  pipeline.addExecutor(executor)
  if (policy) {
    pipeline.setExecutionPolicy(policy)
  }
  return pipeline
}

function makeProblem(
  source: ProblemSource,
  severity: Severity = 'warning',
): Problem {
  return {
    id: `p3c:${source}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
    source,
    severity,
    title: `Test ${source} problem`,
    description: `Phase 3C test for ${source}`,
    estimatedCostChars: 100,
    lastSeen: Date.now(),
    occurrenceCount: 1,
    context: { raw: 'phase3c test' },
  }
}

// =============================================================================
// 1. 无 ExecutionPolicy — 旧行为不变
// =============================================================================
describe('Phase 3C: 无 ExecutionPolicy', () => {
  let collector: FakeCollector
  let executor: FakeExecutor

  beforeEach(() => {
    collector = new FakeCollector()
    executor = new FakeExecutor()
  })

  it('tsc 问题正常进入 executor', async () => {
    const pipeline = makePipeline(collector, executor)
    collector.setProblems([makeProblem('tsc')])

    await pipeline.runOnce()

    expect(executor.executed.length).toBe(1)
    expect(executor.executed[0].source).toBe('tsc')
  })

  it('多个问题依次执行', async () => {
    const pipeline = makePipeline(collector, executor)
    collector.setProblems([
      makeProblem('tsc'),
      makeProblem('test'),
      makeProblem('lint'),
    ])

    await pipeline.runOnce()

    expect(executor.executed.length).toBe(3)
  })
})

// =============================================================================
// 2. 带 ExecutionPolicy — action=skip
// =============================================================================
describe('Phase 3C: action=skip', () => {
  let collector: FakeCollector
  let executor: FakeExecutor
  let policy: ExecutionPolicy

  beforeEach(() => {
    collector = new FakeCollector()
    executor = new FakeExecutor()
    policy = new ExecutionPolicy()
  })

  it('evidence source → 不调用 executor', async () => {
    const pipeline = makePipeline(collector, executor, policy)
    collector.setProblems([makeProblem('evidence')])

    await pipeline.runOnce()

    expect(executor.executed.length).toBe(0)
  })

  it('memory source → 不调用 executor', async () => {
    const pipeline = makePipeline(collector, executor, policy)
    collector.setProblems([makeProblem('memory')])

    await pipeline.runOnce()

    expect(executor.executed.length).toBe(0)
  })

  it('skip 与 execute 混合：只执行 tsc，跳过 evidence', async () => {
    const pipeline = makePipeline(collector, executor, policy)
    collector.setProblems([
      makeProblem('evidence'),
      makeProblem('tsc'),
    ])

    await pipeline.runOnce()

    expect(executor.executed.length).toBe(1)
    expect(executor.executed[0].source).toBe('tsc')
  })
})

// =============================================================================
// 3. 带 ExecutionPolicy — action=block
// =============================================================================
describe('Phase 3C: action=block', () => {
  let collector: FakeCollector
  let executor: FakeExecutor
  let policy: ExecutionPolicy

  beforeEach(() => {
    collector = new FakeCollector()
    executor = new FakeExecutor()
    policy = new ExecutionPolicy()
  })

  it('behavior source → 不调用 executor', async () => {
    const pipeline = makePipeline(collector, executor, policy)
    collector.setProblems([makeProblem('behavior')])

    await pipeline.runOnce()

    expect(executor.executed.length).toBe(0)
  })

  it('feature source → 不调用 executor', async () => {
    const pipeline = makePipeline(collector, executor, policy)
    collector.setProblems([makeProblem('feature')])

    await pipeline.runOnce()

    expect(executor.executed.length).toBe(0)
  })

  it('block 不影响其他 source 执行', async () => {
    const pipeline = makePipeline(collector, executor, policy)
    collector.setProblems([
      makeProblem('behavior'),
      makeProblem('tool'),
      makeProblem('tsc'),
    ])

    await pipeline.runOnce()

    // behavior + tool 被 block，tsc 执行
    expect(executor.executed.length).toBe(1)
    expect(executor.executed[0].source).toBe('tsc')
  })
})

// =============================================================================
// 4. 带 ExecutionPolicy — action=execute（legacy fall-through）
// =============================================================================
describe('Phase 3C: action=execute', () => {
  let collector: FakeCollector
  let executor: FakeExecutor
  let policy: ExecutionPolicy

  beforeEach(() => {
    collector = new FakeCollector()
    executor = new FakeExecutor()
    policy = new ExecutionPolicy()
  })

  it('tsc source 正常执行（legacy fall-through）', async () => {
    const pipeline = makePipeline(collector, executor, policy)
    collector.setProblems([makeProblem('tsc')])

    await pipeline.runOnce()

    expect(executor.executed.length).toBe(1)
    expect(executor.executed[0].source).toBe('tsc')
  })

  it('test source 正常执行', async () => {
    const pipeline = makePipeline(collector, executor, policy)
    collector.setProblems([makeProblem('test')])

    await pipeline.runOnce()

    expect(executor.executed.length).toBe(1)
    expect(executor.executed[0].source).toBe('test')
  })

  it('runtime source 正常执行', async () => {
    const pipeline = makePipeline(collector, executor, policy)
    collector.setProblems([makeProblem('runtime')])

    await pipeline.runOnce()

    expect(executor.executed.length).toBe(1)
    expect(executor.executed[0].source).toBe('runtime')
  })
})

// =============================================================================
// 5. policy.decision 事件
// =============================================================================
describe('Phase 3C: policy.decision event', () => {
  let collector: FakeCollector
  let executor: FakeExecutor
  let policy: ExecutionPolicy

  beforeEach(() => {
    collector = new FakeCollector()
    executor = new FakeExecutor()
    policy = new ExecutionPolicy()
  })

  it('skip 事件含固定 schema', async () => {
    const events: any[] = []
    const { eventBus } = await import('../../../core/EventBus')
    const unsub = eventBus.on('policy.decision', (e: any) => events.push(e))

    const pipeline = makePipeline(collector, executor, policy)
    collector.setProblems([makeProblem('evidence')])
    await pipeline.runOnce()

    expect(events.length).toBe(1)
    expect(events[0]).toMatchObject({
      problemId: expect.any(String),
      source: 'evidence',
      action: 'skip',
      reason: expect.any(String),
      policyVersion: '1.0.0',
      timestamp: expect.any(Number),
    })
    unsub()
  })

  it('block 事件含固定 schema', async () => {
    const events: any[] = []
    const { eventBus } = await import('../../../core/EventBus')
    const unsub = eventBus.on('policy.decision', (e: any) => events.push(e))

    const pipeline = makePipeline(collector, executor, policy)
    collector.setProblems([makeProblem('behavior')])
    await pipeline.runOnce()

    expect(events.length).toBe(1)
    expect(events[0]).toMatchObject({
      problemId: expect.any(String),
      source: 'behavior',
      action: 'block',
      reason: expect.any(String),
      policyVersion: '1.0.0',
    })
    unsub()
  })

  it('execute 不触发 decision 事件', async () => {
    const events: any[] = []
    const { eventBus } = await import('../../../core/EventBus')
    const unsub = eventBus.on('policy.decision', (e: any) => events.push(e))

    const pipeline = makePipeline(collector, executor, policy)
    collector.setProblems([makeProblem('tsc')])
    await pipeline.runOnce()

    // tsc → action=execute → no event
    expect(events.length).toBe(0)
    unsub()
  })
})
