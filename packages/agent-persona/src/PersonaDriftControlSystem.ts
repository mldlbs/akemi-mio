/**
 * PersonaDriftControlSystem — 人格漂移控制系统
 *
 * 检测 LLM 输出中的"AI 味"信号，并在超出阈值时注入修正。
 * 所有指标均为纯文本统计（正则+计数），无额外 LLM 调用。
 *
 * 指标维度（Style Entropy）：
 *   sentenceLengthVariance  — 句子长度方差（低方差 = AI 式单调）
 *   abstractionRatio        — 抽象标记密度（高 = 过度解释）
 *   emotionLabelDensity     — 情绪标签密度（高 = 概括性情绪词过多）
 *   summaryMarkerDensity    — 总结性措辞密度（"这体现""象征""反映"）
 *   repetitionPattern       — 句式重复
 *
 * 架构位置：Cognitive System → Persona Drift Control System
 */

import { log } from './runtime'

// ─── Style Entropy Metrics ───

export interface StyleEntropyReport {
  entropy: number // 综合熵值 0-1，越高越"AI 味"（需修正）
  breakdown: {
    sentenceLengthVariance: number
    abstractionRatio: number
    emotionLabelDensity: number
    summaryMarkerDensity: number
    repetitionPattern: number
  }
}

/** AI 味抽象标记 */
const ABSTRACTION_PATTERNS = /体现了|象征着|反映出|本质上|某种意义上|从某种角度|深层次|某种意义上|背后是|隐含的|内在的|不言而喻/gu
/** 概括性情绪标签 */
const EMOTION_LABELS = /他感到|她感到|感到愤怒|感到悲伤|感到开心|感到兴奋|感到焦虑|感到不安|内心充满|心中涌起|一种.*?的感觉/gu
/** 总结/解释性措辞 */
const SUMMARY_MARKERS = /这说明|这意味着|可以看到|不难发现|显而易见|综上所述|换言之|也就是说|其实|实际上|本质上/gu
/** 句式重复检测：连续短句以相同主语开头 */
const REPETITION_PREFIX = /^他[，、]|^她[，、]|^它[，、]|^这[，、]/gmu

const MAX_ENTROPY_CUTOFF = 30

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v))
}

/** 采集风格熵指标 */
export function evaluateStyleEntropy(text: string): StyleEntropyReport {
  if (!text || text.length < 10) {
    return {
      entropy: 0,
      breakdown: { sentenceLengthVariance: 0, abstractionRatio: 0, emotionLabelDensity: 0, summaryMarkerDensity: 0, repetitionPattern: 0 },
    }
  }

  const sentences = text
    .split(/[。！？\n]+/)
    .filter(Boolean)
    .slice(0, MAX_ENTROPY_CUTOFF)
  const sentenceCount = sentences.length

  // 1. 句子长度方差（低 = AI 单调）
  const lengths = sentences.map((s) => s.length)
  const meanLen = lengths.reduce((a, b) => a + b, 0) / Math.max(sentenceCount, 1)
  const variance = lengths.reduce((acc, l) => acc + (l - meanLen) ** 2, 0) / Math.max(sentenceCount, 1)
  const sentenceLengthVariance = clamp(1 - variance / 60)

  // 2. 抽象标记密度
  const abstractionCount = (text.match(ABSTRACTION_PATTERNS) || []).length
  const abstractionRatio = clamp((abstractionCount / Math.min(sentenceCount, 10)) * 2)

  // 3. 情绪标签密度
  const emotionCount = (text.match(EMOTION_LABELS) || []).length
  const emotionLabelDensity = clamp((emotionCount / Math.min(sentenceCount, 10)) * 2)

  // 4. 总结性措辞密度
  const summaryCount = (text.match(SUMMARY_MARKERS) || []).length
  const summaryMarkerDensity = clamp((summaryCount / Math.min(sentenceCount, 8)) * 2)

  // 5. 句式重复：以相同代词开头的句子比例
  const repMatches = text.match(REPETITION_PREFIX)
  const repetitionPattern = sentenceCount >= 3 ? clamp(((repMatches?.length || 0) / sentenceCount) * 3) : 0

  const breakdown = { sentenceLengthVariance, abstractionRatio, emotionLabelDensity, summaryMarkerDensity, repetitionPattern }

  // 综合熵值 = 加权平均
  const weights = [0.15, 0.25, 0.2, 0.25, 0.15]
  const values = [sentenceLengthVariance, abstractionRatio, emotionLabelDensity, summaryMarkerDensity, repetitionPattern]
  const entropy = clamp(values.reduce((sum, v, i) => sum + v * weights[i], 0))

  return { entropy, breakdown }
}

