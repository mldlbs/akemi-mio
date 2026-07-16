import { eventBus, EventBus } from '../core/EventBus'
import { log } from '../logger/Logger'
import { RuntimeState } from './RuntimeState'
import { RUNTIME_EVENT } from './RuntimeMessage'
import type { RuntimeEvent, TaskLifecycleEvent } from './RuntimeMessage'
import type { RuntimeManager } from './RuntimeTask'

// ════════════════════════════════════════════════════════════
// RuntimeValidator — Runtime 持续验证与 RC 阶段判定
//
// 职责：
//   1. 订阅 RuntimeEvent 并收集指标
//   2. 自动判定 RC 阶段（RC-1 → RC-2 → Retirement ready）
//   3. 异常告警（leak / illegal transition / rollback）
//   4. 生成 RC Report
//
// 只读消费者 — 不参与 Runtime 任何决策路径。
// ════════════════════════════════════════════════════════════

export type RcPhase = 'rc-1_shadow' | 'rc-2_default' | 'retirement_ready' | 'production'

export interface RuntimeMetrics {
  // ── Task 生命周期 ──
  tasksCreated: number
  tasksCompleted: number
  tasksFailed: number
  tasksCancelled: number

  // ── Worker 生命周期 ──
  workersCreated: number
  workersCompleted: number
  workersFailed: number

  // ── 异常 ──
  leakedWorkers: number
  illegalTransitions: number

  // ── 旧路径 ──
  legacyTasks: number

  // ── 回退 ──
  rollbackCount: number

  // ── 行为一致性 ──
  behaviorMismatch: number
}

export interface RcReport {
  phase: RcPhase
  metrics: RuntimeMetrics
  blocked: boolean
  blockedReason?: string
  passed: string[]
  failed: string[]
}

// ── RC 退出门槛常量 ──

/** RC-1 阶段需要达到的 Worker 完成数 */
const RC1_MIN_WORKERS = 100
/** RC-2 阶段需要达到的 Worker 完成数 */
const RC2_MIN_WORKERS = 500

const RC1_GATES: { key: keyof RuntimeMetrics; label: string; expect: number }[] = [
  { key: 'leakedWorkers',       label: 'Worker Leak == 0',          expect: 0 },
  { key: 'illegalTransitions',  label: 'Illegal Transitions == 0',  expect: 0 },
  { key: 'rollbackCount',       label: 'Rollback == 0',             expect: 0 },
  { key: 'behaviorMismatch',    label: 'Behavior Mismatch == 0',    expect: 0 },
]

const RC2_GATES: { key: keyof RuntimeMetrics; label: string; expect: number }[] = [
  { key: 'leakedWorkers',       label: 'Worker Leak == 0',          expect: 0 },
  { key: 'illegalTransitions',  label: 'Illegal Transitions == 0',  expect: 0 },
  { key: 'rollbackCount',       label: 'Rollback == 0',             expect: 0 },
  { key: 'legacyTasks',         label: 'Legacy Tasks == 0',         expect: 0 },
]

/** 自动告警条件：任一触发即 block */
const BLOCK_CONDITIONS: { key: keyof RuntimeMetrics; threshold: number; reason: (v: number) => string }[] = [
  { key: 'leakedWorkers',       threshold: 1, reason: (v) => `Worker Leak: ${v}` },
  { key: 'illegalTransitions',  threshold: 1, reason: (v) => `Illegal State Transition: ${v}` },
  { key: 'rollbackCount',       threshold: 1, reason: (v) => `Rollback occurred: ${v}` },
]

/** Marker emitted by old-path code for RuntimeValidator to count legacy tasks */
export const RUNTIME_VALIDATOR_EVENT = 'runtime.validator.event'

export class RuntimeValidator {
  private metrics: RuntimeMetrics = {
    tasksCreated: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
    tasksCancelled: 0,
    workersCreated: 0,
    workersCompleted: 0,
    workersFailed: 0,
    leakedWorkers: 0,
    illegalTransitions: 0,
    legacyTasks: 0,
    rollbackCount: 0,
    behaviorMismatch: 0,
  }

  private phase: RcPhase = 'rc-1_shadow'
  private blocked = false
  private blockedReason?: string
  private disposers: (() => void)[] = []

