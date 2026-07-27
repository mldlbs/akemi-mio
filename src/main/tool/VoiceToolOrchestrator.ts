/**
 * VoiceToolOrchestrator — 语音驱动的 MCP 工具编排引擎
 *
 * 功能：
 * 1. 本地关键词意图识别（无云端依赖，保护隐私）
 * 2. 意图 → MCP 工具序列映射
 * 3. 链式工具调用（前一步输出 → 下一步输入）
 * 4. 用户确认环节（执行前确认，防止误操作）
 *
 * 所有处理在主进程内完成，不发送用户语音内容到外部服务。
 */

import { log, createRequestId } from '../logger/Logger'
import {
  matchIntents,
  extractSlots,
  findIntentById,
  type VoiceIntentDef,
} from './voice-intent-map'

// ── 类型 ──

export interface VoiceOrchestrateRequest {
  /** ASR 转写文本 */
  text: string
  /** 唯一请求 ID */
  requestId?: string
}

export interface VoiceOrchestrateResult {
  /** 是否匹配到工具意图 */
  matched: boolean
  /** 匹配到的意图信息 */
  intent?: {
    name: string
    description: string
    confirmMessage: string
    toolSequence: Array<{ tool: string; args: Record<string, string> }>
    slots: Record<string, string>
  }
  /** 如果匹配失败，返回原始文本供后续 LLM 处理 */
  fallbackText?: string
}

export interface VoiceExecuteRequest {
  /** 意图名 */
  intent: string
  /** 槽位填充值 */
  slots: Record<string, string>
  /** 请求 ID */
  requestId?: string
}

export interface VoiceExecuteResult {
  success: boolean
  /** 每步工具的执行结果 */
  steps: Array<{
    tool: string
    success: boolean
    output: string
    error?: string
    durationMs: number
  }>
  /** 汇总输出（最后一步的结果） */
  summary: string
}

// ── 工具调用器接口 ──

export interface ToolCaller {
  callTool(name: string, args: Record<string, any>): Promise<string>
}

/** TTS 播报回调 — 语音反馈执行结果 */
export type TtsSpeaker = (text: string) => Promise<void>

// ── 编排器 ──

export class VoiceToolOrchestrator {
  private toolCaller: ToolCaller | null = null
  private ttsSpeaker: TtsSpeaker | null = null
  /** 是否在工具链执行后自动播报语音反馈 */
  private _autoTtsFeedback = true

  /** 设置工具调用器（ServerManager 适配） */
  setToolCaller(caller: ToolCaller): void {
    this.toolCaller = caller
  }

  /** 设置 TTS 播报回调 */
  setTtsSpeaker(speaker: TtsSpeaker): void {
    this.ttsSpeaker = speaker
  }

  /** 启用/禁用自动语音反馈 */
  setAutoTtsFeedback(enabled: boolean): void {
    this._autoTtsFeedback = enabled
  }

  /** 获取自动语音反馈状态 */
  get autoTtsFeedback(): boolean {
    return this._autoTtsFeedback
  }

  /**
   * 第一步：匹配意图
   *
   * 接收 ASR 转写文本，尝试匹配预定义的工具意图。
   * 返回匹配结果或 fallback 文本。
   */
  match(req: VoiceOrchestrateRequest): VoiceOrchestrateResult {
    const rid = req.requestId || createRequestId()
    const text = req.text.trim()
    if (!text) {
      return { matched: false, fallbackText: text }
    }

    log('INFO', 'voice_orchestrate_match_start', { request_id: rid, text: text.slice(0, 100) })

    // 关键词匹配
    const matchedDefs = matchIntents(text)
    if (matchedDefs.length === 0) {
      log('INFO', 'voice_orchestrate_no_match', { request_id: rid })
      return { matched: false, fallbackText: text }
    }

    // 取最高分匹配
    const bestMatch = matchedDefs[0]

    // 提取槽位
    const slots = bestMatch.slotExtractors
      ? extractSlots(text, bestMatch.slotExtractors)
      : {}

    // 构建工具序列（替换占位符）
    const toolSequence = bestMatch.tools.map((step) => ({
      tool: step.tool,
      args: this.resolveArgs(step.args, slots, {}),
    }))

    // 构建确认消息
    const confirmMessage = this.resolveTemplate(bestMatch.confirmMessage, slots)

    log('INFO', 'voice_orchestrate_match_found', {
      request_id: rid,
      intent: bestMatch.intent,
      slots: Object.keys(slots),
      toolCount: toolSequence.length,
    })

    return {
      matched: true,
      intent: {
        name: bestMatch.intent,
        description: bestMatch.description,
        confirmMessage,
        toolSequence,
        slots,
      },
    }
  }

