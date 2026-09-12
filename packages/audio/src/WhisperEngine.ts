import { pipeline } from '@xenova/transformers'
import { log, createRequestId } from '@akemi-mio/core/logger/Logger'
import { type AsrResult, type ProgressCallback, type HotwordHit } from './types'
import { ASR_HOTWORDS, ASR_SAMPLE_RATE, ASR_MAX_AUDIO_SECONDS, ASR_INITIAL_PROMPT } from '@akemi-mio/core/config'
import { withTimeout } from '@akemi-mio/core/utils/async'

// ---------------------------------------------------------------
// 基于拼音的中文同音字匹配（忽略声调）
// ---------------------------------------------------------------

/** 汉字 → 拼音（无音调） */
const PINYIN_MAP: Record<string, string> = {
  秋: 'qiu',
  山: 'shan',
  澪: 'ling',
  丘: 'qiu',
  邱: 'qiu',
  衫: 'shan',
  扇: 'shan',
  删: 'shan',
  珊: 'shan',
  善: 'shan',
  三: 'san',
  修: 'xiu',
  林: 'lin',
  霖: 'lin',
  临: 'lin',
  零: 'ling',
  灵: 'ling',
  令: 'ling',
  铃: 'ling',
  龄: 'ling',
  凌: 'ling',
  陵: 'ling',
  玲: 'ling',
  领: 'ling',
  岭: 'ling',
  另: 'ling',
  贝: 'bei',
  斯: 'si',
  被: 'bei',
  备: 'bei',
  倍: 'bei',
  辈: 'bei',
  背: 'bei',
  北: 'bei',
  悲: 'bei',
  思: 'si',
  丝: 'si',
  私: 'si',
  司: 'si',
  四: 'si',
  死: 'si',
  似: 'si',
  寺: 'si',
  音: 'yin',
  阶: 'jie',
  因: 'yin',
  阴: 'yin',
  姻: 'yin',
  接: 'jie',
  皆: 'jie',
  街: 'jie',
  揭: 'jie',
  结: 'jie',
  节: 'jie',
  截: 'jie',
  和: 'he',
  弦: 'xian',
  合: 'he',
  何: 'he',
  河: 'he',
  核: 'he',
  荷: 'he',
  盒: 'he',
  赫: 'he',
  鹤: 'he',
  贤: 'xian',
  闲: 'xian',
  咸: 'xian',
  衔: 'xian',
  嫌: 'xian',
  显: 'xian',
  险: 'xian',
  现: 'xian',
  旋: 'xuan',
  律: 'lv',
  玄: 'xuan',
  悬: 'xuan',
  选: 'xuan',
  宣: 'xuan',
  轩: 'xuan',
  率: 'lv',
  绿: 'lv',
  虑: 'lv',
  小: 'xiao',
  确: 'que',
  幸: 'xing',
  晓: 'xiao',
  笑: 'xiao',
  孝: 'xiao',
  却: 'que',
  缺: 'que',
  鹊: 'que',
  雀: 'que',
  性: 'xing',
  兴: 'xing',
  星: 'xing',
  新: 'xing',
  巴: 'ba',
  八: 'ba',
  吧: 'ba',
  拔: 'ba',
  轻: 'qing',
  清: 'qing',
  青: 'qing',
  氢: 'qing',
  倾: 'qing',
  晚: 'wan',
  安: 'an',
  万: 'wan',
  碗: 'wan',
  挽: 'wan',
  按: 'an',
  案: 'an',
  暗: 'an',
  岸: 'an',
  踏: 'ta',
  实: 'shi',
  塔: 'ta',
  塌: 'ta',
  十: 'shi',
  时: 'shi',
  石: 'shi',
  识: 'shi',
  食: 'shi',
  陪: 'pei',
  伴: 'ban',
  培: 'pei',
  赔: 'pei',
  办: 'ban',
  半: 'ban',
  扮: 'ban',
  拌: 'ban',
  温: 'wen',
  柔: 'rou',
  蕴: 'yun',
  肉: 'rou',
  练: 'lian',
  习: 'xi',
  链: 'lian',
  炼: 'lian',
  席: 'xi',
  袭: 'xi',
  享: 'xiang',
  受: 'shou',
  想: 'xiang',
  响: 'xiang',
  香: 'xiang',
  向: 'xiang',
  收: 'shou',
  首: 'shou',
  手: 'shou',
  守: 'shou',
  寿: 'shou',
  售: 'shou',
  密: 'mi',
  钥: 'yao',
  蜜: 'mi',
  秘: 'mi',
  觅: 'mi',
  幂: 'mi',
  药: 'yao',
  要: 'yao',
  耀: 'yao',
  字: 'zi',
  幕: 'mu',
  自: 'zi',
  子: 'zi',
  紫: 'zi',
  木: 'mu',
  目: 'mu',
  慕: 'mu',
  墓: 'mu',
  暮: 'mu',
}

