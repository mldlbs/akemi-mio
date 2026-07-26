import { log } from '../logger/Logger'
import {
  ConversationContext,
  estimateTokens,
  estimateMessageTokens,
  getBasePromptTokens,
  Message,
  trimOrphanedToolCallsFrom,
} from '../agent/context'
import { validateToolCallChain } from '../agent/ContextIntegrityChecker'
import { ChatResult, ChunkCallback } from './types'
import { INTENT_CLASSIFY_PROMPT } from '../agent/intent/types'
import { ServerManager } from '../mcp/ServerManager'
import type { ToolSchemaProvider } from '../tool/ToolSchemaProvider'
import {
  LLM_API_URL,
  LLM_CHAT_MODEL,
  LLM_CODE_MODEL,
  LLM_CODE_API_URL,
  LLM_VISION_API_URL,
  LLM_VISION_MODEL,
  LLM_VISION_KEY,
  LLM_TEXT_API_URL,
  LLM_TEXT_MODEL,
  LLM_TEXT_KEY,
} from '../config'
import { createTimeoutSignal } from '../utils/async'
import { extractJsonFromLLMReply } from '../utils/llm'
import type { EvaluationEmitter } from '../core/evaluation/EvaluationEmitter'
import { classifyMessageBreakdown } from '../core/evaluation/TokenBreakdown'

export interface ToolCallInfo {
  id: string
  name: string
  arguments: Record<string, any>
}