  /** RuntimeManager 引用，用于查询 task 存活状态 */
  private runtimeManager: RuntimeManager | null = null

  constructor() {}

  /** 启动监听。在 ChatExecutor/RuntimeManager 初始化后调用。 */
  start(rm: RuntimeManager | null): void {
    this.runtimeManager = rm

    // 订阅 RuntimeEvent 通道（Worker 级别事件）
    this.disposers.push(
      eventBus.on(RUNTIME_EVENT as any, (evt: RuntimeEvent) => this.onRuntimeEvent(evt), 'RuntimeValidator'),
    )

    // 订阅 Validator 专用通道（Task 生命周期事件）
    this.disposers.push(
      eventBus.on(RUNTIME_VALIDATOR_EVENT as any, (evt: any) => this.onValidatorEvent(evt), 'RuntimeValidator'),
    )

    // 订阅 TaskLifecycleEvent 通道
    this.disposers.push(
      eventBus.on(RUNTIME_VALIDATOR_EVENT as any, (evt: any) => this.onValidatorEvent(evt), 'RuntimeValidator'),
    )

    log('INFO', 'runtime_validator_started', { phase: this.phase })
  }

  /** 停止监听 */
  stop(): void {
    for (const d of this.disposers) d()
    this.disposers = []
    log('INFO', 'runtime_validator_stopped')
  }

  /** 获取当前指标快照（冻结副本） */
  getMetrics(): RuntimeMetrics {
    return { ...this.metrics }
  }

  /** 获取当前 RC 阶段 */
  getPhase(): RcPhase {
    return this.phase
  }

  /** 获取当前 RC 阶段与门禁状态 */
  getReport(): RcReport {
    const metrics = this.getMetrics()
    const passed: string[] = []
    const failed: string[] = []

    const gates = this.phase === 'rc-1_shadow' ? RC1_GATES : RC2_GATES
    for (const g of gates) {
      const val = metrics[g.key] as number
      if (val === g.expect) passed.push(g.label)
      else failed.push(g.label)
    }

    // 额外数量门槛
    if (this.phase === 'rc-1_shadow') {
      if (metrics.workersCompleted >= RC1_MIN_WORKERS) passed.push(`Completed workers >= ${RC1_MIN_WORKERS}`)
      else failed.push(`Completed workers >= ${RC1_MIN_WORKERS} (currently ${metrics.workersCompleted})`)
    } else if (this.phase === 'rc-2_default') {
      if (metrics.workersCompleted >= RC2_MIN_WORKERS) passed.push(`Completed workers >= ${RC2_MIN_WORKERS}`)
      else failed.push(`Completed workers >= ${RC2_MIN_WORKERS} (currently ${metrics.workersCompleted})`)
    }

    return {
      phase: this.phase,
      metrics,
      blocked: this.blocked,
      blockedReason: this.blockedReason,
      passed,
      failed,
    }
  }

  /** 生成人类可读的 RC Report */
  generateReport(): string {
    const r = this.getReport()
    const lines: string[] = []

    lines.push('Runtime RC Report')
    lines.push('═'.repeat(40))
    lines.push(`Phase: ${r.phase}`)
    if (r.blocked) lines.push(`BLOCKED: ${r.blockedReason}`)
    lines.push('')

    lines.push('Tasks:')
    lines.push(`  Created:   ${r.metrics.tasksCreated}`)
    lines.push(`  Completed: ${r.metrics.tasksCompleted}`)
    lines.push(`  Failed:    ${r.metrics.tasksFailed}`)
    lines.push(`  Cancelled: ${r.metrics.tasksCancelled}`)
    lines.push('')

    lines.push('Workers:')
    lines.push(`  Created:  ${r.metrics.workersCreated}`)
    lines.push(`  Completed: ${r.metrics.workersCompleted}`)
    lines.push(`  Failed:   ${r.metrics.workersFailed}`)
    lines.push('')

    lines.push('Leaks:')
    lines.push(`  Worker: ${r.metrics.leakedWorkers}`)
    lines.push('')

    lines.push('Anomalies:')
    lines.push(`  Illegal Transitions: ${r.metrics.illegalTransitions}`)
    lines.push(`  Behavior Mismatch:   ${r.metrics.behaviorMismatch}`)
    lines.push(`  Rollback:            ${r.metrics.rollbackCount}`)
    lines.push(`  Legacy Tasks:        ${r.metrics.legacyTasks}`)
    lines.push('')

    lines.push('Gates:')
    for (const p of r.passed) lines.push(`  ✅ ${p}`)
    for (const f of r.failed) lines.push(`  ❌ ${f}`)

    if (r.blocked) lines.push(`\n🔴 ${r.blockedReason}`)

    return lines.join('\n')
  }