/** 获取一个中文字符的拼音（无音调），回退原字 */
function getCharPinyin(ch: string): string {
  return PINYIN_MAP[ch] ?? ch
}

/**
 * 拼音归一化：将相似读音映射到同一形式，覆盖 ASR 常见混淆。
 * - ing ↔ in (ling → lin, ping → pin)
 * - eng ↔ en (heng → hen)
 * - s ↔ sh (san → shan, si → shi)
 * - z ↔ zh
 * - c ↔ ch
 * - l ↔ n (不区分边音鼻音)
 * - ü ↔ u (lv → lu, lv → lü 统一处理)
 */
function normalizePinyin(py: string): string {
  return py
    .replace(/ing$/g, 'in')
    .replace(/eng$/g, 'en')
    .replace(/^shi/g, 'si')
    .replace(/^zhi/g, 'zi')
    .replace(/^chi/g, 'ci')
    .replace(/^sh/g, 's')
    .replace(/^zh/g, 'z')
    .replace(/^ch/g, 'c')
    .replace(/ü/g, 'u')
    .replace(/^n(?![aeiou])/g, 'l')
}

/** 获取整个词的拼音序列 */
function getWordPinyin(word: string): string[] {
  return [...word].map((ch) => getCharPinyin(ch))
}

/** 检查字符串是否包含中文 */
function hasChinese(s: string): boolean {
  return /[一-鿿]/.test(s)
}

// 预计算所有中文热词的拼音序列（已归一化）
type HotwordPattern = { original: string; pinyin: string[] }
const hotwordPatterns: HotwordPattern[] = ASR_HOTWORDS.filter((hw) => hasChinese(hw)).map((hw) => ({
  original: hw,
  pinyin: getWordPinyin(hw).map(normalizePinyin),
}))

/**
 * 对中文热词使用拼音模糊匹配，对英文热词使用大小写不敏感精确匹配。
 * 返回所有命中的热词及出现次数，并用正确拼写替换原文。
 */
export function applyHotwords(text: string): { text: string; hits: HotwordHit[] } {
  let corrected = text
  const hits: HotwordHit[] = []

  // 英文热词：大小写不敏感精确匹配（快路径）
  for (const hw of ASR_HOTWORDS) {
    if (hasChinese(hw)) continue
    const lower = hw.toLowerCase()
    const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(escaped, 'gi')
    const matches = corrected.match(pattern)
    if (matches) {
      corrected = corrected.replace(pattern, hw)
      hits.push({ hotword: hw, count: matches.length })
    }
  }

  // 中文热词：拼音模糊匹配
  if (hotwordPatterns.length > 0) {
    const chars = [...corrected]
    const charPinyins = chars.map((ch) => (hasChinese(ch) ? normalizePinyin(getCharPinyin(ch)) : null))
    let result = ''
    let i = 0

    while (i < chars.length) {
      let matched = false
      for (const hwp of hotwordPatterns) {
        const len = hwp.pinyin.length
        if (i + len > chars.length) continue

        let match = true
        for (let j = 0; j < len; j++) {
          const cp = charPinyins[i + j]
          if (cp === null) {
            match = false
            break
          }
          if (cp !== hwp.pinyin[j]) {
            match = false
            break
          }
        }

        if (match) {
          result += hwp.original
          i += len
          matched = true
          const existing = hits.find((h) => h.hotword === hwp.original)
          if (existing) existing.count++
          else hits.push({ hotword: hwp.original, count: 1 })
          break
        }
      }

      if (!matched) {
        result += chars[i]
        i++
      }
    }

    corrected = result
  }

  return { text: corrected, hits }
}

