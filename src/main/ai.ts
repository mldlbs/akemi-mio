import { log } from './logger'

interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

const SYSTEM_PROMPT = '你是秋山澪（Mio Akiyama），一个温柔可爱的日本女高中生，擅长弹贝斯和音乐。你正在和主人聊天。输出规则：只说台词本身，禁止使用任何星号、括号、方括号、波浪线来描述动作或语气，禁止使用表情符号，禁止使用省略号或破折号开头。永远用中文简短回复。'
const MAX_CONTEXT = 20
let context: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }]
let apiKey: string | null = null
let apiModel = 'deepseek/deepseek-chat'

const API_URL = 'https://openrouter.ai/api/v1/chat/completions'

export function setConfig(key: string, model?: string) {
  apiKey = key
  if (model) apiModel = model
}

export function clearContext() {
  context = [{ role: 'system', content: SYSTEM_PROMPT }]
  log('INFO', 'context_cleared')
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2)
}

export async function chatStream(
  userText: string,
  onChunk: (text: string) => void,
  timeoutMs = 30000
): Promise<{ reply?: string; error?: string }> {
  if (!apiKey) {
    return { error: 'NO_KEY' }
  }

  const promptTokens = estimateTokens(SYSTEM_PROMPT) + estimateTokens(userText) +
    context.slice(1).reduce((s, m) => s + estimateTokens(m.content), 0)
  log('INFO', 'user_prompt', { text: userText, tokens: promptTokens })

  context.push({ role: 'user', content: userText })
  if (context.length - 1 > MAX_CONTEXT) {
    const trimmed = context.length - 1 - MAX_CONTEXT
    context = [context[0], ...context.slice(context.length - MAX_CONTEXT)]
    log('INFO', 'context_trimmed', { removed: trimmed })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const t0 = Date.now()

  try {
    log('INFO', 'llm_request_start', { model: apiModel })
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: apiModel,
        messages: context,
        stream: true
      }),
      signal: controller.signal
    })

    if (res.status === 429) {
      log('WARN', 'rate_limited', { elapsed_ms: Date.now() - t0 })
      return { error: 'RATE_LIMITED' }
    }
    if (res.status === 401) {
      log('ERROR', 'invalid_api_key')
      return { error: 'INVALID_KEY' }
    }
    if (!res.ok) {
      log('ERROR', 'llm_api_error', { status: res.status, elapsed_ms: Date.now() - t0 })
      return { error: `API_ERROR:${res.status}` }
    }

    const reader = res.body?.getReader()
    if (!reader) return { error: 'NETWORK' }

    const decoder = new TextDecoder()
    let full = ''
    let buffer = ''
    const firstChunkT = Date.now()
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
              log('PERF', 'time_to_first_token', { ms: Date.now() - firstChunkT })
            }
            full += content
            onChunk(content)
          }
        } catch { /* skip parse errors */ }
      }
    }

    const elapsed = Date.now() - t0
    const outputTokens = estimateTokens(full)
    log('INFO', 'llm_response', { text: full, duration_ms: elapsed, token_count: outputTokens })
    log('PERF', 'llm_inference', { duration_ms: elapsed, prompt_tokens: promptTokens, output_tokens: outputTokens })

    context.push({ role: 'assistant', content: full })
    return { reply: full }
  } catch (err) {
    const elapsed = Date.now() - t0
    if (err instanceof DOMException && err.name === 'AbortError') {
      log('ERROR', 'llm_timeout', { elapsed_ms: elapsed })
      return { error: 'TIMEOUT' }
    }
    log('ERROR', 'llm_network_error', { elapsed_ms: elapsed, error: String(err) })
    return { error: 'NETWORK' }
  } finally {
    clearTimeout(timer)
  }
}