// ─── Style Anchor Memory ───

export interface StyleAnchor {
  pattern: string
  isGood: boolean
  count: number
}

/**
 * StyleAnchorMemory — 记录好/坏写作风格样本
 * 用于对比评估当前输出是否漂移
 */
export class StyleAnchorMemory {
  private anchors: StyleAnchor[] = []
  private readonly maxAnchors = 20

  record(text: string, isGood: boolean): void {
    if (!text || text.length < 20) return
    const patterns = this.extractPatterns(text)
    for (const p of patterns) {
      const existing = this.anchors.find((a) => a.pattern === p && a.isGood === isGood)
      if (existing) {
        existing.count++
      } else {
        this.anchors.push({ pattern: p, isGood, count: 1 })
      }
    }
    this.prune()
  }

  getTopPatterns(limit = 3): { good: string[]; bad: string[] } {
    const good = this.anchors
      .filter((a) => a.isGood)
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map((a) => a.pattern)
    const bad = this.anchors
      .filter((a) => !a.isGood)
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map((a) => a.pattern)
    return { good, bad }
  }

  clear(): void {
    this.anchors = []
  }

  private extractPatterns(text: string): string[] {
    const patterns: string[] = []
    for (const word of ['体现了', '象征着', '反映出', '感到', '说明', '意味着', '仿佛', '犹如']) {
      if (text.includes(word)) patterns.push(word)
    }
    return patterns
  }

  private prune(): void {
    if (this.anchors.length > this.maxAnchors) {
      this.anchors.sort((a, b) => b.count - a.count)
      this.anchors = this.anchors.slice(0, this.maxAnchors)
    }
  }
}

// ─── Drift Evaluation ───

export interface DriftEvalResult {
  drifted: boolean
  entropy: number
  correctionInjected: boolean
}

const DRIFT_THRESHOLD = 0.45
const HYBRID_DRIFT_THRESHOLD = 0.5

/** 评估熵报告，判断是否漂移 */
export function evaluateDrift(
  report: StyleEntropyReport,
  personaLevel: 'core' | 'hybrid' | 'writer',
): { drifted: boolean; reason: string | null } {
  if (personaLevel === 'core') return { drifted: false, reason: null }

  const threshold = personaLevel === 'hybrid' ? HYBRID_DRIFT_THRESHOLD : DRIFT_THRESHOLD
  if (report.entropy < threshold) return { drifted: false, reason: null }

  const dims: Array<[string, number]> = [
    ['abstraction', report.breakdown.abstractionRatio],
    ['emotion_label', report.breakdown.emotionLabelDensity],
    ['summary_marker', report.breakdown.summaryMarkerDensity],
    ['repetition', report.breakdown.repetitionPattern],
  ]
  dims.sort((a, b) => b[1] - a[1])
  const worst = dims[0][1] > 0.5 ? dims[0][0] : null
  return { drifted: true, reason: worst ? `style_drift:${worst}` : 'style_drift:general' }
}