type Transcriber = (audio: Float32Array) => Promise<{ text: string; raw?: string; hits?: HotwordHit[] }>

export class WhisperEngine {
  private transcribeFn: Transcriber | null = null
  private loading = false
  private loadError: string | null = null
  private loadPromise: Promise<void> | null = null
  private currentModel = ''
  private firstInferenceDone = false
  private defaultPrompt: string
  private initialPrompt: string

  constructor() {
    const hotwordPrefix = `关键词: ${ASR_HOTWORDS.slice(0, 20).join(', ')}。`
    this.defaultPrompt = `${ASR_INITIAL_PROMPT} ${hotwordPrefix}`
    this.initialPrompt = this.defaultPrompt
  }

  async initialize(model = 'tiny', onProgress?: ProgressCallback): Promise<void> {
    if (this.transcribeFn) return
    if (this.loading && this.loadPromise) return this.loadPromise
    this.loading = true
    this.loadError = null
    this.currentModel = `whisper-${model}`
    log('INFO', 'asr_init_start')
    this.loadPromise = this._doInit(model, onProgress)
    return this.loadPromise
  }

  private async _doInit(model: string, onProgress?: ProgressCallback): Promise<void> {
    const t0 = Date.now()
    const memBefore = process.memoryUsage().rss
    try {
      const modelId = `Xenova/whisper-${model}`
      const pipe = await this._createPipeline(modelId, onProgress)

      const memAfter = process.memoryUsage().rss
      this._logInitComplete(model, t0, memBefore, memAfter)

      this.transcribeFn = this._createTranscriber(pipe)
    } catch (err) {
      this.loadError = String(err)
      log('ERROR', 'asr_init_failed', { error: String(err) })
      throw err
    } finally {
      this.loading = false
    }
  }