  // ── 事件处理 ──

  private onRuntimeEvent(evt: RuntimeEvent): void {
    switch (evt.type) {
      case 'agent.progress':
      case 'agent.message':
      case 'agent.tool':
      case 'agent.complete':
      case 'agent.error':
      case 'agent.need_decision':
      case 'agent.log':
        // Worker 级别事件 — 更新 Worker 计数
        break

      case 'agent.state_changed': {
        if (evt.to === 'running' as RuntimeState) {
          this.metrics.workersCreated++
        } else if (evt.to === 'completed' as RuntimeState) {
          this.metrics.workersCompleted++
        } else if (evt.to === 'failed' as RuntimeState) {
          this.metrics.workersFailed++
        }
        break
      }

      case 'agent.illegal_transition': {
        this.metrics.illegalTransitions++
        this.checkBlock('Illegal Transition', `${evt.from} → ${evt.to}`)
        break
      }
    }

    this.checkPhaseAdvance()
  }

  private onValidatorEvent(evt: TaskLifecycleEvent | Record<string, unknown>): void {
    const e = evt as TaskLifecycleEvent & { workerCreated?: number; workerCompleted?: number; workerFailed?: number }
    switch (e.type) {
      case 'task.created':
        this.metrics.tasksCreated++
        break
      case 'task.completed':
        this.metrics.tasksCompleted++
        break
      case 'task.failed':
        this.metrics.tasksFailed++
        break
      case 'task.cancelled':
        this.metrics.tasksCancelled++
        break
    }

    // Worker 子计数
    if (typeof e.workerCreated === 'number') this.metrics.workersCreated += e.workerCreated
    if (typeof e.workerCompleted === 'number') this.metrics.workersCompleted += e.workerCompleted
    if (typeof e.workerFailed === 'number') this.metrics.workersFailed += e.workerFailed
  }

  // ── 外部事件注入（由 ChatExecutor / Adapter 调用） ──

  /** 记录旧路径 task（RUNTIME_ENABLED=0 或 legacy fallback） */
  recordLegacyTask(): void {
    this.metrics.legacyTasks++
    this.checkPhaseAdvance()
  }

  /** 记录行为不一致（collectCompleted 结果不匹配等） */
  recordBehaviorMismatch(detail: string): void {
    this.metrics.behaviorMismatch++
    this.checkBlock('Behavior Mismatch', detail)
  }

  /** 记录回退 */
  recordRollback(reason: string): void {
    this.metrics.rollbackCount++
    this.checkBlock('Rollback', reason)
  }

  // ── 内部判定逻辑 ──

  private checkBlock(title: string, detail: string): void {
    this.blocked = true
    this.blockedReason = `RC BLOCKED\n\nReason: ${title}\n${detail}`
    log('ERROR', 'runtime_validator_blocked', { title, detail })
  }

  private checkPhaseAdvance(): void {
    if (this.blocked) return

    const m = this.metrics

    if (this.phase === 'rc-1_shadow') {
      if (m.workersCompleted < RC1_MIN_WORKERS) return
      for (const g of RC1_GATES) {
        if ((m[g.key] as number) !== g.expect) return
      }
      // 全部通过 → rc-2
      this.phase = 'rc-2_default'
      log('INFO', 'runtime_validator_phase_advance', { from: 'rc-1_shadow', to: 'rc-2_default', workersCompleted: m.workersCompleted })
      return
    }

    if (this.phase === 'rc-2_default') {
      if (m.workersCompleted < RC2_MIN_WORKERS) return
      for (const g of RC2_GATES) {
        if ((m[g.key] as number) !== g.expect) return
      }
      // 全部通过 → retirement ready
      this.phase = 'retirement_ready'
      log('INFO', 'runtime_validator_phase_advance', { from: 'rc-2_default', to: 'retirement_ready', workersCompleted: m.workersCompleted })
      return
    }
  }
}
