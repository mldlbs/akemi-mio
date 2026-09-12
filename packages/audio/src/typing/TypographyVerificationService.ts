/**
 * TypographyVerificationService — 排版内容语音校验与预览
 *
 * 职责：
 * 1. 使用 PiperTTS 将排版后文本转为语音
 * 2. 使用本地 ASR（Whisper）将语音转回文本
 * 3. 利用编辑距离逐句对比差异，发现格式符号导致的吞词/断句错误
 * 4. 生成校验报告（含可疑段落高亮信息、音频路径）
 * 5. 支持仅朗读指定段落（不校验）
 *
 * 集成：
 * - PiperTypographyAdapter（适配层）：将排版参数映射为 PiperTTS 参数后调用合成
 * - AsrService：由调用方传入的 transcribe 回调驱动
 * - 编辑距离：基于字符级 Needleman–Wunsch / 贪心对齐
 */
import { promises as fsp } from 'fs'
import { log } from '@akemi-mio/core/logger/Logger'
import { piperTypographyAdapter } from './PiperTypographyAdapter'
import { cleanTTS } from '@akemi-mio/audio/TtsService'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 差异段落类型 */
export type DiffType = 'match' | 'substitution' | 'deletion' | 'insertion'

/** 单差异段落 */
export interface DiffSegment {
  /** 差异类型 */
  type: DiffType
  /** 原始文本片段（删除/替换时非空） */
  original: string
  /** ASR 识别文本片段（插入/替换时非空） */
  recognized: string
  /** 在原始文本中的字符起始位置 */
  start: number
  /** 在原始文本中的字符结束位置 */
  end: number
}

/** 逐句校验结果 */
export interface SentenceCheck {
  /** 原始句子 */
  originalSentence: string
  /** ASR 识别的句子 */
  recognizedSentence: string
  /** 编辑距离 */
  editDistance: number
  /** 句子长度（按原始文本计） */
  length: number
  /** 差异率 0–1 */
  diffRate: number
  /** 是否可疑（diffRate > 阈值） */
  suspicious: boolean
  /** 差异段落详情 */
  diffSegments: DiffSegment[]
}

/** 完整校验报告 */
export interface VerificationReport {
  /** 排版后的原文 */
  formattedText: string
  /** 去除样式后的纯文本 */
  plainText: string
  /** ASR 识别文本 */
  recognizedText: string
  /** 逐句校验 */
  sentences: SentenceCheck[]
  /** 差异总览 */
  summary: {
    totalSentences: number
    suspiciousSentences: number
    totalDiffRate: number
    hasDiscrepancies: boolean
    audioDurationMs: number
    verificationMs: number
  }
  /** 合成音频文件路径（用于回放校验） */
  audioFile?: string
}

/** 仅朗读的结果 */
export interface ReadAloudResult {
  success: boolean
  audioFile?: string
  durationMs: number
  error?: string
}

// ══════════════════════════════════════════
//  常量
// ══════════════════════════════════════════

/** 可疑阈值：差异率超过此值标记为可疑 */
const SUSPICIOUS_THRESHOLD = 0.3

/** 最小句子长度（少于该长度不参与校验，太短无统计意义） */
const MIN_SENTENCE_LENGTH = 5

/** ASR 采样率 */
const ASR_SAMPLE_RATE = 16000

// ══════════════════════════════════════════
//  辅助函数
// ══════════════════════════════════════════

/**
 * 将文本分割为句子（支持中文标点）。
 */
function splitSentences(text: string): string[] {
  // 按中文句号、问号、感叹号、省略号、换行分割
  const raw = text.split(/(?<=[。！？\n…]+)/)
  return raw.map((s) => s.trim()).filter((s) => s.length >= MIN_SENTENCE_LENGTH)
}

/**
 * 计算两个字符串的编辑距离（Levenshtein）。
 * 区分大小写，适用于中文字符级比较。
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  // 优化：使用两行滚动数组
  let prev = new Array(n + 1)
  let curr = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(
        prev[j] + 1, // 删除
        curr[j - 1] + 1, // 插入
        prev[j - 1] + cost, // 替换
      )
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}

/**
 * 基于编辑距离回溯，提取差异段落。
 * 返回对齐后的 diff segment 列表。
 */