  private async _createPipeline(modelId: string, onProgress?: ProgressCallback): Promise<Awaited<ReturnType<typeof pipeline>>> {
    log('INFO', 'pipeline_create_start', { model: modelId, quantized: true })
    const pipelineStart = Date.now()
    const pendingTimer = setInterval(() => {
      log('PERF', 'pipeline_pending', {
        model: modelId,
        elapsed_ms: Date.now() - pipelineStart,
        stage: 'await_pipeline',
      })
    }, 10000)
    try {
      return await pipeline('automatic-speech-recognition', modelId, {
        quantized: true,
        progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
          if (p.status === 'progress' && p.total) {
            const pct = Math.round(((p.loaded || 0) / p.total) * 100)
            onProgress?.(pct, `模型下载中 ${pct}%`)
            log('INFO', 'model_loading', { file: p.file, status: 'loading', progress: pct, loaded: p.loaded, total: p.total })
          } else if (p.status === 'initiate') {
            onProgress?.(0, '准备下载模型...')
            log('INFO', 'model_loading', { file: p.file, status: 'initiate' })
          } else if (p.status === 'done') {
            log('INFO', 'model_loading', { file: p.file, status: 'done' })
          }
        },
      })
    } catch (err) {
      log('ERROR', 'pipeline_failed', { model: modelId, cost_ms: Date.now() - pipelineStart, error: String(err) })
      throw err
    } finally {
      clearInterval(pendingTimer)
    }
  }

  setInitialPrompt(prompt: string): void {
    this.initialPrompt = prompt
  }

  /** 重置 initialPrompt 为构造函数中的默认值（静态配置） */
  resetInitialPrompt(): void {
    this.initialPrompt = this.defaultPrompt
  }

  private _createTranscriber(pipe: Awaited<ReturnType<typeof pipeline>>): Transcriber {
    return async (audio: Float32Array) => {
      const result = (await pipe(
        audio as any,
        {
          language: 'zh',
          task: 'transcribe',
          max_new_tokens: 100,
          return_timestamps: false,
          initial_prompt: this.initialPrompt,
        } as any,
      )) as { text: string }
      const post = applyHotwords(result.text)
      if (post.hits.length > 0) {
        log('INFO', 'asr_postprocess', {
          raw_text: result.text,
          corrected_text: post.text,
          hotword_hits: post.hits,
          hotword_count: post.hits.reduce((s, h) => s + h.count, 0),
        })
      }
      return { text: post.text, raw: result.text, hits: post.hits }
    }
  }

  private _logInitComplete(model: string, t0: number, memBefore: number, memAfter: number): void {
    const modelSizes: Record<string, number> = { 'large-v3': 1500, medium: 800, small: 500, base: 300, tiny: 150 }
    log('INFO', 'asr_init_complete', {
      model: this.currentModel,
      duration_ms: Date.now() - t0,
      memory_delta_mb: Math.round((memAfter - memBefore) / (1024 * 1024)),
      estimated_model_size_mb: modelSizes[model] || 0,
      execution_provider: 'CPU',
      onnx_cleanup_removed: 143,
    })
  }

  async transcribe(audioBuffer: Float32Array, timeoutMs = 10000, requestId?: string): Promise<AsrResult & { request_id: string }> {
    if (!this.transcribeFn) throw new Error('ASR not initialized')

    const maxSamples = ASR_SAMPLE_RATE * ASR_MAX_AUDIO_SECONDS
    const audio = audioBuffer.length > maxSamples ? audioBuffer.slice(audioBuffer.length - maxSamples) : audioBuffer
    const t0 = Date.now()
    const audioLenNum = parseFloat((audio.length / ASR_SAMPLE_RATE).toFixed(1))
    const rid = requestId || createRequestId()
    if (audio !== audioBuffer) {
      log('WARN', 'asr_audio_trimmed', {
        request_id: rid,
        original_len_s: parseFloat((audioBuffer.length / ASR_SAMPLE_RATE).toFixed(1)),
        trimmed_len_s: audioLenNum,
      })
    }
    log('INFO', 'transcription_start', {
      request_id: rid,
      audio_len_s: audioLenNum,
      sample_count: audio.length,
      timeout_ms: timeoutMs,
    })

    try {
      const result = await withTimeout(() => this.transcribeFn!(audio), timeoutMs)
      const elapsed = Date.now() - t0
      const hotwordHit = result.hits && result.hits.length > 0 ? result.hits[0].hotword : undefined
      log('CHAT', 'transcription', {
        request_id: rid,
        text: result.text,
        audio_len_s: audioLenNum,
        asr_inference_ms: elapsed,
        confidence: null,
        confidence_note: 'requires lower-level API',
        language: 'zh',
        hotword_hit: hotwordHit,
        raw_text: result.raw !== result.text ? result.raw : undefined,
      })
      if (!this.firstInferenceDone) {
        this.firstInferenceDone = true
        log('PERF', 'first_inference', { audio_duration_s: audioLenNum, inference_ms: elapsed })
      }
      return { text: result.text, duration: elapsed, request_id: rid, raw: result.raw, hits: result.hits }
    } catch (err) {
      log('ERROR', 'transcription_failed', { request_id: rid, error: String(err) })
      throw err
    }
  }

  getStatus(): { loaded: boolean; loading: boolean; error: string | null } {
    return { loaded: !!this.transcribeFn, loading: this.loading, error: this.loadError }
  }

  getModelInfo(): string {
    return this.currentModel || 'not loaded'
  }
}
