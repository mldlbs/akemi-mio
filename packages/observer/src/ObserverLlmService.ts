import { log } from './logger'

export interface ObserverGenerateOptions {
  system?: string
  temperature?: number
  maxTokens?: number
}

/**
 * LLM connection settings for the observer pipeline.
 *
 * The observer package stays config-source agnostic: it accepts an explicit
 * `ObserverLlmConfig` and otherwise falls back to environment variables. The
 * host (mio-cli) reads config.json and passes the resolved values in, so the
 * observer uses the same model as the rest of Mio (creativity / insight)
 * instead of a hardcoded local Ollama. This is what D2 was about: the observer
 * ran on its own LLM path and ignored `mio config llm`.
 */
export interface ObserverLlmConfig {
  /** OpenAI-compatible `/chat/completions` endpoint, or an Ollama base URL. */
  apiUrl?: string
  /** Bearer token. Empty means unauthenticated (common for local servers). */
  apiKey?: string
  /** Model id. */
  model?: string
  /** Override provider inference. Defaults to `auto`. */
  provider?: 'auto' | 'openai' | 'ollama'
}

/** Resolved, ready-to-use settings plus what a host can display. */
export interface ObserverLlmInfo {
  provider: 'openai' | 'ollama'
  model: string
  apiUrl: string
  hasApiKey: boolean
}

interface ResolvedLlmConfig {
  provider: 'openai' | 'ollama'
  /** Fully formed request URL for the chat call. */
  requestUrl: string
  /** Ollama base with no trailing `/api`. Only set for the ollama provider. */
  baseUrl?: string
  apiKey: string
  model: string
}

const DEFAULT_OLLAMA_URL = 'http://localhost:11434'
const DEFAULT_OLLAMA_MODEL = 'qwen2.5:7b'

