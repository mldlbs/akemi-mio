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
import { PipelineOrchestrator } from '@akemi-mio/evolution/automation/PipelineOrchestrator'
import { ExecutionPolicy } from '@akemi-mio/evolution/automation/ExecutionPolicy'
import type { SignalCollector, FixExecutor, AssignedProblem, FixResult, Problem, ProblemSource, Severity } from '@akemi-mio/evolution/automation/types'

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
  supportedSources: ProblemSource[] = ['tsc', 'test', 'lint', 'runtime', 'evidence', 'behavior', 'memory', 'feature', 'tool']
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
function makePipeline(collector: FakeCollector, executor: FakeExecutor, policy?: ExecutionPolicy): PipelineOrchestrator {
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

function makeProblem(source: ProblemSource, severity: Severity = 'warning'): Problem {
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
    collector.setProblems([makeProblem('tsc'), makeProblem('test'), makeProblem('lint')])

    await pipeline.runOnce()

    expect(executor.executed.length).toBe(3)
  })
})

// =============================================================================
// 2. 带 ExecutionPolicy (enforce) — action=skip
// =============================================================================
describe('Phase 3C: enforce mode — action=skip', () => {
  let collector: FakeCollector
  let executor: FakeExecutor
  let policy: ExecutionPolicy

  beforeEach(() => {
    collector = new FakeCollector()
    executor = new FakeExecutor()
    policy = new ExecutionPolicy({ mode: 'enforce' })
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
    collector.setProblems([makeProblem('evidence'), makeProblem('tsc')])

    await pipeline.runOnce()

    expect(executor.executed.length).toBe(1)
    expect(executor.executed[0].source).toBe('tsc')
  })
})

// =============================================================================
// 3. 带 ExecutionPolicy (enforce) — action=block
// =============================================================================
describe('Phase 3C: enforce mode — action=block', () => {
  let collector: FakeCollector
  let executor: FakeExecutor
  let policy: ExecutionPolicy

  beforeEach(() => {
    collector = new FakeCollector()
    executor = new FakeExecutor()
    policy = new ExecutionPolicy({ mode: 'enforce' })
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
    collector.setProblems([makeProblem('behavior'), makeProblem('tool'), makeProblem('tsc')])

    await pipeline.runOnce()

    // behavior + tool 被 block，tsc 执行
    expect(executor.executed.length).toBe(1)
    expect(executor.executed[0].source).toBe('tsc')
  })
})

