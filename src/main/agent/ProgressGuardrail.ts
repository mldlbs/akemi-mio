/**
 * Progress Guardrail — 检测 toolLoop 进度停滞（Zero-Output Creep）
 *
 * 核心场景：
 * LLM 连续多轮只生成工具调用而不产生文本回复，
 * 每轮徒增 ~350 tokens 上下文但无实质进展。
 *
 * 触发条件：连续 3 轮 LLM 无文本输出且仅产生工具调用
 * 触发动作：注入终止提示 + 设置 guardrailStop，下一轮 LLM 回复后退出
 *
 * 与 Guardrail 类的区别：
 * - Guardrail：基于单轮内容的模式匹配（只读卡死、工具错误等）
 * - ProgressGuardrail：跨轮检测，关注"是否有有效输出推进对话"
 */

import { log } from '../logger/Logger'
import { eventBus } from '../core/EventBus'
import type { ToolResult } from './ToolScheduler'
import type { ToolCallInfo } from '../llm/LlmService'
import type { Message } from './context'
import type { RunContext } from './runstate'

export interface ProgressGuardrailResult {
  triggered: boolean
  reason?: string
}

export class ProgressGuardrail {
  /** 连续无文本回复轮次计数 */
  private stagnantRounds = 0

  /**
   * 检查本轮 tool batch 执行后是否满足停滞阈值。
   * 应在工具结果已推入 messages、Guardrail.apply 执行完毕后调用。
   */
  check(
    llmReply: string | undefined,
    toolCalls: ToolCallInfo[],
    toolResults: ToolResult[] | undefined,
    messages: Message[],
    ctx: RunContext,
  ): ProgressGuardrailResult {
    if (ctx.guardrailStop) return { triggered: false }

    const hasTextReply = !!llmReply && llmReply.trim().length > 0
    const hasToolCalls = toolCalls && toolCalls.length > 0

    // 停滞判定：LLM 未产生文本回复、仅产生工具调用
    if (!hasTextReply && hasToolCalls) {
      this.stagnantRounds++
      log('WARN', 'progress_guardrail_stagnant_round', {
        step: ctx.step,
        consecutive: this.stagnantRounds,
        toolCount: toolCalls.length,
        successCount: toolResults?.filter((r) => r.success).length ?? 0,
      })

      if (this.stagnantRounds >= 3) {
        log('WARN', 'progress_guardrail_triggered', {
          step: ctx.step,
          consecutiveRounds: this.stagnantRounds,
        })
        eventBus.emit('guardrail.progress_stagnation' as any, {
          consecutiveRounds: this.stagnantRounds,
          step: ctx.step,
        })
        messages.push({
          role: 'user',
          content:
            `【Progress Guardrail】已连续 ${this.stagnantRounds} 轮仅生成工具调用而未产生文本回复，判定为进度停滞。` +
            `请立即总结当前已获取的信息并给出最终答复，不要再调用任何工具。`,
        })
        ctx.guardrailStop = true
        return { triggered: true, reason: `连续 ${this.stagnantRounds} 轮无文本输出` }
      }
    } else {
      // 有文本回复 → 进度正常，重置计数器
      if (this.stagnantRounds > 0) {
        log('INFO', 'progress_guardrail_recovered', {
          step: ctx.step,
          previousStagnantRounds: this.stagnantRounds,
        })
      }
      this.stagnantRounds = 0
    }

    return { triggered: false }
  }

  /** 重置计数器（新请求 / interrupt 时调用） */
  reset(): void {
    this.stagnantRounds = 0
  }
}