// Provider inference. An explicit `openai`/`ollama` wins; otherwise the URL
// shape decides. `/chat/completions` (opencode zen, deepseek, any
// OpenAI-compatible gateway) is openai; `/api/chat` and a bare host:port are
// Ollama. A trailing `/v1` is treated as an OpenAI base so
// `https://host/v1` still resolves -- requestUrl appends the path below.
function inferProvider(apiUrl: string, explicit?: string): 'openai' | 'ollama' {
  if (explicit === 'openai' || explicit === 'ollama') return explicit
  if (/\/chat\/completions\b/.test(apiUrl)) return 'openai'
  if (/\/api\/chat\b/.test(apiUrl)) return 'ollama'
  if (/\/v1\/?$/.test(apiUrl)) return 'openai'
  return 'ollama'
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

// Explicit config > generic LLM_* env (shared with server/llm-client.js) >
// observer-specific env (legacy) > built-in Ollama default. The legacy
// OBSERVER_OLLAMA_URL / OBSERVER_MODEL names keep working so existing setups do
// not break, but anything the host passes in wins.
function resolveConfig(explicit?: ObserverLlmConfig): ResolvedLlmConfig {
  const apiUrl =
    explicit?.apiUrl ||
    process.env.LLM_API_URL ||
    process.env.OBSERVER_LLM_API_URL ||
    process.env.OBSERVER_OLLAMA_URL ||
    DEFAULT_OLLAMA_URL
  const apiKey = explicit?.apiKey ?? process.env.LLM_KEY ?? ''
  const model =
    explicit?.model ||
    process.env.LLM_CHAT_MODEL ||
    process.env.LLM_MODEL ||
    process.env.OBSERVER_MODEL ||
    DEFAULT_OLLAMA_MODEL
  const provider = inferProvider(apiUrl, explicit?.provider || process.env.OBSERVER_LLM_PROVIDER)

  if (provider === 'openai') {
    const base = stripTrailingSlash(apiUrl)
    return {
      provider,
      requestUrl: /\/chat\/completions\b/.test(base) ? base : `${base}/chat/completions`,
      apiKey,
      model,
    }
  }

  const baseUrl = stripTrailingSlash(apiUrl).replace(/\/api\/chat$/, '')
  return { provider, requestUrl: `${baseUrl}/api/chat`, baseUrl, apiKey, model }
}

/**
 * ObserverLlmService — LLM client for the observer pipeline.
 *
 * Two transports, chosen by URL shape: an OpenAI-compatible
 * `/chat/completions` endpoint, or a local Ollama (`/api/chat`). No npm
 * dependency either way. A host that has already resolved the model
 * configuration (mio-cli) passes it to the constructor; standalone callers get
 * the environment-variable fallback and the previous Ollama default.
 */
export class ObserverLlmService {
  private loaded = false
  private readonly config: ResolvedLlmConfig

  constructor(config?: ObserverLlmConfig) {
    this.config = resolveConfig(config)
  }

  get isLoaded(): boolean {
    return this.loaded
  }

  /** Resolved transport + model, for host diagnostics and dry runs. */
  getInfo(): ObserverLlmInfo {
    return {
      provider: this.config.provider,
      model: this.config.model,
      apiUrl: this.config.requestUrl,
      hasApiKey: Boolean(this.config.apiKey),
    }
  }

  async initialize(): Promise<void> {
    // An OpenAI-compatible endpoint has no cheap, universal health probe
    // (listing models needs auth and is not always implemented), so we mark it
    // ready optimistically and let generate() surface a real error. This
    // matches server/llm-client.js, which also does no preflight. Ollama keeps
    // its /api/tags check because its failure mode was the empty-shell output
    // D2 described.
    if (this.config.provider === 'openai') {
      this.loaded = true
      log('INFO', 'observer_llm_ready', {
        provider: 'openai',
        model: this.config.model,
        url: this.config.requestUrl,
      })
      return
    }

    try {
      log('INFO', 'observer_llm_check_ollama', { url: this.config.baseUrl, model: this.config.model })
      const res = await fetch(`${this.config.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) throw new Error(`Ollama 服务返回 ${res.status}`)

      const data = (await res.json()) as { models?: { name: string }[] }
      const wanted = this.config.model
      const baseName = wanted.split(':')[0]
      const hasModel = data.models?.some((m) => m.name === wanted || m.name.startsWith(baseName))
      if (!hasModel) {
        log('WARN', 'observer_llm_model_not_found', {
          model: wanted,
          available: data.models?.map((m) => m.name).join(', '),
        })
        return
      }

      this.loaded = true
      log('INFO', 'observer_llm_ready', { model: wanted, url: this.config.baseUrl })
    } catch (err: any) {
      log('WARN', 'observer_llm_connect_failed', {
        error: err.message,
        hint: '请确认 Ollama 正在运行，或通过 ObserverLlmConfig 指向兼容 OpenAI 的端点',
      })
    }
  }

  async generate(prompt: string, options?: ObserverGenerateOptions): Promise<{ data?: string; error?: string }> {
    if (!this.loaded) await this.initialize()
    if (!this.loaded) {
      return { error: 'LLM 不可用：Ollama 未运行或模型未加载' }
    }

    const messages: { role: string; content: string }[] = []
    if (options?.system) messages.push({ role: 'system', content: options.system })
    messages.push({ role: 'user', content: prompt })
    const temperature = options?.temperature ?? 0.7
    const maxTokens = options?.maxTokens ?? 2048

    try {
      if (this.config.provider === 'openai') {
        const res = await fetch(this.config.requestUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: this.config.model,
            messages,
            temperature,
            max_tokens: maxTokens,
            stream: false,
          }),
          signal: AbortSignal.timeout(120000),
        })

        if (!res.ok) {
          const text = await res.text()
          return { error: `LLM 错误 (${res.status}): ${text.slice(0, 200)}` }
        }

        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
        return { data: data.choices?.[0]?.message?.content || '' }
      }

      const res = await fetch(this.config.requestUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          stream: false,
          options: {
            temperature,
            num_predict: maxTokens,
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
