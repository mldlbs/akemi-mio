import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import type { ToolResult } from './ToolScheduler'
import type { ToolCallInfo } from '@akemi-mio/intelligence/llm/LlmService'
import type { Message } from './context'
import type { RunContext } from './runstate'
import type { PlanManagerLike } from '@akemi-mio/evolution/types'
import { existsSync } from 'fs'
import { join } from 'path'
import { EVOLUTION_WORKSPACE_DIR } from '@akemi-mio/capabilities/tool/utils/workspace'
import type { ProceduralMemory } from './ProceduralMemory'

// ── Types ──

export interface GuardrailDeps {
  memoryService: { getFormattedContext(): string } | null
  skillManager: { getEnabledPromptModules(): string[] } | null
  planManager: PlanManagerLike
  proceduralMemory?: ProceduralMemory | null
}

export interface GuardrailResult {
  injected: boolean
}

// ── Guardrail ──

export class Guardrail {
  private deps: GuardrailDeps
  private readOnlyTools: Set<string>

  constructor(deps: GuardrailDeps, readOnlyTools?: Set<string>) {
    this.deps = { ...deps }
    this.readOnlyTools =
      readOnlyTools ??
      new Set([
        'read_file',
        'list_files',
        'grep',
        'list_plans',
        // 远程 MCP 只读工具
        'centos_read_file',
        'centos_grep',
        'centos_search_files',
      ])
  }

  /** 更新依赖（memoryService/skillManager 延迟注入） */
  updateDeps(partial: Partial<GuardrailDeps>): void {
    Object.assign(this.deps, partial)
  }

  /**
   * 对一批工具执行结果执行所有 guardrail 检查。
   * 副作用：注入系统消息到 messages，更新 ctx 计数器。
   */
  apply(toolResults: ToolResult[], toolCalls: ToolCallInfo[], messages: Message[], ctx: RunContext): GuardrailResult {
    // Guardrail 已请求终止：跳过所有检查，放行最后一轮 LLM 回复
    if (ctx.guardrailStop) return { injected: false }

    let injected = false

    // 1. 连续只读检测（仅注入提示，不终止循环）
    const allReadOnly = toolCalls.every((c) => this.readOnlyTools.has(c.name))
    if (this.checkReadOnlyStuck(allReadOnly, toolResults, messages, ctx)) {
      injected = true
    }

    // 3. list_files 路径兜底
    this.checkListFilesPathFallback(toolResults)

    // 4. plan 操作失败恢复
    if (this.checkPlanErrors(toolResults, messages)) injected = true

    // 5. 连续工具错误 → 诊断模式
    if (this.checkConsecutiveToolErrors(toolResults, messages, ctx)) injected = true

    // 6. 只读错误 > 3 次 → 切换模式
    if (this.checkConsecutiveReadOnlyErrors(toolResults, messages, ctx)) injected = true

    // 7. writing 工具全部失败检测 → 切换提示
    if (this.checkWritingToolFailure(toolResults, messages)) injected = true

    // 8. 流程记忆自动建议
    if (this.checkProcedureSuggestion(toolCalls, messages)) injected = true

    return { injected }
  }

  // ── 各 guardrail 实现 ──

  /**
   * 连续只读检测 — 连续 2 轮以上全是只读操作则给出提示。
   * 含远程工具失败快速降级：检测到 centos_* 等远程工具失败时，1 轮即干预。
   * 累计 readonlyStuckCount >= 3 时强制提示输出中间结论，
   * >= 4 时直接中断 toolLoop 防止死循环。
   */
  private checkReadOnlyStuck(allReadOnly: boolean, toolResults: ToolResult[], messages: Message[], ctx: RunContext): boolean {
    if (ctx.suppressForceContinue) return false

    // 快速降级：检测到远程工具失败 + 只读操作，1 轮就干预
    const hasFailedRemote = toolResults.some((r) => !r.success && (r.name.startsWith('centos_') || r.name.startsWith('writing_')))
    if (hasFailedRemote && allReadOnly && ctx.consecutiveReadOnlyRounds >= 1) {
      ctx.consecutiveReadOnlyRounds = 0
      ctx.readonlyStuckCount++
      log('WARN', 'guardrail_remote_tool_fast_fallback', { rounds: ctx.consecutiveReadOnlyRounds + 1 })
      messages.push({
        role: 'user',
        content:
          '【系统提示】远程工具连续失败，请立即切换到本地工具（grep/read_file/list_files@project 或 writing_system）。不要继续使用远程工具。',
      })
      return true
    }

    if (allReadOnly) {
      ctx.consecutiveReadOnlyRounds++
    } else {
      ctx.consecutiveReadOnlyRounds = 0
    }

    if (ctx.consecutiveReadOnlyRounds >= 2) {
      const rounds = ctx.consecutiveReadOnlyRounds
      ctx.consecutiveReadOnlyRounds = 0
      ctx.readonlyStuckCount++
      log('WARN', 'guardrail_readonly_stuck', { rounds, total: ctx.readonlyStuckCount })
      eventBus.emit('guardrail.readonly_stuck', { count: ctx.readonlyStuckCount, consecutiveRounds: rounds })

      if (ctx.readonlyStuckCount >= 4) {
        messages.push({
          role: 'user',
          content:
            '【系统强制】已连续多次只读卡死，当前状态无法继续推进。立即停止所有读取操作，基于已获取的信息给出当前最佳回答或总结。不要继续尝试读取新文件。',
        })
        ctx.guardrailStop = true
      } else if (ctx.readonlyStuckCount >= 3) {
        messages.push({
          role: 'user',
          content:
            '【系统强制】这已经是第 3 次检测到只读卡死。请不要继续读取文件。如果已有足够信息就总结输出，如果信息不足就基于现有信息给出阶段性结论。如果是远程工具卡住，请切换为本地工具（writing_system）。',
        })
      } else {
        messages.push({
          role: 'user',
          content:
            '【系统提示】你已经连续读取多个文件了。如果信息足够，请直接给出回答或开始执行。如果还需要继续查阅才能决策，可以继续读取。注意：远程服务器工具（centos_*）较慢，如需快速查看小说内容请用 writing_system 本地工具。',
        })
      }
      return true
    }
    return false
  }