function extractDiffs(original: string, recognized: string): DiffSegment[] {
  const m = original.length
  const n = recognized.length

  // 构建 DP 矩阵
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = original[i - 1] === recognized[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }

  // 回溯
  const diffs: DiffSegment[] = []
  let i = m
  let j = n
  let currentType: DiffType | null = null
  let origAccum = ''
  let recogAccum = ''
  let endPos = m

  function flush() {
    if (!currentType) return
    if (currentType === 'match' && origAccum.length > 0) {
      diffs.unshift({
        type: 'match',
        original: origAccum,
        recognized: recogAccum,
        start: i, // will be adjusted
        end: endPos,
      })
    } else if (currentType === 'deletion') {
      diffs.unshift({
        type: 'deletion',
        original: origAccum,
        recognized: '',
        start: i,
        end: endPos,
      })
    } else if (currentType === 'insertion') {
      diffs.unshift({
        type: 'insertion',
        original: '',
        recognized: recogAccum,
        start: endPos,
        end: endPos,
      })
    } else if (currentType === 'substitution') {
      diffs.unshift({
        type: 'substitution',
        original: origAccum,
        recognized: recogAccum,
        start: i,
        end: endPos,
      })
    }
    origAccum = ''
    recogAccum = ''
  }

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && original[i - 1] === recognized[j - 1]) {
      const newType: DiffType = 'match'
      if (currentType !== newType) {
        flush()
        currentType = newType
        endPos = i
      }
      origAccum = original[i - 1] + origAccum
      recogAccum = recognized[j - 1] + recogAccum
      i--
      j--
    } else if (i > 0 && j > 0) {
      // 替换
      const newType: DiffType = 'substitution'
      if (currentType !== newType) {
        flush()
        currentType = newType
        endPos = i
      }
      origAccum = original[i - 1] + origAccum
      recogAccum = recognized[j - 1] + recogAccum
      i--
      j--
    } else if (i > 0) {
      // 原始文本多出来的 → 删除
      const newType: DiffType = 'deletion'
      if (currentType !== newType) {
        flush()
        currentType = newType
        endPos = i
      }
      origAccum = original[i - 1] + origAccum
      recogAccum = ' ' + recogAccum
      i--
    } else if (j > 0) {
      // 识别文本多出来的 → 插入
      const newType: DiffType = 'insertion'
      if (currentType !== newType) {
        flush()
        currentType = newType
        endPos = endPos || 0
      }
      origAccum = ' ' + origAccum
      recogAccum = recognized[j - 1] + recogAccum
      j--
    }
  }
  flush()

  // 修正 start 位置：从累积变回绝对位置
  let pos = 0
  for (const d of diffs) {
    const len = d.type === 'insertion' ? 0 : d.original.length
    d.start = pos
    d.end = pos + len
    pos += len
  }

  return diffs
}

/**
 * 从 WAV 文件中读取 PCM 数据并转换为 Int16Array。
 * 支持标准 16-bit PCM WAV 格式。
 */
async function readWavAsInt16(filePath: string): Promise<Int16Array> {
  const buf = await fsp.readFile(filePath)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

  // 查找 "data" 块偏移
  let dataOffset = 44 // 标准偏移
  const riffId = buf.toString('ascii', 0, 4)
  if (riffId !== 'RIFF') {
    throw new Error(`Not a RIFF file: ${riffId}`)
  }

  // 检查 fmt 格式
  const audioFormat = view.getUint16(20, true)
  if (audioFormat !== 1) {
    throw new Error(`Only PCM WAV supported, got format ${audioFormat}`)
  }

  const numChannels = view.getUint16(22, true)
  const sampleRate = view.getUint32(24, true)
  const bitsPerSample = view.getUint16(34, true)

  // 查找 "data" 块（某些 WAV 有额外的 JUNK 块）
  let searchPos = 12
  while (searchPos < buf.length - 8) {
    const chunkId = buf.toString('ascii', searchPos, searchPos + 4)
    const chunkSize = view.getUint32(searchPos + 4, true)
    if (chunkId === 'data') {
      dataOffset = searchPos + 8
      break
    }
    searchPos += 8 + chunkSize
  }

  const dataSize = buf.length - dataOffset
  const sampleCount = Math.floor(dataSize / (bitsPerSample / 8) / numChannels)

  if (bitsPerSample === 16) {
    const samples = new Int16Array(sampleCount)
    for (let s = 0; s < sampleCount; s++) {
      // 取第一个通道（单声道或左声道）
      const byteOff = dataOffset + s * numChannels * 2
      samples[s] = view.getInt16(byteOff, true)
    }
    return samples
  }

  throw new Error(`Unsupported bits per sample: ${bitsPerSample}`)
}

