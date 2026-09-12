/**
 * PhrasePregenService — PiperTTS 高频短语预生成
 *
 * ── 职责 ──
 *
 * 在系统初始化时预生成常用高频短语（问候、确认等）的 Piper 合成结果，
 * 存入 TtsCache，使 Agent 调用这些短语时可零延迟直接从缓存返回。
 *
 * ── 短语分类 ──
 *
 *   greeting:  问候语（你好、早上好、晚上好等）
 *   confirmation: 确认语（好的、明白了、收到等）
 *   apology:   道歉语（抱歉、不好意思等）
 *   prompt:    提示语（请说、请稍等、请选择等）
 *   farewell:  告别语（再见、下次见等）
 *
 * ── 触发时机 ──
 *
 *   - 初始化时（initialize() 在 AppRuntime 启动时调用）
 *   - ModelScheduler 切换模型后（需要重新预生成）
 *   - Piper 模型变更后
 *   - 手动触发 refresh()
 *
 * ── 生命周期 ──
 *
 *   预生成的缓存有过期时间（默认 7 天），到期后下次访问时自动重新生成。
 *   但初始化时只生成缓存中没有的短语，已有缓存的跳过。
 *
 * ── 集成点 ──
 *
 *   - TtsCache: 存储预生成结果
 *   - PiperOrchestrator: 执行实际合成
 *   - TtsService: 通过 TtsScheduler 调用，透明使用缓存
 *   - ModelScheduler: 模型切换时触发重新预生成
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { piperOrchestrator, DEFAULT_PIPER_MODEL } from './PiperOrchestrator'
import { ttsCache } from './TtsCache'

// ══════════════════════════════════════════
//  短语定义
// ══════════════════════════════════════════

/** 短语类别 */
export type PhraseCategory = 'greeting' | 'confirmation' | 'apology' | 'prompt' | 'farewell'

/** 预生成短语条目 */
export interface PregenPhrase {
  /** 短语文本 */
  text: string
  /** 情感标签（用于缓存键） */
  emotionLabel: string
  /** 短语类别 */
  category: PhraseCategory
  /** 描述 */
  description: string
}

/** 所有预生成短语列表 */
export const PHRASES: PregenPhrase[] = [
  // ── Greeting 问候 ──
  { text: '你好', emotionLabel: '问候/日常', category: 'greeting', description: '基础问候' },
  { text: '你好啊', emotionLabel: '问候/亲切', category: 'greeting', description: '亲切问候' },
  { text: '早上好', emotionLabel: '问候/晨间', category: 'greeting', description: '早晨问候' },
  { text: '下午好', emotionLabel: '问候/午后', category: 'greeting', description: '午后问候' },
  { text: '晚上好', emotionLabel: '问候/晚间', category: 'greeting', description: '晚间问候' },
  { text: '欢迎', emotionLabel: '问候/日常', category: 'greeting', description: '欢迎语' },

  // ── Confirmation 确认 ──
  { text: '好的', emotionLabel: '确认/日常', category: 'confirmation', description: '基础确认' },
  { text: '明白了', emotionLabel: '确认/日常', category: 'confirmation', description: '明白确认' },
  { text: '收到', emotionLabel: '确认/日常', category: 'confirmation', description: '收到确认' },
  { text: '没问题', emotionLabel: '确认/积极', category: 'confirmation', description: '没问题确认' },
  { text: '可以', emotionLabel: '确认/日常', category: 'confirmation', description: '可以确认' },
  { text: '好的，马上处理', emotionLabel: '确认/积极', category: 'confirmation', description: '快速响应确认' },

  // ── Apology 道歉 ──
  { text: '抱歉', emotionLabel: '道歉/日常', category: 'apology', description: '基础道歉' },
  { text: '不好意思', emotionLabel: '道歉/日常', category: 'apology', description: '歉意表达' },
  { text: '对不起', emotionLabel: '道歉/正式', category: 'apology', description: '正式道歉' },

  // ── Prompt 提示 ──
  { text: '请说', emotionLabel: '提示/日常', category: 'prompt', description: '请说话提示' },
  { text: '请稍等', emotionLabel: '提示/日常', category: 'prompt', description: '请等待提示' },
  { text: '请选择', emotionLabel: '提示/日常', category: 'prompt', description: '请选择提示' },
  { text: '请再说一遍', emotionLabel: '提示/日常', category: 'prompt', description: '重复请求' },
  { text: '请稍候', emotionLabel: '提示/正式', category: 'prompt', description: '正式等待提示' },

  // ── Farewell 告别 ──
  { text: '再见', emotionLabel: '告别/日常', category: 'farewell', description: '基础告别' },
  { text: '下次见', emotionLabel: '告别/日常', category: 'farewell', description: '期待下次' },
  { text: '明天见', emotionLabel: '告别/亲切', category: 'farewell', description: '明天告别' },
  { text: '先这样', emotionLabel: '告别/日常', category: 'farewell', description: '结语告别' },
]

// ══════════════════════════════════════════
//  PhrasePregenService
// ══════════════════════════════════════════