  /**
   * list_files 路径兜底
   */
  private checkListFilesPathFallback(toolResults: ToolResult[]): void {
    for (const tr of toolResults) {
      if (!tr.success && tr.content.includes('目录不存在:')) {
        const missingDir = tr.content.match(/目录不存在: (.+)$/m)?.[1]
        if (missingDir && /^[^/\\]+$/.test(missingDir) && existsSync(join(EVOLUTION_WORKSPACE_DIR, missingDir))) {
          tr.content += `\n提示：你可能想找 evolution_workspace/${missingDir}/，用 list_files path="evolution_workspace/${missingDir}" 访问。`
        }
      }
    }
  }

  /**
   * plan 操作失败恢复
   */
  private checkPlanErrors(toolResults: ToolResult[], messages: Message[]): boolean {
    const planErrors = toolResults.filter((r) => !r.success && (r.content.includes('计划') || r.content.includes('plan')))
    if (planErrors.length === 0) return false

    const activePlan = this.deps.planManager.getActivePlan()
    if (activePlan) {
      messages.push({
        role: 'user',
        content:
          `【系统强制】你刚操作的开发计划不存在或 ID 不对。数据库中的活跃计划是「${activePlan.title}」（plan_id=${activePlan.id}，已完成 ${activePlan.steps.filter((s) => s.status === 'done').length}/${activePlan.steps.length} 步）。` +
          `直接使用 plan_id=${activePlan.id} 继续，不要 list_plans，不要猜测。下一步未完成的步骤名：${
            activePlan.steps
              .filter((s) => s.status !== 'done')
              .map((s) => `"${s.description}"`)
              .join('、') || '无'
          }。` +
          `先用 write_file/edit_file 写代码，然后用 update_plan_progress 标记完成。`,
      })
    } else {
      messages.push({
        role: 'user',
        content: '【系统强制】你刚操作的开发计划不存在，且数据库中没有活跃计划。如果你认为应该有一个计划，请用 create_dev_plan 重新创建。',
      })
    }
    return true
  }