/**
 * 将 Int16 PCM 重采样到目标采样率（简单线性插值）。
 */
function resampleInt16(src: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) return src
  const ratio = fromRate / toRate
  const result = new Int16Array(Math.ceil(src.length / ratio))
  for (let i = 0; i < result.length; i++) {
    const pos = i * ratio
    const idx = Math.floor(pos)
    const frac = pos - idx
    if (idx + 1 < src.length) {
      result[i] = Math.round(src[idx] * (1 - frac) + src[idx + 1] * frac)
    } else {
      result[i] = src[idx] || 0
    }
  }
  return result
}

// ══════════════════════════════════════════
//  核心服务
// ══════════════════════════════════════════

export class TypographyVerificationService {
  /**
   * ASR 转录回调 — 由调用方注入（通常来自 AgentService 的 AsrService）。
   * 接收 Int16 PCM（16kHz 单声道），返回识别文本。
   */
  private transcribeFn: ((pcmInt16: Int16Array) => Promise<string>) | null = null

  /**
   * 设置 ASR 转录回调。
   * 调用方传入包装函数，通常为：
   *   (pcm) => asrService.transcribe(pcm.buffer).then(r => r.text)
   */
  setTranscribeFn(fn: (pcmInt16: Int16Array) => Promise<string>): void {
    this.transcribeFn = fn
  }

  /**
   * 获取当前是否已配置转录回调。
   */
  hasTranscribeFn(): boolean {
    return this.transcribeFn !== null
  }

  // ───── 核心校验方法 ─────

