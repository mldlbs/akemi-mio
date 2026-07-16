/**
 * ReplayRunner — 自动化 Replay 场景并验证 Runtime 指标。
 *
 * 架构：
 *   Scenario → ReplayRunner → RuntimeManager → Supervisor → Worker
 *                                       ↓
 *                                RuntimeValidator
 *                                       ↓
 *                                   RC Report
 *
 * 用途：
 *   - RC 阶段自动验证（100/500 Task 门槛）
 *   - CI 回归测试
 *   - 稳定性测试（Monkey 随机对话）
 *   - Bug Regression Replay
 *
 * 设计原则：
 *   - 不管理 RuntimeManager 生命周期（由外部注入）
 *   - 不依赖 LLM / MCP / Electron
 *   - 只做：执行步骤 → 等待完成 → 校验指标
 */

import type { RuntimeManagerImpl } from './RuntimeManagerImpl'
import type { RuntimeValidator, RcReport } from './RuntimeValidator'
import type { RuntimeMetrics } from './RuntimeValidator'

export type { RcReport, RuntimeMetrics }

// ── 类型定义 ──

export interface SpawnConfig {
  goal: string
  maxTurns?: number
}

export interface ReplayStep {
  /** 在本步骤派发的一组 Worker（在同一 Task 下） */
  spawn?: SpawnConfig[]
  /** 等待所有 Worker 完成后继续 */
  wait?: boolean
  /** 验证当前指标快照 */
  expect?: Partial<RuntimeMetrics> & { phase?: string }
  /** 等待 N 毫秒 */
  sleep?: number
}

export interface ReplayScenario {
  name: string
  description?: string
  steps: ReplayStep[]
}

// ── 标准场景库 ──

export const SCENARIO_SINGLE_TASK: ReplayScenario = {
  name: 'single-task',
  description: '1 Worker → COMPLETED，基础生命周期',
  steps: [
    { spawn: [{ goal: 'single task test' }], wait: true },
    { expect: { leakedWorkers: 0, illegalTransitions: 0 } },
  ],
}

export const SCENARIO_PARALLEL_5: ReplayScenario = {
  name: 'parallel-5',
  description: '5 个并行 Worker',
  steps: [
    {
      spawn: Array.from({ length: 5 }, (_, i) => ({ goal: `parallel worker ${i}`, maxTurns: 1 })),
      wait: true,
    },
    { expect: { leakedWorkers: 0 } },
  ],
}

export const SCENARIO_PARALLEL_10: ReplayScenario = {
  name: 'parallel-10',
  description: '10 个并行 Worker',
  steps: [
    {
      spawn: Array.from({ length: 10 }, (_, i) => ({ goal: `parallel worker ${i}`, maxTurns: 1 })),
      wait: true,
    },
    { expect: { workersCompleted: 10, leakedWorkers: 0 } },
  ],
}

// ── Monkey 场景生成 ──

const MONKEY_GOALS = [
  'search for recent news',
  'write a haiku about code',
  'explain recursion simply',
  'compare React and Vue',
  'summarize this paragraph',
  'list best practices for testing',
  'write a git commit message',
  'debug why array.map returns undefined',
  'describe how HTTP works',
  'explain what REST means',
]

/** 生成 N 个随机 Worker 的 Monkey 场景 */
export function generateMonkeyScenario(count: number, label = 'monkey'): ReplayScenario {
  return {
    name: label,
    description: `${count} 个随机 Worker（Monkey Test）`,
    steps: [
      {
        spawn: Array.from({ length: count }, (_, i) => ({
          goal: MONKEY_GOALS[i % MONKEY_GOALS.length],
          maxTurns: 1,
        })),
        wait: true,
      },
      { expect: { workersCompleted: count, leakedWorkers: 0, illegalTransitions: 0 } },
    ],
  }
}

// ── ReplayRunner ──

export class ReplayRunner {
  constructor(
    private mgr: RuntimeManagerImpl,
    private validator: RuntimeValidator,
  ) {}

  /** 运行单个 Scenario */
  async runScenario(scenario: ReplayScenario): Promise<RcReport> {
    for (const step of scenario.steps) {
      if (step.sleep) {
        await this.sleep(step.sleep)
      }
      if (step.spawn && step.spawn.length > 0) {
        const task = this.mgr.createTask(scenario.name)
        for (const w of step.spawn) {
          task.spawnWorker({
            goal: w.goal,
            maxTurns: w.maxTurns ?? 1,
          })
        }
      }
      if (step.wait) {
        await this.waitForIdle(15000)
      }
      if (step.expect) {
        const report = this.validator.getReport()
        const err = this.checkExpect(step.expect, report)
        if (err) {
          console.error(`[ReplayRunner] ❌ [${scenario.name}] ${err}`)
          console.error(report.metrics)
          throw new Error(`[${scenario.name}] ${err}`)
        }
      }
    }
    return this.validator.getReport()
  }

  /** 快速运行 N 个独立 Worker（每个单独一个 Task） */
  async runMany(count: number, label = 'auto'): Promise<RcReport> {
    for (let i = 0; i < count; i++) {
      const task = this.mgr.createTask(`${label}-${i}`)
      task.spawnWorker({ goal: `${label} task ${i}`, maxTurns: 1 })
    }
    await this.waitForIdle(30000)
    return this.validator.getReport()
  }

  /** 批量运行多个 Scenario */
  async runSuite(scenarios: ReplayScenario[]): Promise<RcReport> {
    for (const s of scenarios) {
      await this.runScenario(s)
    }
    return this.validator.getReport()
  }

  /** 持续运行直到满足 RC 退出条件 */
  async runUntilPhase(targetPhase: string, batchSize = 10, maxBatches = 200): Promise<RcReport> {
    for (let b = 0; b < maxBatches; b++) {
      const report = this.validator.getReport()
      if (report.phase === targetPhase) return report
      if (report.blocked) return report

      await this.runMany(batchSize, `rc-progress-${b}`)

      // 每 5 个 batch 输出一次进度
      if ((b + 1) % 5 === 0) {
        const m = this.validator.getMetrics()
        console.log(`[ReplayRunner] batch ${b + 1}/${maxBatches} — tasks: ${m.tasksCreated}, workers: ${m.workersCreated}, phase: ${report.phase}`)
      }
    }
    throw new Error(`runUntilPhase: did not reach ${targetPhase} after ${maxBatches * batchSize} workers`)
  }

  // ── 内部方法 ──

  private async waitForIdle(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const allIdle = this.mgr.listTasks().every((t) => {
        const s = t.getStatus()
        if (s.workerCount === 0) return true
        return s.completed + s.failed >= s.workerCount
      })
      if (allIdle) return
      await this.sleep(20)
    }
    // 超时不抛 — 让 caller 的 expect 来发现问题
    console.warn('[ReplayRunner] waitForIdle timeout — workers may still be running')
  }

  private checkExpect(expect: Record<string, unknown>, report: RcReport): string | null {
    const m = report.metrics as Record<string, unknown>
    for (const [key, val] of Object.entries(expect)) {
      if (key === 'phase') {
        if (report.phase !== val) return `phase: expected ${val}, got ${report.phase}`
        continue
      }
      const actual = m[key]
      if (actual !== val) return `${key}: expected ${val}, got ${actual}`
    }
    return null
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }
}