export interface PhrasePregenConfig {
  /** 是否启用预生成 */
  enabled: boolean
  /** 预生成的 Piper 模型 */
  piperModel: string
  /** 预生成并发数 */
  concurrency: number
  /** 缓存过期时间（毫秒），默认 7 天 */
  cacheMaxAgeMs: number
}

export const DEFAULT_PHRASE_PREGEN_CONFIG: PhrasePregenConfig = {
  enabled: true,
  piperModel: DEFAULT_PIPER_MODEL,
  concurrency: 2,
  cacheMaxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 天
}

export class PhrasePregenService {
  private config: PhrasePregenConfig
  private initialized = false
  private pregenPromise: Promise<void> | null = null
  /** 已预生成的短语数量 */
  private pregeneratedCount = 0

  constructor(config?: Partial<PhrasePregenConfig>) {
    this.config = { ...DEFAULT_PHRASE_PREGEN_CONFIG, ...config }
  }

  /**
   * 初始化并启动预生成。
   * @param piperModel 可选的 Piper 模型覆盖
   */
  async initialize(piperModel?: string): Promise<void> {
    if (this.initialized) return
    this.initialized = true

    if (piperModel) {
      this.config.piperModel = piperModel
    }

    if (!this.config.enabled) {
      log('INFO', 'phrase_pregen_disabled')
      return
    }

    // 后台启动预生成（不阻塞初始化流程）
    this.pregenPromise = this.runPregen()
    try {
      await this.pregenPromise
    } catch (err) {
      log('WARN', 'phrase_pregen_init_failed', { error: String(err) })
    }
  }

  /**
   * 强制刷新所有预生成短语。
   * 在模型切换后调用。
   */
  async refresh(piperModel?: string): Promise<void> {
    if (piperModel) {
      this.config.piperModel = piperModel
    }

    // 清除旧的预生成缓存
    for (const phrase of PHRASES) {
      const key = ttsCache.buildKey(phrase.text, phrase.emotionLabel)
      ttsCache.removeEntry(key)
    }

    this.pregenPromise = this.runPregen()
    await this.pregenPromise
  }

  /**
   * 获取已预生成的短语数量。
   */
  getPregenCount(): number {
    return this.pregeneratedCount
  }

  /**
   * 获取所有短语列表（供调试/UI 展示）。
   */
  getPhrases(): PregenPhrase[] {
    return [...PHRASES]
  }

  /**
   * 获取配置。
   */
  getConfig(): PhrasePregenConfig {
    return { ...this.config }
  }

  /**
   * 启用/禁用。
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled
    log('INFO', 'phrase_pregen_enabled_changed', { enabled })
  }

  // ══════════════════════════════════════════
  //  内部方法
  // ══════════════════════════════════════════

  /**
   * 执行预生成任务。
   * 跳过已有缓存的短语，仅为缺失的短语执行 Piper 合成。
   */
  private async runPregen(): Promise<void> {
    log('INFO', 'phrase_pregen_starting', {
      totalPhrases: PHRASES.length,
      model: this.config.piperModel,
    })

    // 找出未缓存的短语
    const missing: PregenPhrase[] = []
    let cachedCount = 0

    for (const phrase of PHRASES) {
      const cached = ttsCache.checkCache(phrase.text, phrase.emotionLabel)
      if (cached) {
        cachedCount++
      } else {
        missing.push(phrase)
      }
    }

    if (missing.length === 0) {
      this.pregeneratedCount = cachedCount
      log('INFO', 'phrase_pregen_all_cached', { count: cachedCount })
      return
    }

    log('INFO', 'phrase_pregen_missing', {
      missing: missing.length,
      cached: cachedCount,
    })

    // 分批并发生成
    const batches: PregenPhrase[][] = []
    for (let i = 0; i < missing.length; i += this.config.concurrency) {
      batches.push(missing.slice(i, i + this.config.concurrency))
    }

    let generated = cachedCount
    for (const batch of batches) {
      const results = await Promise.allSettled(batch.map((phrase) => this.synthesizePhrase(phrase)))

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          generated++
        }
      }
    }

    this.pregeneratedCount = generated
    log('INFO', 'phrase_pregen_completed', {
      generated: generated - cachedCount,
      total: generated,
      failed: missing.length - (generated - cachedCount),
    })
  }

  /**
   * 合成单个短语并存入缓存。
   */
  private async synthesizePhrase(phrase: PregenPhrase): Promise<boolean> {
    try {
      const result = await piperOrchestrator.synthesize({
        text: phrase.text,
        model: this.config.piperModel,
        speed: 1.0,
        pitch: 1.0,
      })

      if (result.success && result.audioFile) {
        ttsCache.setCache(result.audioFile, phrase.text, phrase.emotionLabel, 'piper', '.wav', this.config.cacheMaxAgeMs)
        return true
      }
      return false
    } catch (err) {
      log('WARN', 'phrase_pregen_synthesis_failed', {
        text: phrase.text,
        error: String(err),
      })
      return false
    }
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例 */
export const phrasePregenService = new PhrasePregenService()