/** 校验 URL 字符串是否为合法的 HTTP/HTTPS URL，防止凭据库中误存的 API key 污染 URL 配置 */
function _isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export class LlmService {
  private chatApiKey: string | null = null
  private codeApiKey: string | null = null
  private textApiKey: string | null = null
  private visionKey: string | null = null
  private apiModel = LLM_CHAT_MODEL
  private codeModel = LLM_CODE_MODEL
  private textModel = LLM_TEXT_MODEL
  private visionModel = LLM_VISION_MODEL
  private chatApiUrl = LLM_API_URL
  private codeApiUrl = LLM_CODE_API_URL
  private textApiUrl = LLM_TEXT_API_URL
  private visionApiUrl = LLM_VISION_API_URL
  private mcpManager: ServerManager
  private evaluationEmitter?: EvaluationEmitter
  /** P1.3a: schema provider（可选，未设时降级到 mcpManager.getAllSchemas()） */
  private schemaProvider: ToolSchemaProvider | null = null
  /** setConfig() 已被调用 — refreshFromCredentials 不应再覆盖 key/url 等显式配置 */
  private _configured = false

  constructor(mcpManager?: ServerManager, evaluationEmitter?: EvaluationEmitter) {
    this.mcpManager = mcpManager || new ServerManager()
    this.evaluationEmitter = evaluationEmitter
  }

  setEvaluationEmitter(emitter: EvaluationEmitter): void {
    this.evaluationEmitter = emitter
  }

  setMcpManager(manager: ServerManager): void {
    this.mcpManager = manager
  }

  /** P1.3a: 设置 ToolSchemaProvider（替换直接 mcpManager.getAllSchemas()） */
  setSchemaProvider(provider: ToolSchemaProvider | null): void {
    this.schemaProvider = provider
  }

  /** 从外部凭据存储（CredentialsManager）读取并刷新全部 LLM 配置 */
  refreshFromCredentials(getter: (key: string) => string | null): void {
    const key = getter('llm_key')
    const codeKey = getter('llm_code_api_key')
    // _configured 表示 setConfig() 已从 .env 设定了权威值，不再覆盖
    if (!this._configured) {
      if (key) this.chatApiKey = key
      if (codeKey) this.codeApiKey = codeKey
    }
    this.textApiKey = getter('llm_text_key') || LLM_TEXT_KEY || key || ''
    this.visionKey = getter('llm_vision_key') || LLM_VISION_KEY || key || ''

    if (!this._configured) {
      const url = getter('llm_api_url')
      const codeUrl = getter('llm_code_api_url')
      if (url && _isHttpUrl(url)) this.chatApiUrl = url
      if (codeUrl && _isHttpUrl(codeUrl)) this.codeApiUrl = codeUrl

      const visionUrl = getter('llm_vision_api_url')
      if (visionUrl && _isHttpUrl(visionUrl)) this.visionApiUrl = visionUrl

      const textUrl = getter('llm_text_api_url')
      if (textUrl && _isHttpUrl(textUrl)) this.textApiUrl = textUrl
    }

    const model = getter('llm_chat_model')
    const codeModel = getter('llm_code_model')
    if (model) this.apiModel = model
    if (codeModel) this.codeModel = codeModel

    const visionModel = getter('llm_vision_model')
    if (visionModel) this.visionModel = visionModel

    const textModel = getter('llm_text_model')
    if (textModel) this.textModel = textModel
  }

  setConfig(chatKey: string, codeKey?: string, chatModel?: string, codeModel?: string, chatUrl?: string, codeUrl?: string): void {
    this._configured = true
    this.chatApiKey = chatKey
    this.codeApiKey = codeKey || chatKey
    this.textApiKey = LLM_TEXT_KEY || chatKey
    if (chatModel) this.apiModel = chatModel
    if (codeModel) this.codeModel = codeModel
    if (chatUrl) this.chatApiUrl = chatUrl
    if (codeUrl) this.codeApiUrl = codeUrl
    // 如果有 vision key 环境变量则使用之
    this.visionKey = LLM_VISION_KEY || chatKey
  }

  /** 设置文本处理模型的专用 key（覆盖 LLM_TEXT_KEY 默认值） */
  setTextKey(key: string): void {
    this.textApiKey = key
  }

  async classifyIntent(userText: string, requestId?: string): Promise<ChatResult> {
    // 优先用 chat key，如果没有则用 code key（兼容 chat API 不可用的情况）
    const key = this.chatApiKey || this.codeApiKey
    if (!key) return { error: 'NO_KEY' }

    log('INFO', 'intent_classify_start', { request_id: requestId, text: userText })

    const { controller, timer } = createTimeoutSignal(10000)
    const t0 = Date.now()

    try {
      // 用 code 模型的 URL 和 key，但不带 tools 参数（避免模型返回工具调用而非文本）
      const baseUrl = this.codeApiKey ? this.codeApiUrl : this.chatApiUrl
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.codeModel,
          messages: [
            { role: 'system', content: INTENT_CLASSIFY_PROMPT },
            { role: 'user', content: userText },
          ],
          stream: false,
          temperature: 0.1,
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const elapsed = Date.now() - t0
        const body = await res.text().catch(() => '(unable to read body)')
        log('WARN', 'intent_classify_api_error', {
          request_id: requestId,
          status: res.status,
          elapsed_ms: elapsed,
          body: body.slice(0, 500),
        })
        return { error: `API_ERROR:${res.status}` }
      }

      const data = (await res.json()) as { choices?: Array<{ message: { content: string } }> }
      const reply = data.choices?.[0]?.message?.content?.trim() || ''
      const elapsed = Date.now() - t0

      log('INFO', 'intent_classify_done', { request_id: requestId, reply, duration_ms: elapsed })
      return { reply }
    } catch (err) {
      log('ERROR', 'intent_classify_failed', { request_id: requestId, error: String(err) })
      return { error: 'NETWORK' }
    } finally {
      clearTimeout(timer)
    }
  }

  async chatStream(
    userText: string,
    context: ConversationContext,
    onChunk: ChunkCallback,
    requestId?: string,
    timeoutMs = 30000,
  ): Promise<ChatResult> {
    if (!this.chatApiKey) return { error: 'NO_KEY' }

    const promptTokens = this._countPromptTokens(userText, context)
    log('CHAT', 'user_prompt', { request_id: requestId, text: userText, tokens: promptTokens })
    context.addUser(userText)

    const t0 = Date.now()

    for (let attempt = 1; attempt <= 3; attempt++) {
      const { controller, timer } = createTimeoutSignal(timeoutMs)
      try {
        log('INFO', 'llm_request', { request_id: requestId, model: this.apiModel, prompt_tokens: promptTokens })
        const res = await this._doFetch(context.getMessages(), true, controller.signal)

        if (res.status === 429) {
          log('WARN', 'rate_limited', { request_id: requestId, elapsed_ms: Date.now() - t0 })
          if (attempt < 3) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 4000)
            log('WARN', 'rate_limit_retry', { request_id: requestId, attempt, delay_ms: delay })
            await new Promise((r) => setTimeout(r, delay))
            continue
          }
          return { error: 'RATE_LIMITED' }
        }

        const statusErr = this._checkStatus(res, requestId, t0)
        if (statusErr) return statusErr

        const full = await this._readSSEStream(res, onChunk, requestId, t0, controller.signal)

        const elapsed = Date.now() - t0
        const outputTokens = estimateTokens(full)
        log('CHAT', 'llm_response', { request_id: requestId, text: full, duration_ms: elapsed, token_count: outputTokens })
        log('PERF', 'llm_inference', {
          request_id: requestId,
          duration_ms: elapsed,
          prompt_tokens: promptTokens,
          output_tokens: outputTokens,
        })
        context.addAssistant(full)
        context.trimToTokenBudget()
        return { reply: full }
      } catch (err) {
        const elapsed = Date.now() - t0
        if (err instanceof DOMException && err.name === 'AbortError') {
          log('ERROR', 'llm_timeout', { request_id: requestId, elapsed_ms: elapsed })
          return { error: 'TIMEOUT' }
        }
        log('ERROR', 'llm_network_error', { request_id: requestId, elapsed_ms: elapsed, error: String(err) })
        return { error: 'NETWORK' }
      } finally {
        clearTimeout(timer)
      }
    }

    return { error: 'RATE_LIMITED' }
  }

  private _countPromptTokens(userText: string, context: ConversationContext): number {
    const systemTokens = getBasePromptTokens()
    const messages = context.getMessages()
    return systemTokens + estimateTokens(userText) + messages.slice(1).reduce((s, m) => s + estimateTokens(m.content), 0)
  }

  private _getFilteredSchemas(allowedToolNames?: string[]) {
    // P1.3a: 优先使用 ToolSchemaProvider（含 capability schema），降级到 mcpManager
    const allSchemas = this.schemaProvider
      ? this.schemaProvider.getSchemas()
      : this.mcpManager.getAllSchemas()
    // undefined → 不限制（向后兼容）
    if (allowedToolNames === undefined) return allSchemas
    // 显式传入数组（[] 表示无工具可用）→ 过滤
    return allSchemas.filter((s) => allowedToolNames.includes(s.function.name))
  }

  private _doFetch(
    messages: Message[],
    stream: boolean,
    signal: AbortSignal,
    model?: string,
    allowedToolNames?: string[],
  ): Promise<Response> {
    const isCode = !!model
    const baseUrl = isCode ? this.codeApiUrl : this.chatApiUrl
    const key = isCode ? this.codeApiKey! : this.chatApiKey!
    const tools = this._getFilteredSchemas(allowedToolNames)
    return fetch(baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model || this.apiModel,
        messages,
        stream,
        ...(stream ? {} : { tools: tools.length > 0 ? tools : undefined, tool_choice: 'auto' }),
      }),
      signal,
    })
  }

  private _checkStatus(res: Response, requestId?: string, t0?: number): ChatResult | null {
    if (res.status === 429) {
      log('WARN', 'rate_limited', { request_id: requestId, elapsed_ms: t0 ? Date.now() - t0 : 0 })
      return { error: 'RATE_LIMITED' }
    }
    if (res.status === 401) {
      log('ERROR', 'invalid_api_key', { request_id: requestId })
      return { error: 'INVALID_KEY' }
    }
    if (!res.ok) {
      // 读取完整响应体以便定位 400 等错误的具体原因
      const elapsed = t0 ? Date.now() - t0 : 0
      this._readErrorBody(res, requestId, res.status, elapsed)
      return { error: `API_ERROR:${res.status}` }
    }
    return null
  }

  private async _readErrorBody(res: Response, requestId?: string, status?: number, elapsedMs?: number): Promise<void> {
    try {
      const body = await res.text()
      log('ERROR', 'llm_api_error_body', { request_id: requestId, status, elapsed_ms: elapsedMs, body: body.slice(0, 1000) })
      // 400 时 dump 消息链诊断
      if (status === 400) {
        this._dumpToolChain(this.lastSentMessages || [], requestId)
      }
    } catch {
      log('ERROR', 'llm_api_error', { request_id: requestId, status, elapsed_ms: elapsedMs })
    }
  }

  /** 发送前暂存 messages 快照，供错误诊断用 */
  private lastSentMessages: Message[] | null = null

  private _dumpToolChain(m: Message[], requestId?: string): void {
    let assCalls = 0,
      toolMsgs = 0,
      userMsgs = 0,
      orphanedCalls = 0
    const last20: string[] = []
    for (let i = 0; i < m.length; i++) {
      const msg = m[i]
      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        assCalls++
        // 判断是否有后续 tool 消息
        const nextTool = m.slice(i + 1).some((t) => t.role === 'tool')
        if (!nextTool) orphanedCalls++
      }
      if (msg.role === 'tool') toolMsgs++
      if (msg.role === 'user') userMsgs++
      if (i >= m.length - 20) {
        const preview = (msg.content || '').slice(0, 60).replace(/\n/g, ' ')
        const tc = msg.tool_calls?.length ? ` tc:[${msg.tool_calls.map((t) => t.function?.name).join(',')}]` : ''
        last20.push(`  [${i}] ${msg.role}${tc} ${preview}`)
      }
    }
    log('ERROR', 'llm_tool_chain_diag', {
      request_id: requestId,
      total_msgs: m.length,
      assistant_with_tool_calls: assCalls,
      tool_messages: toolMsgs,
      user_messages: userMsgs,
      orphaned_tool_call_blocks: orphanedCalls,
    })
    // dump last 20 messages
    log('ERROR', 'llm_last_20_msgs', { request_id: requestId, msgs: last20.join('\n') })
  }

  private async _readSSEStream(
    res: Response,
    onChunk: ChunkCallback,
    requestId?: string,
    t0?: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const reader = res.body?.getReader()
    if (!reader) throw new Error('no reader')

    const decoder = new TextDecoder()
    let full = ''
    let buffer = ''
    let hasFirstChunk = false

    while (true) {
      if (signal?.aborted) break
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const jsonStr = line.slice(6).trim()
        if (jsonStr === '[DONE]') break
        try {
          const parsed = JSON.parse(jsonStr) as { choices?: Array<{ delta: { content?: string } }> }
          const content = parsed.choices?.[0]?.delta?.content
          if (content) {
            if (!hasFirstChunk && t0) {
              hasFirstChunk = true
              log('PERF', 'time_to_first_token', { request_id: requestId, ms: Date.now() - t0 })
            }
            full += content
            onChunk(content)
          }
        } catch {
          /* skip parse errors */
        }
      }
    }
    return full
  }

  async chatWithTools(
    messages: Message[],
    requestId?: string,
    timeoutMs = 60000,
    onChunk?: ChunkCallback,
    externalSignal?: AbortSignal,
    allowedToolNames?: string[],
  ): Promise<{ reply?: string; toolCalls?: ToolCallInfo[]; error?: string }> {
    if (!this.codeApiKey) return { error: 'NO_KEY' }

    log('INFO', 'tool_llm_request', { request_id: requestId, model: this.codeModel })

    const t0 = Date.now()
    const promptLength = messages.reduce((s, m) => s + (m.content?.length || 0), 0)
    const rawPromptTokens = estimateTokens(JSON.stringify(messages))
    const tokenBreakdown = classifyMessageBreakdown(messages, estimateMessageTokens)
    let _evalInvoked = false

    // 429 / 网络错误 / API 错误重试：指数退避，最多 3 次
    const RETRYABLE = new Set(['RATE_LIMITED', 'NETWORK'])
    const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503]) // 400 不重试：invalid_request_error 是结构性错误
    for (let attempt = 1; attempt <= 3; attempt++) {
      // ★ 底层兜底：每次发请求前自动清理孤儿 tool_calls
      trimOrphanedToolCallsFrom(messages)
      // ★ 预检：清理后结构仍不完整则直接拒绝，避免浪费 API 调用
      const integrityCheck = validateToolCallChain(messages)
      if (!integrityCheck.valid) {
        log('ERROR', 'tool_call_chain_invalid', {
          request_id: requestId,
          issues: integrityCheck.issues.map((i) => i.description),
        })
        return { error: 'INVALID_REQUEST' }
      }
      // 保存快照供 400 诊断
      this.lastSentMessages = messages
      // 外部中止信号已触发，立即放弃当前请求
      if (externalSignal?.aborted) return { error: 'ABORTED' }

      const { controller, timer } = createTimeoutSignal(timeoutMs)
      // 合并外部 abort signal：使 evolution 的 abortSelfTask 可提前中断 HTTP fetch
      if (externalSignal && !externalSignal.aborted) {
        externalSignal.addEventListener('abort', () => controller.abort(), { once: true })
      }
      try {
        // Evaluation: model.invoked — 仅在实际发出 HTTP 请求前发射
        // NO_KEY / INVALID_REQUEST / ABORTED 等提前返回不会产生孤儿 invoked 事件
        if (!_evalInvoked) {
          _evalInvoked = true
          this.evaluationEmitter?.emit(
            'model.invoked',
            { type: 'model.invoked', modelName: this.codeModel, promptLength, promptTokens: rawPromptTokens, tokenBreakdown },
            { traceId: requestId },
          )
        }

        // 有 onChunk 回调时使用流式，边收 token 边喂给 TTS
        if (onChunk) {
          const result = await this._chatWithToolsStream(messages, requestId, t0, controller.signal, onChunk, allowedToolNames)
          if (result.error && RETRYABLE.has(result.error)) {
            if (attempt < 3) {
              const delay = Math.min(1000 * Math.pow(2, attempt - 1), 4000)
              log('WARN', 'rate_limit_retry', { request_id: requestId, attempt, delay_ms: delay })
              await new Promise((r) => setTimeout(r, delay))
              continue
            }
          }
          return this._emitModelCompleted(result, requestId, t0, rawPromptTokens)
        }

        const res = await this._doFetch(messages, false, controller.signal, this.codeModel, allowedToolNames)

        // 429 可重试
        if (res.status === 429) {
          log('WARN', 'rate_limited', { request_id: requestId, elapsed_ms: Date.now() - t0 })
          if (attempt < 3) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 4000)
            log('WARN', 'rate_limit_retry', { request_id: requestId, attempt, delay_ms: delay })
            await new Promise((r) => setTimeout(r, delay))
            continue
          }
          return this._emitModelError('RATE_LIMITED', Date.now() - t0, requestId, t0, rawPromptTokens)
        }

        // 400/500 系列服务端错误可重试（通常为 context 结构问题或临时故障）
        if (RETRYABLE_STATUS_CODES.has(res.status)) {
          log('WARN', 'llm_api_retry', { request_id: requestId, status: res.status, attempt })
          if (attempt < 3) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 4000)
            await new Promise((r) => setTimeout(r, delay))
            continue
          }
          const statusErr = this._checkStatus(res, requestId, t0)
          if (statusErr) return this._emitModelError(statusErr.error ?? 'API_ERROR', Date.now() - t0, requestId, t0, rawPromptTokens)
        }

        const statusErr = this._checkStatus(res, requestId, t0)
        if (statusErr) return this._emitModelError(statusErr.error ?? 'API_ERROR', Date.now() - t0, requestId, t0, rawPromptTokens)

        const data = (await res.json()) as {
          choices?: Array<{
            message: {
              content: string | null
              tool_calls?: Array<{
                id: string
                type: string
                function: { name: string; arguments: string }
              }>
            }
          }>
        }

        const result = this._parseToolResponse(data, messages, requestId, t0)
        return this._emitModelCompleted(result, requestId, t0, rawPromptTokens)
      } catch (err) {
        const elapsed = Date.now() - t0
        if (err instanceof DOMException && err.name === 'AbortError') {
          log('ERROR', 'tool_llm_timeout', { request_id: requestId, elapsed_ms: elapsed })
          return this._emitModelError('TIMEOUT', elapsed, requestId, t0, rawPromptTokens)
        }
        log('ERROR', 'tool_llm_network_error', { request_id: requestId, elapsed_ms: elapsed, error: String(err) })
        return this._emitModelError(String(err), elapsed, requestId, t0, rawPromptTokens)
      } finally {
        clearTimeout(timer)
      }
    }

    return this._emitModelError('RATE_LIMITED_EXHAUSTED', Date.now() - t0, requestId, t0, rawPromptTokens)
  }

  private _emitModelError(
    error: string,
    elapsed: number,
    requestId: string | undefined,
    t0: number,
    rawPromptTokens: number,
  ): { error: string } {
    const realElapsed = elapsed > 0 ? elapsed : Date.now() - t0
    this.evaluationEmitter?.emit(
      'model.completed',
      {
        type: 'model.completed',
        modelName: this.codeModel,
        durationMs: realElapsed,
        inputTokens: rawPromptTokens,
        outputTokens: 0,
        responseLength: 0,
        error,
      },
      { traceId: requestId },
    )
    return { error }
  }

  /**
   * 流式版 chatWithTools — 边接收 SSE token 边回调 onChunk，大幅降低首音延迟。
   */
  private async _chatWithToolsStream(
    messages: Message[],
    requestId: string | undefined,
    t0: number,
    signal: AbortSignal,
    onChunk: ChunkCallback,
    allowedToolNames?: string[],
  ): Promise<{ reply?: string; toolCalls?: ToolCallInfo[]; error?: string }> {
    // 发流式请求前清理孤儿 tool_calls（兜底，与 chatWithTools 入口处互补）
    trimOrphanedToolCallsFrom(messages)
    // 流式请求中同时携带 tools 声明，让 LLM 仍可选工具调用
    const tools = this._getFilteredSchemas(allowedToolNames)
    const res = await fetch(this.codeApiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.codeApiKey!}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.codeModel,
        messages,
        stream: true,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: 'auto',
      }),
      signal,
    })

    const statusErr = this._checkStatus(res, requestId, t0)
    if (statusErr) return statusErr

    const reader = res.body?.getReader()
    if (!reader) return { error: 'NETWORK' }

    const decoder = new TextDecoder()
    let full = ''
    let buffer = ''
    let hasFirstChunk = false
    // 流式 tool_calls 累积
    type StreamToolCall = { id: string; type: string; function: { name: string; arguments: string } }
    const toolCallsAcc: StreamToolCall[] = []
    let hasToolCalls = false

    while (true) {
      if (signal.aborted) break
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const jsonStr = line.slice(6).trim()
        if (jsonStr === '[DONE]') break
        try {
          const parsed = JSON.parse(jsonStr) as {
            choices?: Array<{
              delta: {
                content?: string
                tool_calls?: Array<{
                  index: number
                  id?: string
                  type?: string
                  function?: { name?: string; arguments?: string }
                }>
              }
            }>
          }
          const delta = parsed.choices?.[0]?.delta
          if (!delta) continue

          // 流式 tool_calls：增量累积
          if (delta.tool_calls) {
            hasToolCalls = true
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0
              if (!toolCallsAcc[idx]) {
                toolCallsAcc[idx] = { id: tc.id || '', type: tc.type || 'function', function: { name: '', arguments: '' } }
              }
              if (tc.id) toolCallsAcc[idx].id = tc.id
              if (tc.function?.name) toolCallsAcc[idx].function.name += tc.function.name
              if (tc.function?.arguments) toolCallsAcc[idx].function.arguments += tc.function.arguments
            }
            continue
          }

          // 普通文本 token
          if (delta.content) {
            if (!hasFirstChunk && t0) {
              hasFirstChunk = true
              log('PERF', 'time_to_first_token', { request_id: requestId, ms: Date.now() - t0 })
            }
            full += delta.content
            onChunk(delta.content)
          }
        } catch {
          /* skip parse errors */
        }
      }
    }

    const elapsed = Date.now() - t0

    if (hasToolCalls && toolCallsAcc.length > 0) {
      // 先验证所有 tool_calls 的 JSON 参数，只保留合法的
      const validToolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> = []
      const parsedToolCalls: ToolCallInfo[] = []
      for (const tc of toolCallsAcc) {
        let parsed: Record<string, any> = {}
        try {
          parsed = JSON.parse(tc.function.arguments)
          validToolCalls.push(tc)
          parsedToolCalls.push({ id: tc.id, name: tc.function.name, arguments: parsed })
        } catch (e) {
          log('WARN', 'tool_json_parse_failed', { tool: tc.function.name, arguments_raw: tc.function.arguments.slice(0, 200) })
          // 跳过无效 tool_call，不推入 context，避免 DeepSeek 400 校验错误
        }
      }

      if (validToolCalls.length > 0) {
        // 过滤空 id — 空 id 的 tool_calls 会导致 DeepSeek 400 ("insufficient tool messages")
        const sendableToolCalls = validToolCalls.filter((tc) => tc.id && tc.id.trim()).map((tc) => ({ ...tc, result: undefined }))
        if (sendableToolCalls.length > 0) {
          messages.push({
            role: 'assistant',
            content: full || '',
            tool_calls: sendableToolCalls,
          })
        } else {
          messages.push({ role: 'assistant', content: full || '（工具调用参数解析失败）' })
        }
      } else {
        messages.push({ role: 'assistant', content: full || '（工具调用参数解析失败）' })
      }

      log('INFO', 'tool_llm_tool_calls', {
        request_id: requestId,
        tools: parsedToolCalls.map((t) => t.name),
        duration_ms: elapsed,
        skipped: toolCallsAcc.length - validToolCalls.length,
      })
      const textReply = full.trim()
      if (textReply) {
        return { reply: textReply, toolCalls: parsedToolCalls.length > 0 ? parsedToolCalls : undefined }
      }
      return { toolCalls: parsedToolCalls.length > 0 ? parsedToolCalls : undefined }
    }

    const reply = full.trim()
    log('INFO', 'tool_llm_reply', { request_id: requestId, reply_len: reply.length, duration_ms: elapsed })
    return { reply }
  }

  private _parseToolResponse(
    data: {
      choices?: Array<{
        message: { content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> }
      }>
    },
    messages: Message[],
    requestId?: string,
    t0?: number,
  ): { reply?: string; toolCalls?: ToolCallInfo[]; error?: string } {
    const msg = data.choices?.[0]?.message
    if (!msg) return { error: 'EMPTY_RESPONSE' }

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      const textContent = msg.content ?? ''

      // 先验证所有 tool_calls 的 JSON 参数，只保留合法的
      const validToolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> = []
      const parsedToolCalls: ToolCallInfo[] = []
      for (const tc of msg.tool_calls) {
        let parsed: Record<string, any> = {}
        try {
          parsed = JSON.parse(tc.function.arguments)
          validToolCalls.push(tc)
          parsedToolCalls.push({ id: tc.id, name: tc.function.name, arguments: parsed })
        } catch (e) {
          log('WARN', 'tool_json_parse_failed', { tool: tc.function.name, arguments_raw: tc.function.arguments.slice(0, 200) })
          // 跳过无效 tool_call，不推入 context，避免 DeepSeek 400 校验错误
        }
      }

      // 有合法 tool_calls 时才推 assistant(tool_calls)
      // 过滤空 id — 空 id 的 tool_calls 会导致 DeepSeek 400 ("insufficient tool messages")
      const sendableToolCalls = validToolCalls.filter((tc) => tc.id && tc.id.trim()).map((tc) => ({ ...tc, result: undefined }))
      if (sendableToolCalls.length > 0) {
        messages.push({ role: 'assistant', content: textContent, tool_calls: sendableToolCalls })
      } else if (validToolCalls.length > 0) {
        // 全部因空 id 被过滤，回退为纯文本
        log('WARN', 'tool_calls_empty_id_filtered', { request_id: requestId, count: validToolCalls.length })
      } else {
        // 全部无效时回退为纯文本回复
        messages.push({ role: 'assistant', content: textContent || '（工具调用参数解析失败）' })
      }

      const elapsed = t0 ? Date.now() - t0 : 0
      log('INFO', 'tool_llm_tool_calls', {
        request_id: requestId,
        tools: parsedToolCalls.map((t) => t.name),
        duration_ms: elapsed,
        skipped: msg.tool_calls.length - validToolCalls.length,
      })
      return { toolCalls: parsedToolCalls.length > 0 ? parsedToolCalls : undefined }
    }

    const reply = msg.content?.trim() || ''
    const elapsed = t0 ? Date.now() - t0 : 0
    log('INFO', 'tool_llm_reply', { request_id: requestId, reply_len: reply.length, duration_ms: elapsed })
    return { reply }
  }

  /**
   * chatJson — 轻量级 LLM 调用，返回解析后的 JSON。
   * 用于不需要 tool_loop 的场景（Insight 分析、Creativity 生成等）。
   * 返回 { data: 解析后的 JSON } 或 { error: 错误信息 }。
   */
  async chatJson(
    userText: string,
    options?: {
      system?: string
      temperature?: number
      timeoutMs?: number
      requestId?: string
    },
  ): Promise<{ data?: any; error?: string }> {
    const key = this.textApiKey || this.chatApiKey
    if (!key) return { error: 'NO_KEY' }

    const system = options?.system || ''
    const temperature = options?.temperature ?? 0.3
    const timeoutMs = options?.timeoutMs ?? 60000
    const requestId = options?.requestId

    const { controller, timer } = createTimeoutSignal(timeoutMs)
    const t0 = Date.now()

    try {
      const res = await fetch(this.textApiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.textModel,
          messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: userText }],
          stream: false,
          temperature,
        }),
        signal: controller.signal,
      })

      if (!res.ok) return { error: `API_ERROR:${res.status}` }

      const data = (await res.json()) as { choices?: Array<{ message: { content: string } }> }
      const reply = data.choices?.[0]?.message?.content?.trim() || ''
      const elapsed = Date.now() - t0

      log('INFO', 'chat_json_done', { request_id: requestId, reply_len: reply.length, duration_ms: elapsed })

      // 尝试解析 JSON
      try {
        const parsed = JSON.parse(reply)
        return { data: parsed }
      } catch {
        // 如果直接解析失败，尝试从 markdown 代码围栏中提取 JSON
        const extracted = extractJsonFromLLMReply(reply)
        if (extracted) {
          try {
            const parsed = JSON.parse(extracted)
            log('INFO', 'chat_json_extracted_from_fences', { request_id: requestId })
            return { data: parsed }
          } catch {
            // 提取后仍然解析失败，回退到原始回复
          }
        }
        log('WARN', 'chat_json_parse_failed', { request_id: requestId, reply: reply.slice(0, 200) })
        return { data: reply }
      }
    } catch (err) {
      const elapsed = Date.now() - t0
      if (err instanceof DOMException && err.name === 'AbortError') {
        log('ERROR', 'chat_json_timeout', { request_id: requestId, elapsed_ms: elapsed })
        return { error: 'TIMEOUT' }
      }
      log('ERROR', 'chat_json_network_error', { request_id: requestId, elapsed_ms: elapsed, error: String(err) })
      return { error: 'NETWORK' }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * chatJsonWithCode — 使用 code 模型的轻量级 LLM 调用，返回解析后的 JSON。
   * 与 chatJson() 签名/返回一致，但路由到 LLM_CODE_API_URL + this.codeModel。
   * 用于需要更强模型能力的场景（创造力生成、复杂分析等）。
   */
  async chatJsonWithCode(
    userText: string,
    options?: {
      system?: string
      temperature?: number
      timeoutMs?: number
      requestId?: string
    },
  ): Promise<{ data?: any; error?: string }> {
    const key = this.codeApiKey || this.chatApiKey
    if (!key) return { error: 'NO_KEY' }

    const system = options?.system || ''
    const temperature = options?.temperature ?? 0.3
    const timeoutMs = options?.timeoutMs ?? 60000
    const requestId = options?.requestId

    const { controller, timer } = createTimeoutSignal(timeoutMs)
    const t0 = Date.now()

    try {
      const res = await fetch(this.codeApiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.codeModel,
          messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: userText }],
          stream: false,
          temperature,
        }),
        signal: controller.signal,
      })

      if (!res.ok) return { error: `API_ERROR:${res.status}` }

      const data = (await res.json()) as { choices?: Array<{ message: { content: string } }> }
      const reply = data.choices?.[0]?.message?.content?.trim() || ''
      const elapsed = Date.now() - t0

      log('INFO', 'chat_json_code_done', { request_id: requestId, reply_len: reply.length, duration_ms: elapsed })

      try {
        const parsed = JSON.parse(reply)
        return { data: parsed }
      } catch {
        const extracted = extractJsonFromLLMReply(reply)
        if (extracted) {
          try {
            const parsed = JSON.parse(extracted)
            log('INFO', 'chat_json_code_extracted_from_fences', { request_id: requestId })
            return { data: parsed }
          } catch {
            // fall through
          }
        }
        log('WARN', 'chat_json_code_parse_failed', { request_id: requestId, reply: reply.slice(0, 200) })
        return { data: reply }
      }
    } catch (err) {
      const elapsed = Date.now() - t0
      if (err instanceof DOMException && err.name === 'AbortError') {
        log('ERROR', 'chat_json_code_timeout', { request_id: requestId, elapsed_ms: elapsed })
        return { error: 'TIMEOUT' }
      }
      log('ERROR', 'chat_json_code_network_error', { request_id: requestId, elapsed_ms: elapsed, error: String(err) })
      return { error: 'NETWORK' }
    } finally {
      clearTimeout(timer)
    }
  }

  // ── 文本处理（摘要、提取、重写、分析等纯文本任务）──

  /**
   * Evaluation: 在 chatWithTools 的每个退出点发射 model.completed
   * （仅当确实发起了 API 调用，即已发出 model.invoked）
   */
  private _emitModelCompleted(
    result: { reply?: string; toolCalls?: ToolCallInfo[]; error?: string },
    requestId: string | undefined,
    t0: number,
    rawPromptTokens: number,
  ): typeof result {
    const elapsed = Date.now() - t0
    const replyLen = result.reply?.length ?? 0
    this.evaluationEmitter?.emit(
      'model.completed',
      {
        type: 'model.completed',
        modelName: this.codeModel,
        durationMs: elapsed,
        inputTokens: rawPromptTokens,
        outputTokens: Math.round(replyLen * 1.3),
        responseLength: replyLen,
        responsePreview: result.reply?.slice(0, 200),
        error: result.error,
      },
      { traceId: requestId },
    )
    return result
  }

  /**
   * chatText — 使用文本处理模型（text）进行纯文本任务，不携带 tools。
   * 适用于摘要、提取、重写、分析等场景，避免占用 code 模型的限额。
   */
  async chatText(
    userText: string,
    options?: {
      system?: string
      temperature?: number
      timeoutMs?: number
      requestId?: string
    },
  ): Promise<ChatResult> {
    const key = this.textApiKey || this.chatApiKey
    if (!key) return { error: 'NO_KEY' }

    const system = options?.system || ''
    const temperature = options?.temperature ?? 0.3
    const timeoutMs = options?.timeoutMs ?? 60000
    const requestId = options?.requestId
    const model = this.textModel

    const { controller, timer } = createTimeoutSignal(timeoutMs)
    const t0 = Date.now()

    log('INFO', 'text_llm_request', { request_id: requestId, model })

    try {
      const res = await fetch(this.textApiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: userText }],
          stream: false,
          temperature,
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const elapsed = Date.now() - t0
        log('WARN', 'text_llm_api_error', { request_id: requestId, status: res.status, elapsed_ms: elapsed })
        return { error: `API_ERROR:${res.status}` }
      }

      const data = (await res.json()) as { choices?: Array<{ message: { content: string } }> }
      const reply = data.choices?.[0]?.message?.content?.trim() || ''
      const elapsed = Date.now() - t0

      log('INFO', 'text_llm_done', { request_id: requestId, reply_len: reply.length, duration_ms: elapsed })
      return { reply }
    } catch (err) {
      const elapsed = Date.now() - t0
      if (err instanceof DOMException && err.name === 'AbortError') {
        log('ERROR', 'text_llm_timeout', { request_id: requestId, elapsed_ms: elapsed })
        return { error: 'TIMEOUT' }
      }
      log('ERROR', 'text_llm_network_error', { request_id: requestId, elapsed_ms: elapsed, error: String(err) })
      return { error: 'NETWORK' }
    } finally {
      clearTimeout(timer)
    }
  }

  // ── 视觉/多模态（图片理解）──

  /**
   * chatVision — 使用视觉模型处理图片理解任务。
   * messages 中的 user message content 应使用 OpenAI 多模态格式：
   *   [{ type: 'text', text: '描述这张图片' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }]
   */
  async chatVision(
    messages: Message[],
    options?: {
      system?: string
      temperature?: number
      timeoutMs?: number
      requestId?: string
    },
  ): Promise<ChatResult> {
    const key = this.visionKey || this.chatApiKey
    if (!key) return { error: 'NO_KEY' }

    const system = options?.system || ''
    const temperature = options?.temperature ?? 0.3
    const timeoutMs = options?.timeoutMs ?? 120000
    const requestId = options?.requestId
    const model = this.visionModel

    const { controller, timer } = createTimeoutSignal(timeoutMs)
    const t0 = Date.now()

    log('INFO', 'vision_llm_request', { request_id: requestId, model })

    try {
      const res = await fetch(this.visionApiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
          stream: false,
          temperature,
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const elapsed = Date.now() - t0
        log('WARN', 'vision_llm_api_error', { request_id: requestId, status: res.status, elapsed_ms: elapsed })
        return { error: `API_ERROR:${res.status}` }
      }

      const data = (await res.json()) as { choices?: Array<{ message: { content: string } }> }
      const reply = data.choices?.[0]?.message?.content?.trim() || ''
      const elapsed = Date.now() - t0

      log('INFO', 'vision_llm_done', { request_id: requestId, reply_len: reply.length, duration_ms: elapsed })
      return { reply }
    } catch (err) {
      const elapsed = Date.now() - t0
      if (err instanceof DOMException && err.name === 'AbortError') {
        log('ERROR', 'vision_llm_timeout', { request_id: requestId, elapsed_ms: elapsed })
        return { error: 'TIMEOUT' }
      }
      log('ERROR', 'vision_llm_network_error', { request_id: requestId, elapsed_ms: elapsed, error: String(err) })
      return { error: 'NETWORK' }
    } finally {
      clearTimeout(timer)
    }
  }
}