/** 根据 drift 原因生成修正信号 */
export function buildCorrectionSignal(reason: string | null): string | null {
  if (!reason) return null
  const dim = reason.split(':')[1]
  const signals: Record<string, string> = {
    abstraction: '避免抽象概括，请用具体场景和细节来表达：不要解释意义，只呈现事实。',
    emotion_label: '避免直接标注情绪（如"她感到伤心"），请通过动作、表情和环境来传递情感。',
    summary_marker: '避免总结性语言（"这体现""这意味着"），让读者自己理解含义。',
    repetition: '句子结构过于单调，请变化句式、打破连续以相同词开头的模式。',
    general: '写作风格偏 AI 化，请回归更自然、更具体的表达方式。',
  }
  return signals[dim] || signals.general
}

// ─── Correction Prompt ───

/** 漂移修正 prompt — 注入到 extraModules（system prompt 级别） */
export const DRIFT_CORRECTION_PROMPT = `【风格修正】
检测到近期输出中存在 AI 化倾向。请特别注意：
- 用具体细节代替抽象概括
- 不解释含义，只呈现事实
- 避免"体现了""象征着""反映出"等总结性措辞
- 不直接标注情绪（不说"她感到愤怒"，写她攥紧的拳头）
- 变化句式，不要连续以相同词开头`

// ─── Orchestrator ───

export class PersonaDriftControlSystem {
  readonly styleAnchorMemory = new StyleAnchorMemory()
  private lastDriftLog: { entropy: number; reason: string } | null = null
  private consecutiveDriftCount = 0
  /** 当前是否处于修正注入状态（system prompt 级别） */
  private correctionActive = false
  /** 连续无漂移次数，达到后解除修正 */
  private cleanCount = 0

  /**
   * 在 LLM 输出后调用：评估漂移、更新锚点、返回修正信号
   */
  evaluateOutput(text: string, personaLevel: 'core' | 'hybrid' | 'writer'): { messageSignal: string | null; evalResult: DriftEvalResult } {
    if (personaLevel === 'core') {
      this.correctionActive = false
      return { messageSignal: null, evalResult: { drifted: false, entropy: 0, correctionInjected: false } }
    }

    const report = evaluateStyleEntropy(text)
    const { drifted, reason } = evaluateDrift(report, personaLevel)
    this.styleAnchorMemory.record(text, !drifted)

    if (drifted) {
      this.consecutiveDriftCount++
      this.cleanCount = 0
      this.lastDriftLog = { entropy: report.entropy, reason: reason || 'unknown' }
      log('WARN', 'style_drift_detected', {
        entropy: report.entropy.toFixed(3),
        reason,
        consecutive: this.consecutiveDriftCount,
      })

      // 本次修正信号（message 层面，每次飘都打，非连续不限制）
      const messageSignal = this.consecutiveDriftCount >= 2 ? buildCorrectionSignal(reason) : null
      // 连续 3 次 → 激活 system prompt 级别修正
      if (this.consecutiveDriftCount >= 3 && !this.correctionActive) {
        this.correctionActive = true
        log('WARN', 'style_drift_correction_activated', { entropy: report.entropy.toFixed(3) })
      }
      return { messageSignal, evalResult: { drifted: true, entropy: report.entropy, correctionInjected: !!messageSignal } }
    }

    this.consecutiveDriftCount = 0
    this.cleanCount++

    // 连续 5 次无漂移 → 解除修正
    if (this.correctionActive && this.cleanCount >= 5) {
      this.correctionActive = false
      log('INFO', 'style_drift_correction_deactivated')
    }
    return { messageSignal: null, evalResult: { drifted: false, entropy: report.entropy, correctionInjected: false } }
  }

  /** 当前是否需要注入修正 prompt（system prompt 级别） */
  needsCorrectionPrompt(): boolean {
    return this.correctionActive
  }

  reset(): void {
    this.consecutiveDriftCount = 0
    this.correctionActive = false
    this.cleanCount = 0
    this.lastDriftLog = null
  }
}