  /**
   * 第二步：执行工具链（用户已确认）
   *
   * 按顺序执行工具序列，每步输出注入下一步输入。
   */
  async execute(req: VoiceExecuteRequest): Promise<VoiceExecuteResult> {
    const rid = req.requestId || createRequestId()
    if (!this.toolCaller) {
      return {
        success: false,
        steps: [],
        summary: '工具调用器未初始化',
      }
    }

    // 找到意图定义
    const intentDef = this.findIntent(req.intent)
    if (!intentDef) {
      return {
        success: false,
        steps: [],
        summary: `未知意图: ${req.intent}`,
      }
    }

    log('INFO', 'voice_orchestrate_execute_start', {
      request_id: rid,
      intent: req.intent,
      toolCount: intentDef.tools.length,
      slots: req.slots,
    })

    const steps: VoiceExecuteResult['steps'] = []
    let prevOutput = '' // 链式传递：上一步输出

    for (let i = 0; i < intentDef.tools.length; i++) {
      const stepDef = intentDef.tools[i]
      const t0 = Date.now()

      // 解析参数：支持 {{slot.xxx}} 和 {{prev.xxx}}
      const resolvedArgs: Record<string, any> = {}
      for (const [key, template] of Object.entries(stepDef.args)) {
        resolvedArgs[key] = this.resolveArgValue(template, req.slots, prevOutput)
      }

      log('INFO', 'voice_orchestrate_step', {
        request_id: rid,
        step: i + 1,
        total: intentDef.tools.length,
        tool: stepDef.tool,
        args: JSON.stringify(resolvedArgs).slice(0, 200),
      })

      try {
        const output = await this.toolCaller.callTool(stepDef.tool, resolvedArgs)
        const durationMs = Date.now() - t0
        prevOutput = output
        steps.push({
          tool: stepDef.tool,
          success: true,
          output: output.slice(0, 2000), // 截断过长输出
          durationMs,
        })
        log('INFO', 'voice_orchestrate_step_done', {
          request_id: rid,
          step: i + 1,
          tool: stepDef.tool,
          duration_ms: durationMs,
          output_len: output.length,
        })
      } catch (err) {
        const durationMs = Date.now() - t0
        const errorMsg = err instanceof Error ? err.message : String(err)
        steps.push({
          tool: stepDef.tool,
          success: false,
          output: '',
          error: errorMsg,
          durationMs,
        })
        log('ERROR', 'voice_orchestrate_step_failed', {
          request_id: rid,
          step: i + 1,
          tool: stepDef.tool,
          error: errorMsg,
          duration_ms: durationMs,
        })

        // 链式调用失败时停止后续步骤
        return {
          success: false,
          steps,
          summary: `第 ${i + 1} 步 ${stepDef.tool} 执行失败: ${errorMsg}`,
        }
      }
    }

    const summary = steps.length > 0
      ? steps[steps.length - 1].output
      : '(无输出)'

    log('INFO', 'voice_orchestrate_execute_done', {
      request_id: rid,
      intent: req.intent,
      stepCount: steps.length,
      success: true,
    })

    // ── 自动语音播报执行结果 ──
    if (this._autoTtsFeedback && this.ttsSpeaker) {
      const ttsText = this.buildTtsFeedback(steps, req.intent)
      if (ttsText) {
        this.ttsSpeaker(ttsText).catch((err: unknown) =>
          log('WARN', 'voice_orchestrate_tts_feedback_error', {
            request_id: rid,
            error: String(err),
          }),
        )
      }
    }

    return { success: true, steps, summary }
  }

