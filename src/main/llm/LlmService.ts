import { log } from '../logger/Logger'
import { ConversationContext, estimateTokens, getBasePromptTokens } from '../agent/context'
import { ChatResult, ChunkCallback } from './types'
import { INTENT_CLASSIFY_PROMPT } from '../agent/intent/types'

const API_URL = 'https://openrouter.ai/api/v1/chat/completions'

export class LlmService {
  private apiKey: string | null = null
  private apiModel = 'deepseek/deepseek-chat'

  setConfig(key: string, model?: string): void {
    this.apiKey = key
    if (model) this.apiModel = model
  }

  async classifyIntent(userText: string, requestId?: string): Promise<ChatResult> {
    if (!this.apiKey) return { error: 'NO_KEY' }

    log('INFO', 'intent_classify_start', { request_id: requestId, text: userText })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    const t0 = Date.now()

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.apiModel,
          messages: [
            { role: 'system', content: INTENT_CLASSIFY_PROMPT },
            { role: 'user', content: userText }
          ],
          stream: false,
          temperature: 0.1
        }),
        signal: controller.signal
      })

      if (!res.ok) return { error: `API_ERROR:${res.status}` }

      const data = await res.json() as { choices?: Array<{ message: { content: string } }> }
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
    timeoutMs = 30000
  ): Promise<ChatResult> {
    if (!this.apiKey) return { error: 'NO_KEY' }

    const systemTokens = getBasePromptTokens()
    const messages = context.getMessages()
    const promptTokens = systemTokens + estimateTokens(userText) +
      messages.slice(1).reduce((s, m) => s + estimateTokens(m.content), 0)

    log('CHAT', 'user_prompt', { request_id: requestId, text: userText, tokens: promptTokens })

    context.addUser(userText)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const t0 = Date.now()

    try {
      log('INFO', 'llm_request', { request_id: requestId, model: this.apiModel, prompt_tokens: promptTokens })
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.apiModel,
          messages: context.getMessages(),
          stream: true
        }),
        signal: controller.signal
      })

      if (res.status === 429) {
        log('WARN', 'rate_limited', { request_id: requestId, elapsed_ms: Date.now() - t0 })
        return { error: 'RATE_LIMITED' }
      }
      if (res.status === 401) {
        log('ERROR', 'invalid_api_key', { request_id: requestId })
        return { error: 'INVALID_KEY' }
      }
      if (!res.ok) {
        log('ERROR', 'llm_api_error', { request_id: requestId, status: res.status, elapsed_ms: Date.now() - t0 })
        return { error: `API_ERROR:${res.status}` }
      }

      const reader = res.body?.getReader()
      if (!reader) return { error: 'NETWORK' }

      const decoder = new TextDecoder()
      let full = ''
      let buffer = ''
      let hasFirstChunk = false

      while (true) {
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
              choices?: Array<{ delta: { content?: string } }>
            }
            const content = parsed.choices?.[0]?.delta?.content
            if (content) {
              if (!hasFirstChunk) {
                hasFirstChunk = true
                log('PERF', 'time_to_first_token', { request_id: requestId, ms: Date.now() - t0 })
              }
              full += content
              onChunk(content)
            }
          } catch { /* skip parse errors */ }
        }
      }

      const elapsed = Date.now() - t0
      const outputTokens = estimateTokens(full)
      log('CHAT', 'llm_response', { request_id: requestId, text: full, duration_ms: elapsed, token_count: outputTokens })
      log('PERF', 'llm_inference', { request_id: requestId, duration_ms: elapsed, prompt_tokens: promptTokens, output_tokens: outputTokens })

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
}