  /**
   * 连续工具错误 → 诊断模式
   * 累计 >= 3 次注入诊断消息；>= 5 次直接中断 toolLoop
   */
  private checkConsecutiveToolErrors(toolResults: ToolResult[], messages: Message[], ctx: RunContext): boolean {
    if (ctx.guardrailStop) return false
    const anyError = toolResults.some((r) => !r.success)
    if (anyError) {
      ctx.consecutiveToolErrors++
    } else {
      ctx.consecutiveToolErrors = 0
    }
    if (!ctx.suppressForceContinue && !ctx.guardrailStop) {
      if (ctx.consecutiveToolErrors >= 5) {
        ctx.consecutiveToolErrors = 0
        log('WARN', 'guardrail_diagnostic_trigger', { consecutive_errors: 5 })
        eventBus.emit('guardrail.tool_error', { tool: '', error: '5 consecutive tool errors', consecutiveErrors: 5 })
        messages.push({
          role: 'user',
          content: '【系统强制】连续 5 次工具调用全部失败，当前路径不可行。请基于已获取的信息输出当前结论或总结，不要继续重试。',
        })
        ctx.guardrailStop = true
        return true
      }
      if (ctx.consecutiveToolErrors >= 3) {
        ctx.consecutiveToolErrors = 0
        log('WARN', 'guardrail_diagnostic_trigger', { consecutive_errors: 3 })
        // 分析失败的工具类型，给出针对性建议
        const failingTools = [...new Set(toolResults.filter((r) => !r.success).map((r) => r.name))]
        const hasRemoteTools = failingTools.some((n) => n.startsWith('centos_'))
        const hasWriteTools = failingTools.some((n) => ['run_command', 'exec_command'].includes(n))
        const hasReadTools = failingTools.some((n) =>
          ['read_file', 'list_files', 'grep', 'centos_read_file', 'centos_grep', 'centos_search_files'].includes(n),
        )

        let guidance = '【调试模式】你连续多次工具调用都失败了。'
        if (hasRemoteTools) {
          guidance += '\n- 远程服务器工具（centos_*）不可用或已超时，请切换到本地等价工具（grep/read_file/list_files）。'
        }
        if (hasWriteTools) {
          guidance +=
            '\n- 命令执行类工具失败，请检查命令是否在允许列表中（python/python3 已加入白名单），Windows 不支持 python3 请用 python。'
        }
        if (hasReadTools) {
          guidance += '\n- 文件读取类工具失败，请检查路径是否正确，或用 list_files workspace="evolution" 先浏览可用目录。'
        }
        guidance += '\n先诊断根本原因：用 writing_system 等本地工具查看当前状态，确认问题后再尝试修复。不要重复已经失败的操作。'
        messages.push({ role: 'user', content: guidance })
        return true
      }
    }
    return false
  }

  /**
   * 只读错误 > 3 次 → 切换模式
   */
  private checkConsecutiveReadOnlyErrors(toolResults: ToolResult[], messages: Message[], ctx: RunContext): boolean {
    const anyReadError = toolResults.some((r) => !r.success && this.readOnlyTools.has(r.name))
    if (anyReadError) {
      ctx.consecutiveReadOnlyErrors++
    } else {
      ctx.consecutiveReadOnlyErrors = 0
    }
    if (!ctx.suppressForceContinue && ctx.consecutiveReadOnlyErrors >= 3) {
      ctx.consecutiveReadOnlyErrors = 0
      log('WARN', 'guardrail_readonly_error_stuck', { consecutive_readonly_errors: 3 })
      // 分析失败的工具类型
      const failingReadTools = [...new Set(toolResults.filter((r) => !r.success && this.readOnlyTools.has(r.name)).map((r) => r.name))]
      const isRemote = failingReadTools.some((n) => n.startsWith('centos_'))
      let guidance = '【系统强制】你连续多次读取文件都出错（目录不存在/文件不存在/路径错误），说明当前分析路径有问题。\n'
      if (isRemote) {
        guidance += '- 远程服务器（centos_*）文件读取失败，请切换为本地工具（writing_system 工具可查看小说内容）。\n'
      }
      guidance += '- 立即停止读取，先检查当前开发计划是否存在。\n'
      guidance += '- 如果不知道路径，用 list_files workspace="evolution" 先浏览可用目录。\n'
      guidance += '- 然后 write_file/edit_file 写代码推进实现。不要继续猜测路径读取文件！'
      messages.push({ role: 'user', content: guidance })
      return true
    }
    return false
  }

  /**
   * writing 工具全部失败 → 注入切换提示，防止 LLM 在死循环中反复重试
   */
  private checkWritingToolFailure(toolResults: ToolResult[], messages: Message[]): boolean {
    const writingFailures = toolResults.filter((r) => !r.success && r.name.startsWith('writing_'))
    if (writingFailures.length === 0) return false

    const allWriting = toolResults.length > 0 && toolResults.every((r) => r.name.startsWith('writing_'))
    if (allWriting) {
      messages.push({
        role: 'user',
        content:
          '【系统提示】写作系统（writing_* 工具）全部不可用，可能是后台服务未启动。请停止调用写作工具，转用本地文件工具直接操作文件。如果用户需要写作帮助，请告知写作系统暂时不可用。',
      })
      return true
    }
    return false
  }

  /**
   * 流程记忆自动建议：当当前工具调用序列匹配到已保存流程时，给出提示。
   */
  private checkProcedureSuggestion(toolCalls: ToolCallInfo[], messages: Message[]): boolean {
    const pm = this.deps.proceduralMemory
    if (!pm) return false
    const toolNames = toolCalls.map((t) => t.name)
    const query = toolNames.join(' ')
    const matches = pm.findByEmbedding(query, 1)
    if (matches.length === 0) return false
    const p = matches[0]
    messages.push({
      role: 'user',
      content: `【提示】当前操作模式与已保存流程「${p.name}」匹配。如果适用，可以直接复用该流程。步骤：${p.steps.map((s, i) => `${i + 1}.${s}`).join(' → ')}。`,
    })
    return true
  }
}
