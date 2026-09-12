/**
 * GuardrailPipeline — GuardrailDecision → RuntimeAction 适配器
 *
 * 职责：
 * - 提供 throttle 控制（避免每次 toolLoop 都查询存储）
 * - ADR-004 Option A: 通过 onGuardrailDecision 接收 Consumer 输出的 Decision
 * - 将 GuardrailDecision 映射为 RuntimeAction 供 Runtime 消费
 * - 向 EvaluationEmitter 发送 guardrail.checked / guardrail.terminated
 *
 * ── Architecture Invariants ──
 *
 * ### I-1: Pipeline 生命周期 = 单 Trace
 * GuardrailPipeline 实例的 lifecycle 与单个 Trace 一一对应。
 * 每个新的 Trace 开始前调用 reset()，清空 latestDecision 和 throttle 状态。
 * ChatExecutor 在 toolLoop 入口调用 pipeline.reset()，toolLoop 为单入口不可重入，
 * 因此同一实例在同一时刻只处理一个 Trace。
 * 若未来需要并发多 Trace 支持，必须改为 Map<traceId, Decision> 隔离方案。
 *
 * ### I-2: 单 Trace 最终只有一个有效 Decision（Final Decision Only）
 * onGuardrailDecision 使用单一字段覆盖缓存（latestDecision）。
 * 协议语义为：一个 Trace 最终只有一个有效 GuardrailDecision。
 * 多次 consume 产生多个 Decision 时，最后一次 overwrite 全部前值。
 * Pipeline 不解析 Decision 内容（DI-2），只映射最后一次 Decision 为 RuntimeAction。
 *
 * 若未来协议需支持 Decision Stream（如 WARNING → CONTINUE → TERMINATE），
 * 则单字段缓存模型不适用，需改为 Decision 队列或 Map<stage, Decision>。
 * 届时 Test 7 定义的"覆盖"行为将不成立。
 *
 * 数据流（Step D — 仅 callback 路径）：
 *
 *   ProgressObserver
 *        ↓
 *   GuardrailConsumer
 *        ↓
 *   onGuardrailDecision(decision)
 *        ↓
 *   latestDecision 缓存
 *        ↓
 *   Pipeline.check() → 读取 latestDecision
 *        ↓
 *   toRuntimeAction()
 *        ↓
 *   PipelineResult
 *
 * Runtime 集成方式：
 *   const result = await pipeline.check(traceId, currentTurn)
 *   if (!result) → 跳过
 *   switch (result.runtimeAction):
 *     case 'CONTINUE':  → 不干预
 *     case 'WARNING':   → 仅日志
 *     case 'TERMINATE': → 放行本轮后退出
 *
 * Runtime 不直接读取 Decision。
 * Runtime 只消费 RuntimeAction。
 *
 * 迁移状态：
 *   Step D: 仅 callback 路径。check() 读取 onGuardrailDecision 交付的缓存 Decision。
 *           无可用的 callback Decision 时返回 null（skip）。
 *           兼容层已删除（GuardrailProgressAnalyzer 不再被 Pipeline 引用）。
 *
 * 变更记录：
 *   Step B: 双路径共存（callback + analyzer fallback）
 *   Step C: AppRuntime wiring 完成，Runtime 100% callback 路径
 *   Step D: 删除 analyzer fallback，纯 callback 交付
 */
import type { GuardrailDecision, RuntimeAction } from './GuardrailTypes'
import { toRuntimeAction } from './GuardrailTypes'
import type { GuardrailPolicy } from './GuardrailTypes'
import { DefaultGuardrailPolicy } from './GuardrailPolicy'
import type { EvaluationEmitter } from './EvaluationEmitter'
import type { GuardrailDecisionStore } from './GuardrailDecisionStore'
import { randomUUID } from 'crypto'

export interface GuardrailPipelineConfig {
  /** 每 N 轮检测一次（默认 5） */
  checkIntervalTurns: number
  /** 至少 N 轮后才开始检测（默认 5） */
  minTurnsBeforeCheck: number
}

export interface PipelineResult {
  /** 全局唯一决策实例 ID（Pipeline 生成，用于 Delivery Trace 关联） */
  decisionId: string
  runtimeAction: RuntimeAction
  decision: GuardrailDecision
}

const DEFAULT_PIPELINE_CONFIG: GuardrailPipelineConfig = {
  checkIntervalTurns: 5,
  minTurnsBeforeCheck: 5,
}