  /**
   * 对排版后的文本执行 TTS→ASR 闭环校验。
   *
   * @param formattedText 排版后的格式化文本（含样式标记）
   * @returns 校验报告
   */
  async verify(formattedText: string): Promise<VerificationReport> {
    const t0 = Date.now()

    // 1. 去除样式得到纯文本
    const plainText = this.stripFormatting(formattedText)
    if (!plainText || plainText.length < MIN_SENTENCE_LENGTH) {
      return {
        formattedText,
        plainText,
        recognizedText: '',
        sentences: [],
        summary: {
          totalSentences: 0,
          suspiciousSentences: 0,
          totalDiffRate: 0,
          hasDiscrepancies: false,
          audioDurationMs: 0,
          verificationMs: Date.now() - t0,
        },
      }
    }

    // 2. 调用 PiperTTS 合成语音 → WAV
    log('INFO', 'typography_verify_tts_start', { text_len: plainText.length })
    const synthResult = await piperTypographyAdapter.synthesize({
      text: plainText,
      platformTag: '公众号',
      contentCategory: 'article',
    })
    if (!synthResult.success || !synthResult.audioFile) {
      log('ERROR', 'typography_verify_tts_failed', { error: synthResult.error })
      throw new Error(`TTS 合成失败: ${synthResult.error || '未知错误'}`)
    }

    const audioFile = synthResult.audioFile

    // 3. 读取 WAV → Int16 PCM
    let pcmData: Int16Array
    try {
      pcmData = await readWavAsInt16(audioFile)

      // Piper 默认输出 22050Hz，ASR 需要 16kHz
      pcmData = resampleInt16(pcmData, 22050, ASR_SAMPLE_RATE)

      log('INFO', 'typography_verify_wav_read', {
        samples: pcmData.length,
        durationSec: (pcmData.length / ASR_SAMPLE_RATE).toFixed(1),
      })
    } catch (err) {
      log('ERROR', 'typography_verify_wav_failed', { error: String(err) })
      throw new Error(`读取音频失败: ${String(err)}`)
    }

    // 4. 调用 ASR 识别
    if (!this.transcribeFn) {
      throw new Error('ASR 转录回调未配置。请先调用 setTranscribeFn()。')
    }

    log('INFO', 'typography_verify_asr_start', { samples: pcmData.length })
    let recognizedText: string
    try {
      recognizedText = await this.transcribeFn(pcmData)
    } catch (err) {
      log('ERROR', 'typography_verify_asr_failed', { error: String(err) })
      throw new Error(`ASR 识别失败: ${String(err)}`)
    }

    recognizedText = recognizedText.trim()
    log('INFO', 'typography_verify_asr_done', {
      original_len: plainText.length,
      recognized_len: recognizedText.length,
      recognized_preview: recognizedText.slice(0, 80),
    })

    // 5. 逐句对比
    const originalSentences = splitSentences(plainText)
    const recognizedSentences = splitSentences(recognizedText)

    const sentences: SentenceCheck[] = []
    // 使用贪心逐句匹配：按顺序尽量对齐
    const maxSentences = Math.max(originalSentences.length, recognizedSentences.length)
    for (let idx = 0; idx < maxSentences; idx++) {
      const orig = originalSentences[idx] || ''
      const recog = recognizedSentences[idx] || ''

      if (!orig && !recog) continue

      const dist = levenshteinDistance(orig, recog)
      const len = Math.max(orig.length, recog.length, 1)
      const diffRate = dist / len
      const diffSegments = orig && recog ? extractDiffs(orig, recog) : []

      sentences.push({
        originalSentence: orig,
        recognizedSentence: recog,
        editDistance: dist,
        length: len,
        diffRate,
        suspicious: diffRate > SUSPICIOUS_THRESHOLD,
        diffSegments,
      })
    }

    // 6. 汇总
    const suspiciousCount = sentences.filter((s) => s.suspicious).length
    const totalDiffRate = sentences.length > 0 ? sentences.reduce((sum, s) => sum + s.diffRate, 0) / sentences.length : 0

    const report: VerificationReport = {
      formattedText,
      plainText,
      recognizedText,
      sentences,
      summary: {
        totalSentences: sentences.length,
        suspiciousSentences: suspiciousCount,
        totalDiffRate,
        hasDiscrepancies: suspiciousCount > 0,
        audioDurationMs: synthResult.durationMs,
        verificationMs: Date.now() - t0,
      },
      audioFile,
    }

    log('INFO', 'typography_verify_done', {
      total_sentences: report.summary.totalSentences,
      suspicious: report.summary.suspiciousSentences,
      total_diff_rate: report.summary.totalDiffRate.toFixed(3),
      duration_ms: report.summary.verificationMs,
    })

    return report
  }

  // ───── 仅朗读（不校验） ─────

  /**
   * 仅朗读指定文本段落（不执行 ASR 校验）。
   * 适用于用户请求"朗读这段"。
   */
  async readAloud(text: string): Promise<ReadAloudResult> {
    const cleaned = cleanTTS(text)
    if (!cleaned || cleaned.length < 2) {
      return { success: false, durationMs: 0, error: '文本太短或清理后为空' }
    }

    log('INFO', 'typography_read_aloud', { text_len: cleaned.length })
    const synthResult = await piperTypographyAdapter.synthesize({
      text: cleaned,
      platformTag: '公众号',
      contentCategory: 'article',
    })

    if (!synthResult.success || !synthResult.audioFile) {
      return {
        success: false,
        durationMs: synthResult.durationMs,
        error: synthResult.error || '合成失败',
      }
    }

    return {
      success: true,
      audioFile: synthResult.audioFile,
      durationMs: synthResult.durationMs,
    }
  }

  // ───── 辅助方法 ─────

  /**
   * 去除排版格式标记，获得纯文本。
   * 复用 cleanTTS 的清理逻辑，额外保留非样式内容。
   */
  private stripFormatting(text: string): string {
    // 先用 cleanTTS 去除 markdown 和特殊符号
    const cleaned = cleanTTS(text)

    // 如果 cleanTTS 把内容全清空了（纯格式文本），尝试更保守的清理
    if (cleaned.length === 0) {
      // 只去除明显标记
      return text
        .replace(/^#{1,6}\s*/gm, '')
        .replace(/\*{1,2}/g, '')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]+\)/g, '$1')
        .replace(/[|│]/g, '')
        .replace(/^>\s+/gm, '')
        .trim()
    }

    return cleaned
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例 */
export const typographyVerificationService = new TypographyVerificationService()
