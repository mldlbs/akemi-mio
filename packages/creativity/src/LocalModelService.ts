import { resolve } from 'path'
import { existsSync } from 'fs'
import { log } from '@akemi-mio/core/logger/Logger'

/**
 * LocalModelService — 用 transformers.js 在进程内跑小模型
 *
 * 零外部依赖，进程内运行，不需要 Ollama/Python/独立服务。
 * 懒加载，优先加载项目目录下的模型文件（models/Xenova/...），
 * 不存在则从 HuggingFace 下载。
 *
 * 已下载模型位置：
 *   models/Xenova/Qwen2.5-0.5B-Instruct/
 *
 * 环境变量：
 *   LOCAL_HYPOTHESIS_MODEL   — 模型 ID (默认 Xenova/Qwen2.5-0.5B-Instruct)
 *   LOCAL_HYPOTHESIS_DISABLED — 设为 'true' 禁用本地模型
 *   MODEL_CACHE_DIR           — 缓存目录，缺省自动探测
 */
export class LocalModelService {
  private generator: any = null
  private loadAttempted = false
  private modelId: string

  constructor(modelId?: string) {
    this.modelId = modelId || process.env.LOCAL_HYPOTHESIS_MODEL || 'Xenova/Qwen2.5-0.5B-Instruct'
  }

  get isEnabled(): boolean {
    return process.env.LOCAL_HYPOTHESIS_DISABLED !== 'true'
  }

  get isLoaded(): boolean {
    return this.generator !== null
  }

  /**
   * 生成文本 — 兼容 chatJson 接口格式
   */
  async generate(
    userText: string,
    options?: { system?: string; temperature?: number; maxTokens?: number },
  ): Promise<{ data?: any; error?: string }> {
    if (!this.isEnabled) {
      return { error: 'local model disabled by env' }
    }

    // 测试环境下跳过实际模型加载
    if (process.env.VITEST || process.env.NODE_ENV === 'test') {
      return { error: 'local model disabled in test environment' }
    }

    // 懒加载模型
    if (!this.generator) {
      if (this.loadAttempted) return { error: 'model previously failed to load' }
      this.loadAttempted = true

      try {
        log('INFO', 'local_model_loading', { model: this.modelId })
        const { pipeline, env } = await import('@xenova/transformers')

        // 优先使用项目目录下的本地模型
        const modelsDir = await resolveModelsDir()
        const localModelPath = resolve(modelsDir, this.modelId)
        const hasLocalFiles = existsSync(localModelPath)

        if (hasLocalFiles) {
          env.localModelPath = modelsDir
          log('INFO', 'local_model_use_cache', { path: localModelPath })
        } else {
          log('INFO', 'local_model_no_cache', { path: localModelPath })
        }

        this.generator = await pipeline('text-generation', this.modelId, {
          cache_dir: process.env.MODEL_CACHE_DIR,
        })
        log('INFO', 'local_model_loaded', { model: this.modelId, local: hasLocalFiles })
      } catch (err: any) {
        log('WARN', 'local_model_load_failed', { model: this.modelId, error: err.message })
        this.generator = null
        return { error: `local model load failed: ${err.message}` }
      }
    }

    // 构造 prompts
    const systemMsg = options?.system || ''
    const chatTemplate = systemMsg
      ? `<|im_start|>system\n${systemMsg}<|im_end|>\n<|im_start|>user\n${userText}<|im_end|>\n<|im_start|>assistant\n`
      : `<|im_start|>user\n${userText}<|im_end|>\n<|im_start|>assistant\n`

    try {
      const result = await this.generator(chatTemplate, {
        max_new_tokens: options?.maxTokens || 768,
        temperature: options?.temperature ?? 0.7,
        do_sample: true,
      })

      const rawText = Array.isArray(result) ? result[0]?.generated_text : result?.generated_text
      if (!rawText) return { error: 'empty generation' }

      // 去掉输入部分，只取生成的文本
      const generated = rawText.slice(chatTemplate.length).trim()

      // 尝试解析 JSON
      const parsed = this.tryParse(generated)
      if (parsed) {
        return { data: parsed }
      }

      return { error: `generated non-JSON: ${generated.slice(0, 100)}` }
    } catch (err: any) {
      log('WARN', 'local_model_generation_error', { error: err.message })
      return { error: `generation failed: ${err.message}` }
    }
  }

  /**
   * 尝试从生成文本中提取 JSON
   */
  private tryParse(text: string): any {
    try {
      return JSON.parse(text)
    } catch {
      const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (match) {
        try {
          return JSON.parse(match[1].trim())
        } catch {
          // ignore
        }
      }
      const arrMatch = text.match(/\[[\s\S]*\]/)
      if (arrMatch) {
        try {
          return JSON.parse(arrMatch[0])
        } catch {
          // ignore
        }
      }
    }
    return null
  }
}

/** 自动探测项目 models 目录 */
async function resolveModelsDir(): Promise<string> {
  // Electron 环境
  try {
    const { app } = await import('electron')
    // 优先项目目录（dev），回退到 userData/models（安装版）
    if (existsSync(resolve(app.getAppPath(), 'models'))) {
      return resolve(app.getAppPath(), 'models')
    }
    return resolve(app.getPath('userData'), 'models')
  } catch {
    // not in Electron
  }

  // Node.js 开发环境：逐级向上找 models/
  let dir = process.cwd()
  for (let i = 0; i < 5; i++) {
    const p = resolve(dir, 'models')
    if (existsSync(p)) return p
    const parent = resolve(dir, '@akemi-mio/main')
    if (parent === dir) break
    dir = parent
  }

  // fallback: CWD/models
  return resolve(process.cwd(), 'models')
}

