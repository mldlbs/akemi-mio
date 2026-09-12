/**
 * ExecutionGovernor — tool batch 执行后的强制决策门。
 *
 * 每次工具执行完毕，必须经过 Governor 做出明确决策才能继续：
 *   - continue: 正常推进
 *   - stop:     终止执行链，不再调用 LLM
 *   - shift:    注入策略切换消息，LLM 下轮必须重新规划
 *
 * 与 Guardrail 的核心区别：Guardrail 是阈值计数，达标才干预；
 * Governor 每轮都做模式识别，输出的是执行决策，不是建议。
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { ToolCallInfo } from '@akemi-mio/intelligence/llm/LlmService'
import type { ToolResult } from './ToolScheduler'
import type { RunContext } from './runstate'
import { classifyToolError, ToolErrorType } from '@akemi-mio/capabilities/tool/ToolErrorType'

export type GovernorAction = 'continue' | 'stop' | 'shift'

export interface GovernorDecision {
  action: GovernorAction
  reason: string
  /** 当 action 为 stop 或 shift 时注入 messages 的消息内容 */
  message?: string
}

/** 只读工具名集合 — 用于 READ_CASCADE 检测 */
const READ_TOOLS = new Set(['read_file', 'grep', 'list_files'])

export class ExecutionGovernor {
  /**
   * 上一轮的失败工具：{ toolName → argKey }
   * argKey 是关键参数的 stringified 摘要，用于判断是否重复相同操作。
   */
  private lastFailedTools: Map<string, string> = new Map()
  /** 连续有失败工具的轮数 */
  private cascadeCount = 0

  /**
   * 清理 governor 状态（新 session / 重置时调用）
   */
  reset(): void {
    this.lastFailedTools.clear()
    this.cascadeCount = 0
  }

  /**
   * 每轮批执行后的强制决策门。
   * 需要在 toolResults 已推入 messages、runReflect 执行完毕、Guardrail.apply 执行完毕后调用。
   */
  evaluate(toolResults: ToolResult[], toolCalls: ToolCallInfo[], ctx: RunContext): GovernorDecision {
    // ── Guardrail 已请求终止，不覆盖其决定 ──
    if (ctx.guardrailStop) return { action: 'continue', reason: 'guardrail_stop_active' }

    const failed = toolResults.filter((r) => !r.success)
    const allFailed = failed.length > 0 && failed.length === toolResults.length

    // ─ 1. ALL_FAILED：本轮全部工具失败 → shift（引导换路而非直接放弃） ─
    if (allFailed && toolResults.length > 0) {
      log('WARN', 'governor_all_failed', { step: ctx.step, count: failed.length })
      this.resetState()
      const names = [...new Set(failed.map((r) => r.name))]
      return {
        action: 'shift',
        reason: `all_tools_failed: ${names.join(', ')}`,
        message:
          `【ExecutionGovernor】本轮全部工具调用失败（${names.join(', ')}）。` +
          `失败原因：${failed
            .map((r) => r.error)
            .filter(Boolean)
            .join('; ')}。` +
          `请尝试其他方式达到同样目的，或向用户报告失败情况。`,
      }
    }

    // ─ 2. SAME_FAILURE：同一工具+相同关键参数重复失败 ≥2 次 → shift ─
    for (const tr of failed) {
      const key = this.failureKey(tr, toolCalls)
      if (!key) continue
      const prev = this.lastFailedTools.get(tr.name)
      if (prev === key) {
        log('WARN', 'governor_same_failure', { step: ctx.step, tool: tr.name, args: prev })
        this.resetState()
        const errorType = classifyToolError(tr.error || '')
        const isEnv = errorType === ToolErrorType.ENVIRONMENT
        return {
          action: 'shift',
          reason: `same_tool_failure: ${tr.name}`,
          message: isEnv
            ? `【ExecutionGovernor】${tr.name} 连续失败。` +
              `当前工具不可用（环境缺少必要依赖），请尝试其他命令或工具达到同样目的。` +
              `失败原因：${tr.error || '未知'}`
            : `【ExecutionGovernor】${tr.name} 参数相同且连续失败 2 次。` +
              `当前操作路径不可行，请切换策略重试。不要重复相同的操作。失败原因：${tr.error || '未知'}`,
        }
      }
      this.lastFailedTools.set(tr.name, key)
    }

    // ─ 3. READ_CASCADE：只读工具连续失败但仍尝试 → shift ─
    const hasReadFail = failed.some((r) => READ_TOOLS.has(r.name))
    const nextReadCalls = toolCalls.some((tc) => READ_TOOLS.has(tc.name))
    if (hasReadFail && nextReadCalls && toolResults.length > 0) {
      const readFailed = failed.filter((r) => READ_TOOLS.has(r.name))
      log('WARN', 'governor_read_cascade', { step: ctx.step, failed: readFailed.map((r) => r.name).join(',') })
      this.resetState()
      const isRemote = readFailed.some((r) => r.name.startsWith('centos_'))
      return {
        action: 'shift',
        reason: 'read_cascade',
        message:
          `【ExecutionGovernor】只读工具连续失败（${readFailed.map((r) => r.name).join(', ')}）。` +
          (isRemote ? '远程路径不可访问，请切换到本地工具或检查路径。' : '文件或目录不存在，请检查路径是否正确。') +
          ` 停止猜测路径，先 list_files 确认可用路径。`,
      }
    }

    // ─ 4. CASCADE_FAIL：连续 N 轮有失败 → shift ─
    if (failed.length > 0) {
      this.cascadeCount++
    } else {
      this.cascadeCount = 0
    }
    if (this.cascadeCount >= 3) {
      log('WARN', 'governor_cascade_fail', { step: ctx.step, cascadeCount: this.cascadeCount })
      this.resetState()
      return {
        action: 'shift',
        reason: `cascade_fail: ${this.cascadeCount} consecutive rounds with failures`,
        message:
          `【ExecutionGovernor】连续 ${this.cascadeCount} 轮工具调用均存在失败。` +
          `请总结当前进展，尝试全新策略，或向用户报告遇到的问题。`,
      }
    }

    // ─ 5. 本轮正常：清理失败跟踪（有成功即有进展） ─
    if (failed.length === 0) {
      this.lastFailedTools.clear()
      this.cascadeCount = 0
    } else {
      // 部分失败：只保留本轮也失败的工具，丢弃上一轮没再失败的工具（有进展）
      for (const [name] of this.lastFailedTools) {
        if (!failed.some((r) => r.name === name)) {
          this.lastFailedTools.delete(name)
        }
      }
    }

    return { action: 'continue', reason: 'ok' }
  }

  /** 工具的失败签名：工具名 + 关键参数，用于判断是否重复相同操作 */
  private failureKey(result: ToolResult, toolCalls: ToolCallInfo[]): string | null {
    const tc = toolCalls.find((c) => c.id === result.id)
    if (!tc) return null
    const args = tc.arguments || {}
    // 提取关键参数：path / file_path / command
    const keyArg = args.path ?? args.file_path ?? args.command ?? args.directory ?? ''
    return `${tc.name}::${JSON.stringify(keyArg)}`
  }

  /** 清空内部状态（stop / shift 后立即调用） */
  private resetState(): void {
    this.lastFailedTools.clear()
    this.cascadeCount = 0
  }
}