export class GuardrailPipeline {
  private policy: GuardrailPolicy
  private config: GuardrailPipelineConfig
  private emitter?: EvaluationEmitter
  private decisionStore?: GuardrailDecisionStore

  /** 上次检测时的总轮次数，用于 throttle。负值确保首次检测不被 throttle */
  private lastCheckedTurn: number = -Infinity

  // ── ADR-004 Option A: Consumer callback delivery ──
  /** 最近一次从 Consumer callback 接收到的 Decision。check() 读取此值。 */
  private latestDecision: GuardrailDecision | null = null
  /** 从 latestDecision 预计算的 RuntimeAction */
  private latestRuntimeAction: RuntimeAction | null = null
  /** 最近一次从 Decision 生成的 decisionId（用于 Delivery Trace 关联） */
  private latestDecisionId: string | null = null

  constructor(
    policy?: GuardrailPolicy,
    config?: Partial<GuardrailPipelineConfig>,
    emitter?: EvaluationEmitter,
    decisionStore?: GuardrailDecisionStore,
  ) {
    this.policy = policy ?? new DefaultGuardrailPolicy()
    this.config = { ...DEFAULT_PIPELINE_CONFIG, ...config }
    this.emitter = emitter
    this.decisionStore = decisionStore
  }

  /**
   * ADR-004 Option A callback。
   * 由 GuardrailConsumer 在 produce Decision 后调用。
   * Pipeline 缓存 Decision 与预计算 RuntimeAction，供 check() 使用。
   */
  onGuardrailDecision(decision: GuardrailDecision): void {
    this.latestDecision = decision
    this.latestRuntimeAction = toRuntimeAction(decision.action)
    this.latestDecisionId = randomUUID()
  }

  /**
   * 检测当前 trace 的进展状态。
   * 返回 null 表示跳过（throttled、turn 不足、或无 callback Decision），
   * 否则返回 PipelineResult。
   *
   * Decision 来源：
   *   唯一来源：Consumer callback（onGuardrailDecision），需 traceId 匹配。
   *
   * decisionId 由 Pipeline 在 check() 时生成，不在 Policy 内生成。
   * 原因：Policy 是纯函数，随机 ID 会破坏确定性。
   */
  async check(traceId: string, currentTurn: number): Promise<PipelineResult | null> {
    if (currentTurn < this.config.minTurnsBeforeCheck) return null
    if (currentTurn - this.lastCheckedTurn < this.config.checkIntervalTurns) return null
    this.lastCheckedTurn = currentTurn

    // 仅 Consumer callback 交付路径
    if (!this.latestDecision || this.latestDecision.traceId !== traceId) return null

    const decisionId = this.latestDecisionId ?? randomUUID()
    const runtimeAction = this.latestRuntimeAction!
    const result: PipelineResult = { decisionId, runtimeAction, decision: this.latestDecision }

    // 持久化 Decision（不阻塞）
    try {
      await this.decisionStore?.record(decisionId, this.latestDecision, runtimeAction, traceId, currentTurn)
    } catch {
      // Decision persistence is best-effort and must not affect the guardrail decision
    }

    // 写入 Evaluation Event（保留 — 见 AOR-001 O-2 Narrowed）
    this.emitGuardrailEvents(traceId, currentTurn, result)

    return result
  }

  private emitGuardrailEvents(traceId: string, currentTurn: number, result: PipelineResult): void {
    if (!this.emitter) return

    // guardrail.checked：每次检测都记录
    this.emitter.emit(
      'guardrail.checked' as any,
      {
        type: 'guardrail.checked',
        turn: currentTurn,
        decision: result.decision.action,
        reason: result.decision.reason,
      },
      { traceId },
    )

    // guardrail.terminated：仅终止时记录。R4-A P0：强制 flush 确保持久化
    if (result.runtimeAction === 'TERMINATE') {
      this.emitter.emit(
        'guardrail.terminated' as any,
        {
          type: 'guardrail.terminated',
          turn: currentTurn,
          totalTurns: result.decision.snapshot.totalTurns,
          reason: result.decision.reason,
        },
        { traceId },
      )
      // R4-A P0: 强制刷入以确保 terminate 事件被持久化（mock 可能无 forceFlush）
      if (typeof (this.emitter as any).forceFlush === 'function') {
        ;(this.emitter as any).forceFlush().catch(() => {})
      }
    }
  }

  /** 重置 throttle 状态（新 trace 开始时调用） */
  reset(): void {
    this.lastCheckedTurn = -Infinity
    this.latestDecision = null
    this.latestRuntimeAction = null
  }
}
