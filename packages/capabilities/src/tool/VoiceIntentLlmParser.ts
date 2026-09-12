/**
 * VoiceIntentLlmParser — LLM 驱动的语音意图解析器
 *
 * 当 VoiceToolOrchestrator 的关键词匹配失败时，作为 fallback 使用 LLM 解析
 * 用户语音命令，识别意图和参数槽位。
 *
 * 设计原则：
 * 1. LLM 解析仅作为 fallback，不替代本地关键词匹配（保护隐私、降低延迟）
 * 2. 使用结构化 JSON 输出，便于后续校验
 * 3. 解析结果与 VoiceToolOrchestrator 的 VoiceOrchestrateResult 格式兼容
 * 4. 静默降级：LLM 不可用时无感退回普通聊天
 *
 * 与现有模块关系：
 * - LlmService.chatJson() — 调用 LLM 进行结构化分析
 * - VoiceIntentDef — 输出格式与关键词匹配的意图定义一致
 */

import { log, createRequestId } from '@akemi-mio/core/logger/Logger'

// ══════════════════════════════════════════
//  类型
// ══════════════════════════════════════════

/** LLM 解析器的回调函数类型 — 由调用方注入 LlmService 适配器 */
export type LlmJsonCaller = (userText: string, systemPrompt: string) => Promise<{ data?: any; error?: string }>

/** LLM 解析输出结构 — 与 VoiceIntentDef 对齐 */
export interface LlmParsedIntent {
  /** 意图唯一标识（小写英文，如 "analyze_code"） */
  intent: string
  /** 用户可读的意图描述 */
  description: string
  /** 是否匹配成功 */
  matched: boolean
  /** 提取的槽位值 */
  slots: Record<string, string>
  /** 工具序列（MCP 工具调用列表） */
  tools: Array<{ tool: string; args: Record<string, string> }>
  /** 确认消息模板 */
  confirmMessage: string
  /** 是否需要用户确认 */
  requireConfirmation: boolean
  /** LLM 对请求的分析摘要（用于日志） */
  analysis?: string
  /** 置信度（0-1） */
  confidence?: number
}

/** 解析结果 */
export interface LlmParseResult {
  success: boolean
  parsed: LlmParsedIntent | null
  fallbackText: string
  error?: string
}

// ══════════════════════════════════════════
//  System Prompt
// ══════════════════════════════════════════

const LLM_INTENT_SYSTEM_PROMPT = `你是一个语音助手意图解析器。用户的语音转写文本可能包含操作指令。

请分析用户输入，判断是否包含可执行的操作意图。如果包含，提取结构化的意图信息。

可识别的操作类型示例（不限于此）：
- 文件操作：读取、写入、编辑、搜索、列出文件
- 代码操作：分析代码、查找 bug、重构、总结
- 系统操作：状态查询、计划管理
- 内容操作：生成图片、创作内容
- 查询操作：搜索信息、学习知识点

返回 JSON 格式：
{
  "matched": true/false,
  "intent": "小写英文意图标识，如 analyze_code",
  "description": "人类可读的意图描述",
  "slots": { "key": "value" },
  "tools": [{ "tool": "工具名", "args": { "参数字段": "参数值" } }],
  "confirmMessage": "执行前的确认信息",
  "requireConfirmation": true/false,
  "analysis": "对用户请求的分析摘要（简短）",
  "confidence": 0.0-1.0
}

要求：
1. matched=false 当输入为纯闲聊、问候、无明确操作意图时
2. tools 中的工具名使用已有的 MCP 工具名
3. slots 提取关键参数如文件名、路径、搜索词等
4. 风险操作（写文件、编辑、删除等）requireConfirmation=true
5. 只读操作（搜索、读取、状态查询等）requireConfirmation=false
6. 确认信息使用中文，简洁明了
7. 不确定时 matched=false，不要强行匹配
8. 不要编造不存在的工具名`

// ══════════════════════════════════════════
//  LLM 意图解析器
// ══════════════════════════════════════════

export class VoiceIntentLlmParser {
  private llmCaller: LlmJsonCaller | null = null

  /** 设置 LLM 调用器（注入 LlmService 适配器） */
  setLlmCaller(caller: LlmJsonCaller): void {
    this.llmCaller = caller
  }

  /**
   * 使用 LLM 解析用户语音文本。
   * 当关键词匹配失败时调用此方法作为 fallback。
   *
   * @param text ASR 转写文本
   * @param requestId 可选的请求 ID
   * @returns 解析结果
   */
  async parse(text: string, requestId?: string): Promise<LlmParseResult> {
    const rid = requestId || createRequestId()
    const trimmed = text.trim()

    if (!trimmed) {
      return { success: false, parsed: null, fallbackText: text }
    }

    if (!this.llmCaller) {
      log('INFO', 'voice_llm_parser_no_caller', { request_id: rid })
      return { success: false, parsed: null, fallbackText: text }
    }

    log('INFO', 'voice_llm_parse_start', {
      request_id: rid,
      text: trimmed.slice(0, 120),
    })

    const t0 = Date.now()

    try {
      const result = await this.llmCaller(trimmed, LLM_INTENT_SYSTEM_PROMPT)
      const elapsed = Date.now() - t0

      if (result.error) {
        log('WARN', 'voice_llm_parse_error', {
          request_id: rid,
          error: result.error,
          elapsed_ms: elapsed,
        })
        return { success: false, parsed: null, fallbackText: text, error: result.error }
      }

      if (!result.data) {
        log('INFO', 'voice_llm_parse_empty', { request_id: rid, elapsed_ms: elapsed })
        return { success: false, parsed: null, fallbackText: text }
      }

      const data = result.data as Partial<LlmParsedIntent>

      // 校验结构完整性
      if (!data.matched || !data.intent || !data.description) {
        log('INFO', 'voice_llm_parse_no_match', {
          request_id: rid,
          matched: data.matched,
          intent: data.intent,
          elapsed_ms: elapsed,
        })
        return { success: false, parsed: null, fallbackText: text }
      }

      const parsed: LlmParsedIntent = {
        intent: data.intent,
        description: data.description,
        matched: true,
        slots: data.slots || {},
        tools: (data.tools || []).slice(0, 5), // 最多 5 步
        confirmMessage: data.confirmMessage || `将执行: ${data.description}`,
        requireConfirmation: data.requireConfirmation !== false,
        analysis: data.analysis,
        confidence: Math.min(1, Math.max(0, data.confidence ?? 0.5)),
      }

      log('INFO', 'voice_llm_parse_success', {
        request_id: rid,
        intent: parsed.intent,
        slotCount: Object.keys(parsed.slots).length,
        toolCount: parsed.tools.length,
        requireConfirmation: parsed.requireConfirmation,
        confidence: parsed.confidence,
        analysis: parsed.analysis,
        elapsed_ms: elapsed,
      })

      return { success: true, parsed, fallbackText: text }
    } catch (err) {
      const elapsed = Date.now() - t0
      const errorMsg = err instanceof Error ? err.message : String(err)
      log('WARN', 'voice_llm_parse_exception', {
        request_id: rid,
        error: errorMsg,
        elapsed_ms: elapsed,
      })
      return { success: false, parsed: null, fallbackText: text, error: errorMsg }
    }
  }

  /**
   * 检查 LLM 解析器是否就绪（已注入调用器）。
   */
  isReady(): boolean {
    return this.llmCaller !== null
  }

  /**
   * 重置解析器（清除注入的调用器）。
   */
  reset(): void {
    this.llmCaller = null
  }
}

/** 全局单例 */
export const voiceIntentLlmParser = new VoiceIntentLlmParser()

