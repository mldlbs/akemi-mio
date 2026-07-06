/**
 * GuardrailPipeline — ProgressAnalyzer + GuardrailPolicy 的适配器
 *
 * 职责：
 * - 连接 ProgressAnalyzer 和 GuardrailPolicy
 * - 提供 throttle 控制（避免每次 toolLoop 都查询存储）
 * - 将 GuardrailDecision 映射为 RuntimeAction 供 Runtime 消费
 * - 向 EvaluationEmitter 发送 guardrail.checked / guardrail.terminated
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
 */

import type { GuardrailDecision, TraceEventSource, RuntimeAction } from './GuardrailTypes'
import { toRuntimeAction } from './GuardrailTypes'
import { GuardrailProgressAnalyzer } from './GuardrailProgressAnalyzer'
import type { GuardrailPolicy } from './GuardrailTypes'
import { DefaultGuardrailPolicy } from './GuardrailPolicy'
import type { EvaluationEmitter } from './EvaluationEmitter'

export interface GuardrailPipelineConfig {
  /** 每 N 轮检测一次（默认 5） */
  checkIntervalTurns: number
  /** 至少 N 轮后才开始检测（默认 5） */
  minTurnsBeforeCheck: number
}

export interface PipelineResult {
  runtimeAction: RuntimeAction
  decision: GuardrailDecision
}

const DEFAULT_PIPELINE_CONFIG: GuardrailPipelineConfig = {
  checkIntervalTurns: 5,
  minTurnsBeforeCheck: 5,
}

export class GuardrailPipeline {
  private analyzer: GuardrailProgressAnalyzer
  private policy: GuardrailPolicy
  private config: GuardrailPipelineConfig
  private emitter?: EvaluationEmitter

  /** 上次检测时的总轮次数，用于 throttle。负值确保首次检测不被 throttle */
  private lastCheckedTurn: number = -Infinity

  constructor(source: TraceEventSource, policy?: GuardrailPolicy, config?: Partial<GuardrailPipelineConfig>, emitter?: EvaluationEmitter) {
    this.analyzer = new GuardrailProgressAnalyzer(source)
    this.policy = policy ?? new DefaultGuardrailPolicy()
    this.config = { ...DEFAULT_PIPELINE_CONFIG, ...config }
    this.emitter = emitter
  }

  /**
   * 检测当前 trace 的进展状态。
   * 返回 null 表示跳过（throttled 或 turn 不足），否则返回 PipelineResult。
   */
  async check(traceId: string, currentTurn: number): Promise<PipelineResult | null> {
    if (currentTurn < this.config.minTurnsBeforeCheck) return null
    if (currentTurn - this.lastCheckedTurn < this.config.checkIntervalTurns) return null
    this.lastCheckedTurn = currentTurn

    let decision: GuardrailDecision
    try {
      const snapshot = await this.analyzer.analyze(traceId)
      decision = this.policy.evaluate(snapshot)
    } catch (err) {
      console.error('[GuardrailPipeline] analyze error:', err)
      return null
    }

    const runtimeAction = toRuntimeAction(decision.action)
    const result: PipelineResult = { runtimeAction, decision }

    // 写入 Evaluation Event（不可逆事实）
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

    // guardrail.terminated：仅终止时记录
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
    }
  }

  /** 重置 throttle 状态（新 trace 开始时调用） */
  reset(): void {
    this.lastCheckedTurn = -Infinity
  }
}