  /**
   * 构建执行结果语音播报文本。
   * 只在有 TTS speaker 时调用。
   */
  private buildTtsFeedback(
    steps: VoiceExecuteResult['steps'],
    intentName: string,
  ): string {
    const successCount = steps.filter((s) => s.success).length
    const totalCount = steps.length

    if (successCount === 0) {
      return `操作执行失败，${totalCount} 个步骤全部出错。`
    }

    // 简短播报：几步成功、几步失败
    const successPart = `${successCount} 个步骤执行成功`
    const failCount = totalCount - successCount
    const failPart = failCount > 0 ? `，${failCount} 个步骤失败` : ''

    // 取最后一步的输出摘要作为主要播报内容
    const lastStep = steps[steps.length - 1]
    let resultSummary = ''
    if (lastStep.success && lastStep.output) {
      // 清理输出中的标记和过长的内容
      const clean = lastStep.output
        .replace(/[#*`\[\]]/g, '')
        .replace(/\n+/g, '，')
        .trim()
      resultSummary = clean.length > 120
        ? clean.slice(0, 120) + '...'
        : clean
    }

    if (resultSummary) {
      return `${successPart}${failPart}。${resultSummary}`
    }
    return `${successPart}${failPart}。`
  }

  /**
   * 一站式编排：匹配 → 确认（回调通知上层）→ 执行 → TTS 播报
   *
   * 适用于外部调用方（IPC handler）的一次性操作流程。
   * 确认环节通过回调通知，由调用方（如 VoiceConfirmationSession）处理。
   *
   * @param text 用户语音文本
   * @param onNeedConfirm 需要确认时的回调（intent 信息 → Promise<是否确认>）
   * @param requestId 可选的请求 ID
   * @returns 执行结果或匹配结果
   */
  async matchAndExecute(
    text: string,
    onNeedConfirm?: (info: {
      intentName: string
      description: string
      confirmMessage: string
      slots: Record<string, string>
      tools: Array<{ tool: string; args: Record<string, string> }>
    }) => Promise<boolean>,
    requestId?: string,
  ): Promise<
    | { matched: false; fallbackText: string }
    | { matched: true; result: VoiceExecuteResult }
  > {
    const rid = requestId || createRequestId()

    // 第一步：匹配
    const matchResult = this.match({ text, requestId: rid })
    if (!matchResult.matched || !matchResult.intent) {
      return { matched: false, fallbackText: text }
    }

    const intent = matchResult.intent
    const requireConfirm = matchResult.intent.name ? true : true // 从意图定义读取

    // 第二步：确认（如果注册了确认回调）
    if (onNeedConfirm && requireConfirm) {
      const confirmed = await onNeedConfirm({
        intentName: intent.name,
        description: intent.description,
        confirmMessage: intent.confirmMessage,
        slots: intent.slots,
        tools: intent.toolSequence,
      })

      if (!confirmed) {
        log('INFO', 'voice_orchestrate_user_cancelled', {
          request_id: rid,
          intent: intent.name,
        })
        return {
          matched: true,
          result: { success: false, steps: [], summary: '用户取消了操作' },
        }
      }
    }

    // 第三步：执行
    const result = await this.execute({
      intent: intent.name,
      slots: intent.slots,
      requestId: rid,
    })

    return { matched: true, result }
  }

  // ── 私有方法 ──

  /** 查找意图定义（静态 + 动态） */
  private findIntent(name: string): VoiceIntentDef | undefined {
    return findIntentById(name)
  }

  /** 解析参数模板（批量） */
  private resolveArgs(
    templates: Record<string, string>,
    slots: Record<string, string>,
    prevOutput: Record<string, string>,
  ): Record<string, string> {
    const resolved: Record<string, string> = {}
    for (const [key, template] of Object.entries(templates)) {
      resolved[key] = this.resolveTemplate(template, { ...slots, ...prevOutput })
    }
    return resolved
  }

  /** 解析单个参数值 */
  private resolveArgValue(
    template: string,
    slots: Record<string, string>,
    prevOutput: string,
  ): string {
    let result = template

    // 替换 {{slot.xxx}}
    result = result.replace(/\{\{slot\.(\w+)\}\}/g, (_, key) => {
      return slots[key] || ''
    })

    // 替换 {{prev.text}} — 上一步完整输出
    result = result.replace(/\{\{prev\.text\}\}/g, prevOutput)

    // 替换 {{prev.firstMatch}} — 上一步输出中第一个文件路径
    if (result.includes('{{prev.firstMatch}}')) {
      const firstMatch = this.extractFirstFilePath(prevOutput)
      result = result.replace(/\{\{prev\.firstMatch\}\}/g, firstMatch || prevOutput)
    }

    // 替换 {{prev.json.xxx}} — 尝试解析上一步 JSON 输出
    result = result.replace(/\{\{prev\.json\.(\w+)\}\}/g, (_, key) => {
      try {
        const parsed = JSON.parse(prevOutput)
        return String(parsed[key] || '')
      } catch {
        return ''
      }
    })

    return result
  }

  /** 解析确认消息模板 */
  private resolveTemplate(template: string, slots: Record<string, string>): string {
    return template.replace(/\{\{slot\.(\w+)\}\}/g, (_, key) => {
      return slots[key] || `(未指定:${key})`
    })
  }

  /** 从文本中提取第一个文件路径 */
  private extractFirstFilePath(text: string): string | null {
    // 尝试匹配常见的文件路径模式
    const patterns = [
      /([^\s"'\n]+\.(?:ts|tsx|js|jsx|json|py|md|txt|css|html))/i,
      /(?:^|\n)\s*([^\s"'\n]{2,}(?:\/[^\s"'\n]+)+)/m,
    ]
    for (const p of patterns) {
      const m = text.match(p)
      if (m) return m[1]
    }
    return null
  }
}