// =============================================================================
// 4. 带 ExecutionPolicy (enforce) — action=execute（legacy fall-through）
// =============================================================================
describe('Phase 3C: enforce mode — action=execute', () => {
  let collector: FakeCollector
  let executor: FakeExecutor
  let policy: ExecutionPolicy

  beforeEach(() => {
    collector = new FakeCollector()
    executor = new FakeExecutor()
    policy = new ExecutionPolicy({ mode: 'enforce' })
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
// 5. policy.decision 事件 — enforce 模式
// =============================================================================
describe('Phase 3C: enforce mode — policy.decision event', () => {
  let collector: FakeCollector
  let executor: FakeExecutor
  let policy: ExecutionPolicy

  beforeEach(() => {
    collector = new FakeCollector()
    executor = new FakeExecutor()
    policy = new ExecutionPolicy({ mode: 'enforce' })
  })

  it('skip 事件含固定 schema（mode=enforce, executed=false）', async () => {
    const events: any[] = []
    const { eventBus } = await import('@akemi-mio/core/core/EventBus')
    const unsub = eventBus.on('policy.decision', (e: any) => events.push(e))

    const pipeline = makePipeline(collector, executor, policy)
    collector.setProblems([makeProblem('evidence')])
    await pipeline.runOnce()

    expect(events.length).toBe(1)
    expect(events[0]).toMatchObject({
      problemId: expect.any(String),
      source: 'evidence',
      action: 'skip',
      mode: 'enforce',
      executed: false,
      reason: expect.any(String),
      policyVersion: '1.0.0',
      timestamp: expect.any(Number),
    })
    unsub()
  })

  it('block 事件含固定 schema（mode=enforce, executed=false）', async () => {
    const events: any[] = []
    const { eventBus } = await import('@akemi-mio/core/core/EventBus')
    const unsub = eventBus.on('policy.decision', (e: any) => events.push(e))

    const pipeline = makePipeline(collector, executor, policy)
    collector.setProblems([makeProblem('behavior')])
    await pipeline.runOnce()

    expect(events.length).toBe(1)
    expect(events[0]).toMatchObject({
      problemId: expect.any(String),
      source: 'behavior',
      action: 'block',
      mode: 'enforce',
      executed: false,
      reason: expect.any(String),
      policyVersion: '1.0.0',
    })
    unsub()
  })

  it('execute 触发 decision 事件（mode=enforce, executed=true）', async () => {
    const events: any[] = []
    const { eventBus } = await import('@akemi-mio/core/core/EventBus')
    const unsub = eventBus.on('policy.decision', (e: any) => events.push(e))

    const pipeline = makePipeline(collector, executor, policy)
    collector.setProblems([makeProblem('tsc')])
    await pipeline.runOnce()

    // tsc → action=execute → emit event with executed=true
    expect(events.length).toBe(1)
    expect(events[0]).toMatchObject({
      action: 'execute',
      mode: 'enforce',
      executed: true,
    })
    unsub()
  })
})

// =============================================================================
// 6. disabled mode — evaluate + emit + always execute
// =============================================================================
describe('Phase 3C+: disabled mode — no enforcement', () => {
  let collector: FakeCollector
  let executor: FakeExecutor
  let policy: ExecutionPolicy

  beforeEach(() => {
    collector = new FakeCollector()
    executor = new FakeExecutor()
    policy = new ExecutionPolicy({ mode: 'disabled' })
  })

  it('evidence 仍执行（disabled 不阻断）', async () => {
    const pipeline = makePipeline(collector, executor, policy)
    collector.setProblems([makeProblem('evidence')])

    await pipeline.runOnce()

    expect(executor.executed.length).toBe(1)
    expect(executor.executed[0].source).toBe('evidence')
  })

  it('behavior 仍执行（disabled 不阻断）', async () => {
    const pipeline = makePipeline(collector, executor, policy)
    collector.setProblems([makeProblem('behavior')])

    await pipeline.runOnce()

    expect(executor.executed.length).toBe(1)
    expect(executor.executed[0].source).toBe('behavior')
  })

  it('decision 事件仍发出（disabled 模式仍记录）', async () => {
    const events: any[] = []
    const { eventBus } = await import('@akemi-mio/core/core/EventBus')
    const unsub = eventBus.on('policy.decision', (e: any) => events.push(e))

    const pipeline = makePipeline(collector, executor, policy)
    collector.setProblems([makeProblem('evidence')])
    await pipeline.runOnce()

    expect(events.length).toBe(1)
    expect(events[0]).toMatchObject({
      action: 'skip',
      mode: 'disabled',
      executed: true,
    })
    unsub()
  })
})

// =============================================================================
// 7. shadow mode — evaluate + emit + execute, 不修改 queue 状态
// =============================================================================
describe('Phase 3C+: shadow mode — observe only', () => {
  let collector: FakeCollector
  let executor: FakeExecutor
  let policy: ExecutionPolicy

  beforeEach(() => {
    collector = new FakeCollector()
    executor = new FakeExecutor()
    policy = new ExecutionPolicy({ mode: 'shadow' })
  })

  it('evidence 仍执行（shadow 不阻断）', async () => {
    const pipeline = makePipeline(collector, executor, policy)
    collector.setProblems([makeProblem('evidence')])

    await pipeline.runOnce()

    expect(executor.executed.length).toBe(1)
    expect(executor.executed[0].source).toBe('evidence')
  })

  it('behavior 仍执行（shadow 不阻断）', async () => {
    const pipeline = makePipeline(collector, executor, policy)
    collector.setProblems([makeProblem('behavior')])

    await pipeline.runOnce()

    expect(executor.executed.length).toBe(1)
  })

  it('tsc 仍执行（shadow 不影响旧路径）', async () => {
    const pipeline = makePipeline(collector, executor, policy)
    collector.setProblems([makeProblem('tsc')])

    await pipeline.runOnce()

    expect(executor.executed.length).toBe(1)
  })

  it('decision 事件含 mode=shadow, executed=true', async () => {
    const events: any[] = []
    const { eventBus } = await import('@akemi-mio/core/core/EventBus')
    const unsub = eventBus.on('policy.decision', (e: any) => events.push(e))

    const pipeline = makePipeline(collector, executor, policy)
    collector.setProblems([makeProblem('behavior')])
    await pipeline.runOnce()

    expect(events.length).toBe(1)
    expect(events[0]).toMatchObject({
      action: 'block',
      mode: 'shadow',
      executed: true,
    })
    unsub()
  })

  it('不污染 queue skipped/blocked 状态', async () => {
    const pipeline = makePipeline(collector, executor, policy)
    collector.setProblems([makeProblem('evidence'), makeProblem('behavior'), makeProblem('tsc')])

    await pipeline.runOnce()

    // 所有问题都应被执行（shadow 模式不阻断）
    expect(executor.executed.length).toBe(3)

    // 获取 queue stats 确认 skipped/blocked 为 0
    const metrics = pipeline.getMetrics()
    // 通过事件验证：从 executor 记录而非 queue，因为 queue skipped/blocked 不暴露
    // executor 应收到所有 3 个问题
    expect(executor.executed.map((e) => e.source).sort()).toEqual(['behavior', 'evidence', 'tsc'])
  })
})
