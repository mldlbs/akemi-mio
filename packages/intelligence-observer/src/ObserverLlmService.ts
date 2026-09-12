import { log } from '@akemi-mio/core/logger/Logger'

export interface ObserverGenerateOptions {
  system?: string
  temperature?: number
  maxTokens?: number
}

const OLLAMA_BASE = process.env.OBSERVER_OLLAMA_URL || 'http://localhost:11434'
const OLLAMA_MODEL = process.env.OBSERVER_MODEL || 'qwen2.5:7b'

/**
 * ObserverLlmService — 通过 Ollama REST API 调 Qwen2.5-7B
 *
 * 假设本地已装 Ollama 且有 qwen2.5:7b 模型。
 * 不需要安装任何 npm 包。
 */
export class ObserverLlmService {
  private loaded = false

  get isLoaded(): boolean {
    return this.loaded
  }

  async initialize(): Promise<void> {
    try {
      log('INFO', 'observer_llm_check_ollama', { url: OLLAMA_BASE, model: OLLAMA_MODEL })
      const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) throw new Error(`Ollama 服务返回 ${res.status}`)

      const data = (await res.json()) as { models?: { name: string }[] }
      const hasModel = data.models?.some((m) => m.name.startsWith('qwen2.5'))
      if (!hasModel) {
        log('WARN', 'observer_llm_model_not_found', {
          model: OLLAMA_MODEL,
          available: data.models?.map((m) => m.name).join(', '),
        })
        return
      }

      this.loaded = true
      log('INFO', 'observer_llm_ready', { model: OLLAMA_MODEL, url: OLLAMA_BASE })
    } catch (err: any) {
      log('WARN', 'observer_llm_connect_failed', { error: err.message, hint: '请确认 Ollama 正在运行' })
    }
  }

  async generate(prompt: string, options?: ObserverGenerateOptions): Promise<{ data?: string; error?: string }> {
    if (!this.loaded) await this.initialize()
    if (!this.loaded) {
      return { error: 'Ollama 不可用或模型未加载' }
    }

    try {
      const messages: { role: string; content: string }[] = []
      if (options?.system) messages.push({ role: 'system', content: options.system })
      messages.push({ role: 'user', content: prompt })

      const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages,
          stream: false,
          options: {
            temperature: options?.temperature ?? 0.7,
            num_predict: options?.maxTokens ?? 2048,
            top_p: 0.9,
          },
        }),
        signal: AbortSignal.timeout(120000),
      })

      if (!res.ok) {
        const text = await res.text()
        return { error: `Ollama 错误 (${res.status}): ${text.slice(0, 200)}` }
      }

      const data = (await res.json()) as { message?: { content: string } }
      return { data: data.message?.content || '' }
    } catch (err: any) {
      return { error: `生成失败: ${err.message}` }
    }
  }

  async generateJson<T>(prompt: string, options?: ObserverGenerateOptions): Promise<{ data?: T; error?: string }> {
    const result = await this.generate(prompt, {
      ...options,
      temperature: options?.temperature ?? 0.1,
      maxTokens: options?.maxTokens ?? 4096,
    })
    if (result.error) return result as any

    try {
      return { data: JSON.parse(result.data!) as T }
    } catch {
      const match = result.data!.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (match) {
        try {
          return { data: JSON.parse(match[1].trim()) as T }
        } catch {}
      }
      return { data: result.data as any }
    }
  }

  dispose(): void {
    this.loaded = false
  }
}
