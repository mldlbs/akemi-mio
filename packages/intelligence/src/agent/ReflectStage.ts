/**
 * ReflectStage — OTPAR Reflect 阶段（同步、行内）
 *
 * 在工具执行结果推入 messages[] 后、Guardrail 之前运行。
 * 与 ReflectLoop（fire-and-forget setTimeout）互补：
 * - ReflectStage: 同步，同一 toolLoop 轮次可见
 * - ReflectLoop: 异步，跨对话持久化到 EngineeringMemory
 *
 * 纯本地逻辑，无额外 LLM 调用。
 */

import type { ToolResult } from './ToolScheduler'
import type { ToolCallInfo } from '@akemi-mio/intelligence/llm/LlmService'
import type { Message } from './context'
import type { RunContext } from './runstate'
import { eventBus } from '@akemi-mio/core/core/EventBus'

export interface ReflectResult {
  injected: boolean
  summary: string
}

export function runReflect(toolResults: ToolResult[], toolCalls: ToolCallInfo[], messages: Message[], ctx: RunContext): ReflectResult {
  // Fast path: no results
  if (!toolResults?.length) {
    return { injected: false, summary: '' }
  }

  const t0 = Date.now()
  const successCount = toolResults.filter((r) => r.success).length
  const failCount = toolResults.length - successCount

  // Skip injection when everything succeeded and batch is small
  if (failCount === 0 && toolResults.length <= 3) {
    eventBus.emit('agent.reflect', {
      requestId: ctx.runId,
      step: ctx.step,
      toolResults: toolResults.length,
      successCount,
      summary: '(skipped -- all ok)',
      durationMs: Date.now() - t0,
    })
    return { injected: false, summary: '' }
  }

  const summary = buildReflectionSummary(toolResults, successCount, failCount)
  messages.push({ role: 'user', content: summary })

  eventBus.emit('agent.reflect', {
    requestId: ctx.runId,
    step: ctx.step,
    toolResults: toolResults.length,
    successCount,
    summary,
    durationMs: Date.now() - t0,
  })

  return { injected: true, summary }
}

function buildReflectionSummary(toolResults: ToolResult[], successCount: number, failCount: number): string {
  const parts: string[] = ['【执行反馈】']
  const total = toolResults.length

  if (failCount > 0) {
    parts.push(`已完成 ${total} 个工具调用：${successCount} 成功，${failCount} 失败。`)
    for (const r of toolResults) {
      if (!r.success) {
        const errTrunc = (r.error || '').slice(0, 120)
        parts.push(`- ❌ ${r.name}: ${errTrunc}`)
      }
    }
  } else {
    parts.push(`全部 ${total} 个工具调用成功完成。`)
  }

  for (const r of toolResults) {
    if (r.success && r.latencyMs > 5000) {
      parts.push(`- ⏱ ${r.name} 耗时 ${r.latencyMs}ms（较慢）`)
    }
  }

  return parts.join('\n')
}
