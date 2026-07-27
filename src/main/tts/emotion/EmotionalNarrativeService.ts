/**
 * EmotionalNarrativeService — 情感记忆语音叙事服务
 *
 * 当用户触发情绪回顾（如"今天过得怎么样"）时，此服务：
 *   1. 从 Memory 提取近期对话的情感标签和时间序列
 *   2. 调用 LLM 生成叙事文本（如"你上午讨论项目时很兴奋，下午却有点疲惫"）
 *   3. 将叙事文本按情感曲线切分为段落，赋予各段落独立的情感参数
 *   4. 通过 TTS 逐段播报，每段的情感曲线体现从低谷到高潮的自然过渡
 *   5. 发射段落事件供渲染进程的波形动画消费
 *
 * 与现有系统的协作：
 *   - MemoryEmotionBridge: 读取 Memory 中的情感上下文
 *   - NarrativeEmotionController: 构建情感曲线（复用）
 *   - SpeakingStyleGenerator: 情感曲线 → StyledTtsSegment
 *   - TtsService.speak(): 逐段播报（通过 setEmotion 切换参数）
 *   - EventBus / IPC: 发射段落事件 → 渲染进程波形动画
 *
 * 风险缓解：
 *   - 情感数据不足（<3条历史）时回退到中性叙事，不强制使用情感参数
 *   - LLM 生成的叙事段落包含情感标签，但 SpeakingStyleGenerator 会校验幅度，
 *     低于阈值的段落不会触发情感语调切换
 *   - 所有 LLM 调用带超时保护，失败时回退到中性叙事
 */

import { log } from '../../logger/Logger'
import { createTimeoutSignal } from '../../utils/async'
import { LLM_TEXT_API_URL, LLM_TEXT_MODEL, LLM_TEXT_KEY } from '../../config/index'
import type { MemoryService } from '../../memory/MemoryService'
import type { TtsService } from '../TtsService'
import type { EmotionTtsParams, NarrativeEmotionSegment, EmotionVector } from '../types'
import { SPEAKING_STYLE_VOICE_MAP } from '../types'
import { memoryEmotionBridge, type AggregatedEmotionContext } from '../MemoryEmotionBridge'
import { speakingStyleGenerator } from './SpeakingStyleGenerator'
import { emotionTimeSeriesStore } from './EmotionTimeSeriesStore'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** LLM 返回的单段落情感标签 */
interface LlmSegmentLabel {
  /** 情感标签: happy / sad / angry / calm / anxious / neutral */
  emotion: string
  /** 0–1 置信度 */
  confidence: number
}

/** LLM 返回的完整叙事响应 */
interface LlmNarrativeResponse {
  /** 叙事文本段落数组（每段自带情感说明，格式见 PROMPT） */
  segments: Array<{
    text: string
    emotion: string
  }>
  /** 整体情绪趋势 */
  trendDescription: string
}

/** 叙事段落就绪事件负载 */
export interface NarrativeSegmentEvent {
  /** 段落文本 */
  text: string
  /** 段落索引 */
  index: number
  /** 段落总数 */
  total: number
  /** 情感标签（中文） */
  label: string
  /** 情感向量 */
  emotionVector: EmotionVector
  /** TTS 参数 */
  ttsParams: EmotionTtsParams
  /** 估计持续时间（毫秒） */
  durationMs: number
}

/** 叙事开始事件负载 */
export interface NarrativeStartEvent {
  /** 整体情绪趋势描述 */
  trend: string
  /** 段落总数 */
  totalSegments: number
  /** 情感上下文摘要 */
  contextSummary: string
}

/** 叙事结束事件负载 */
export interface NarrativeEndEvent {
  /** 总段落数 */
  totalSegments: number
  /** 总持续时间（毫秒） */
  totalDurationMs: number
  /** 是否成功完成 */
  success: boolean
}

/** 叙事状态 */
export type NarrativeState = 'idle' | 'generating' | 'speaking' | 'done' | 'error'

/** 叙事事件回调（供 IPC handler 注册，转发到渲染进程） */
export interface NarrativeEventCallbacks {
  /** 叙事开始 */
  onStart?: (event: NarrativeStartEvent) => void
  /** 每个段落准备播报 */
  onSegment?: (event: NarrativeSegmentEvent) => void
  /** 叙事结束 */
  onEnd?: (event: NarrativeEndEvent) => void
  /** 叙事被取消 */
  onCancel?: () => void
}

// ══════════════════════════════════════════
//  常量
// ══════════════════════════════════════════

/** LLM 调用超时（毫秒） */
const LLM_TIMEOUT_MS = 15_000

/** 情感数据不足的最小条目数 */
const MIN_EMOTION_ENTRIES = 3

/** 最大叙事段落数 */
const MAX_NARRATIVE_SEGMENTS = 5

/** 单段最小字符数（避免过短段落的语调切换） */
const MIN_SEGMENT_CHARS = 15

/** 情感向量 → 中文简短标签映射（用于 IPC 事件） */
const VECTOR_TO_LABEL: Array<{ minValence: number; maxValence: number; minArousal: number; maxArousal: number; label: string }> = [
  { minValence: 0.4, maxValence: 1.0, minArousal: 0.3, maxArousal: 1.0, label: '开心' },
  { minValence: 0.3, maxValence: 1.0, minArousal: -1.0, maxArousal: 0.2, label: '温暖' },
  { minValence: -1.0, maxValence: -0.3, minArousal: 0.3, maxArousal: 1.0, label: '严肃' },
  { minValence: -1.0, maxValence: -0.3, minArousal: -1.0, maxArousal: -0.2, label: '悲伤' },
  { minValence: -0.3, maxValence: 0.3, minArousal: 0.5, maxArousal: 1.0, label: '兴奋' },
  { minValence: -0.3, maxValence: 0.3, minArousal: -1.0, maxArousal: -0.3, label: '平静' },
]

/** 叙事生成 LLM 提示词 */
const NARRATIVE_PROMPT = `你是一个温暖的语音助手。请根据用户近期的情感数据，生成一段自然的语音叙事摘要。

## 输入数据格式
你收到的是用户近期对话的情感时间序列，每条包含：
- label: 情感标签（happy/sad/angry/calm/anxious/neutral）
- timestamp: 时间戳
- snippet: 文本片段

## 输出要求
请生成 2-5 个段落，每段配一个情感标签。格式：
[
  { "text": "叙事文本段落...", "emotion": "emotion_label" },
  ...
]

## 情感标签可选值
- happy: 开心、兴奋、积极
- sad: 悲伤、失落、沮丧
- angry: 生气、烦躁、不满
- calm: 平静、放松、安宁
- anxious: 焦虑、紧张、担忧
- neutral: 中性、平静

## 叙事原则
1. 用第二人称"你"称呼用户
2. 语气温暖共情，像朋友聊天
3. 每段对应不同情感阶段，体现情感变化
4. 从当前情感状态开始，按时间顺序叙述
5. 最后一段以积极/温和的语调收尾（除非整体情绪非常负面）
6. 每段 15-80 字
7. 只返回 JSON 数组，不要 markdown 代码块标记
8. 如果情感数据很少（<3条），生成简单中性叙事即可`

// ══════════════════════════════════════════
//  EmotionalNarrativeService
// ══════════════════════════════════════════

export class EmotionalNarrativeService {
  /** 注入的 TtsService */
  private ttsService: TtsService | null = null

  /** 叙事事件回调（由 IPC handler 注册） */
  private callbacks: NarrativeEventCallbacks = {}

  /** 当前叙事状态 */
  private _state: NarrativeState = 'idle'

  /** 当前叙事进度 */
  private _currentSegment = 0
  private _totalSegments = 0

  /** 中止控制器（用于取消正在进行的叙事） */
  private abortController: AbortController | null = null

  // ══════════════════════════════════════════
  //  公共访问器
  // ══════════════════════════════════════════

  get state(): NarrativeState {
    return this._state
  }

  get currentSegment(): number {
    return this._currentSegment
  }

  get totalSegments(): number {
    return this._totalSegments
  }

  /** 是否正在运行叙事 */
  get isActive(): boolean {
    return this._state === 'generating' || this._state === 'speaking'
  }

  // ══════════════════════════════════════════
  //  依赖注入
  // ══════════════════════════════════════════

  setTtsService(service: TtsService): void {
    this.ttsService = service
  }

  /** 注册叙事事件回调（由 IPC handler 在启动时调用） */
  setCallbacks(cbs: NarrativeEventCallbacks): void {
    this.callbacks = cbs
  }

  // ══════════════════════════════════════════
  //  核心公开 API
  // ══════════════════════════════════════════

  /**
   * 触发情感记忆语音叙事。
   *
   * 完整流程：
   *   1. 从 MemoryEmotionBridge 获取情感上下文
   *   2. 如果数据不足，回退到中性叙事
   *   3. 构建 LLM 提示并调用文本模型生成叙事段落
   *   4. 将段落映射为情感 TTS 参数
   *   5. 逐段播报，每段发射事件
   *
   * @param memoryService MemoryService 实例
   * @returns 成功/失败摘要
   */
  async triggerNarration(memoryService: MemoryService): Promise<{ success: boolean; message: string }> {
    if (this.isActive) {
      return { success: false, message: '正在生成叙事中，请稍后再试' }
    }

    this.abortController = new AbortController()

    try {
      // ── 步骤 1: 获取情感上下文 ──
      this._state = 'generating'
      const emotionContext = memoryEmotionBridge.getRecentEmotionContext(memoryService)
      const timeSeries = emotionTimeSeriesStore.buildTimeSeries(memoryService)

      // ── 步骤 2: 检查数据是否足够 ──
      if (emotionContext.recentEmotions.length < MIN_EMOTION_ENTRIES) {
        return await this.fallbackNeutralNarrative(memoryService, '今天看起来是平静的一天，没有太多情绪波动。希望你过得还不错！')
      }

      // ── 步骤 3: 生成叙事文本 ──
      const narrative = await this.generateNarrativeFromLlm(emotionContext, timeSeries)
      if (!narrative || narrative.segments.length === 0) {
        // LLM 失败，回退到中性叙事
        return await this.fallbackNeutralNarrative(memoryService)
      }

      // ── 步骤 4: 转换为情感 TTS 段落 ──
      const segments = this.buildNarrativeSegments(narrative, emotionContext)

      // ── 步骤 5: 逐段播报 ──
      await this.speakNarrative(segments, emotionContext)

      return { success: true, message: `叙���完成，共 ${segments.length} 个情感段落` }
    } catch (err) {
      log('ERROR', 'emotional_narrative_failed', { error: String(err) })
      this._state = 'error'

      // 尝试用中性叙事收尾
      try {
        if (this.ttsService) {
          this.ttsService.setEmotion({
            voice: 'zh-CN-XiaoxiaoNeural',
            rate: '+10%',
            pitch: '+8Hz',
            label: '叙事·回退',
          })
          await this.ttsService.speak('看来今天的情感数据还不足以生成完整的叙事。下次再聊吧。')
        }
      } catch { /* 静默 */ }

      return { success: false, message: `叙事生成失败: ${err}` }
    } finally {
      if (!this.isActive) {
        this._state = 'idle'
      }
      this.abortController = null
    }
  }

  /**
   * 取消正在进行的叙事播报。
   */
  cancel(): void {
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
    if (this.ttsService) {
      this.ttsService.stop()
    }
    this._state = 'idle'
    this._currentSegment = 0
    this._totalSegments = 0
    this.callbacks.onCancel?.()
    log('INFO', 'emotional_narrative_cancelled')
  }

  /**
   * 获取情感上下文摘要（供调试/UI 展示）。
   */
  getContextSummary(memoryService: MemoryService): {
    dominantLabel: string
    trend: string
    entries: number
  } | null {
    try {
      const context = memoryEmotionBridge.getRecentEmotionContext(memoryService)
      return {
        dominantLabel: context.stats.dominantLabel,
        trend: context.stats.trend,
        entries: context.stats.totalEntries,
      }
    } catch {
      return null
    }
  }

  // ══════════════════════════════════════════
  //  私有方法
  // ══════════════════════════════════════════

  /**
   * 调用 LLM 生成叙事文本。
   */
  private async generateNarrativeFromLlm(
    context: AggregatedEmotionContext,
    timeSeries: Array<{ label: string; snippet: string; timestamp: number }>,
  ): Promise<LlmNarrativeResponse | null> {
    const apiKey = LLM_TEXT_KEY
    if (!apiKey) {
      log('WARN', 'emotional_narrative_no_llm_key')
      return null
    }

    // 构建输入数据
    const emotionEntries = timeSeries
      .slice(-10)
      .map((p) => `- ${new Date(p.timestamp).toLocaleString('zh-CN')} [${p.label}] ${p.snippet.slice(0, 60)}`)
      .join('\n')

    const inputData = `## 情感时间序列\n${emotionEntries || '无详细数据'}\n\n## 聚合统计\n主导情绪: ${context.stats.dominantLabel}\n趋势: ${context.stats.trend}\n总条目: ${context.stats.totalEntries}`

    log('INFO', 'emotional_narrative_llm_start', {
      entries: context.stats.totalEntries,
      dominant: context.stats.dominantLabel,
    })

    const { controller, timer } = createTimeoutSignal(LLM_TIMEOUT_MS)

    try {
      const res = await fetch(LLM_TEXT_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: LLM_TEXT_MODEL,
          messages: [
            { role: 'system', content: NARRATIVE_PROMPT },
            { role: 'user', content: inputData },
          ],
          stream: false,
          temperature: 0.7,
          max_tokens: 500,
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        log('WARN', 'emotional_narrative_llm_error', { status: res.status })
        return null
      }

      const data = (await res.json()) as { choices?: Array<{ message: { content: string } }> }
      const reply = data.choices?.[0]?.message?.content?.trim() || ''

      if (!reply) return null

      // 解析 LLM 返回的 JSON
      return this.parseLlmResponse(reply)
    } catch (err) {
      log('WARN', 'emotional_narrative_llm_failed', { error: String(err) })
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 解析 LLM 返回的叙事 JSON。
   * 兼容带/不带 markdown 代码块标记。
   */
  private parseLlmResponse(reply: string): LlmNarrativeResponse | null {
    try {
      // 移除可能的 markdown 代码块
      let json = reply.trim()
      if (json.startsWith('```')) {
        json = json.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
      }

      const parsed = JSON.parse(json)

      // 兼容数组格式（只有 segments）和对象格式（含 trendDescription）
      let segments: Array<{ text: string; emotion: string }>
      let trendDescription = '平稳'

      if (Array.isArray(parsed)) {
        segments = parsed
      } else if (parsed.segments && Array.isArray(parsed.segments)) {
        segments = parsed.segments
        trendDescription = parsed.trendDescription || '平稳'
      } else {
        return null
      }

      // 验证并过滤
      const validSegments = segments
        .filter((s) => s.text && s.text.length >= MIN_SEGMENT_CHARS)
        .slice(0, MAX_NARRATIVE_SEGMENTS)
        .map((s) => ({
          text: s.text.trim(),
          emotion: this.validateEmotionLabel(s.emotion),
        }))

      if (validSegments.length === 0) return null

      log('INFO', 'emotional_narrative_parsed', {
        segments: validSegments.length,
        trend: trendDescription,
      })

      return { segments: validSegments, trendDescription }
    } catch {
      log('WARN', 'emotional_narrative_parse_failed', { snippet: reply.slice(0, 100) })
      return null
    }
  }

  /**
   * 验证并规范化情感标签。
   */
  private validateEmotionLabel(label: string): string {
    const valid = ['happy', 'sad', 'angry', 'calm', 'anxious', 'neutral']
    const lower = label.toLowerCase().trim()
    if (valid.includes(lower)) return lower

    // 模糊匹配
    if (lower.includes('happy') || lower.includes('开心') || lower.includes('高兴')) return 'happy'
    if (lower.includes('sad') || lower.includes('悲伤') || lower.includes('难过') || lower.includes('失落')) return 'sad'
    if (lower.includes('angry') || lower.includes('生气') || lower.includes('愤怒')) return 'angry'
    if (lower.includes('calm') || lower.includes('平静') || lower.includes('放松')) return 'calm'
    if (lower.includes('anx') || lower.includes('焦虑') || lower.includes('紧张')) return 'anxious'
    return 'neutral'
  }

  /**
   * 将 LLM 叙事段落转换为情感 TTS 段落。
   */
  private buildNarrativeSegments(
    narrative: LlmNarrativeResponse,
    context: AggregatedEmotionContext,
  ): NarrativeEmotionSegment[] {
    const segments: NarrativeEmotionSegment[] = []
    const total = narrative.segments.length
    const initialArousal = context.recentEmotions.length > 0
      ? context.recentEmotions[0].arousal
      : 0

    for (let i = 0; i < total; i++) {
      const seg = narrative.segments[i]
      const t = total > 1 ? i / (total - 1) : 0

      // 情感标签 → EmotionVector
      const emotionVector = this.labelToEmotionVector(seg.emotion, t, initialArousal)

      // EmotionVector → VoiceStyle
      const style = speakingStyleGenerator.vectorToVoiceStyle(emotionVector)

      // 风格强度
      const styleDegree = Math.min(1.0, (Math.abs(emotionVector.valence) + Math.abs(emotionVector.arousal)) / 2)

      segments.push({
        text: seg.text,
        style,
        styleDegree,
        emotionVector,
        speakingStyle: SPEAKING_STYLE_VOICE_MAP[style],
      })
    }

    return segments
  }

  /**
   * 情感标签 → EmotionVector 映射。
   * 结合标签默认值和时间位置 t 做微调，实现情感过渡。
   */
  private labelToEmotionVector(label: string, t: number, initialArousal: number): EmotionVector {
    const defaults: Record<string, EmotionVector> = {
      happy: { valence: 0.7, arousal: 0.6 },
      sad: { valence: -0.6, arousal: -0.4 },
      angry: { valence: -0.5, arousal: 0.7 },
      calm: { valence: 0.2, arousal: -0.5 },
      anxious: { valence: -0.3, arousal: 0.5 },
      neutral: { valence: 0.0, arousal: 0.0 },
    }

    const base = defaults[label] || defaults.neutral

    // 在叙事中线性微调：起始段贴近用户状态，后续段逐渐趋向积极
    const trendBoost = t * 0.15 // 最后一段 +0.15 valance
    const arousalBoost = t * 0.1 - initialArousal * (1 - t) * 0.2

    return {
      valence: Math.max(-1, Math.min(1, base.valence + trendBoost)),
      arousal: Math.max(-1, Math.min(1, base.arousal + arousalBoost)),
    }
  }

  /**
   * 逐段播报叙事，每段发射事件。
   */
  private async speakNarrative(
    segments: NarrativeEmotionSegment[],
    context: AggregatedEmotionContext,
  ): Promise<void> {
    const tts = this.ttsService
    if (!tts) {
      log('WARN', 'emotional_narrative_no_tts')
      return
    }

    this._state = 'speaking'
    this._currentSegment = 0
    this._totalSegments = segments.length
    const signal = this.abortController?.signal

    // 触发开始回调
    this.callbacks.onStart?.({
      trend: context.stats.trend,
      totalSegments: segments.length,
      contextSummary: `主导情绪: ${context.stats.dominantLabel}, 趋势: ${context.stats.trend}`,
    })

    for (let i = 0; i < segments.length; i++) {
      if (signal?.aborted) {
        log('INFO', 'emotional_narrative_aborted', { segment: i })
        break
      }

      const seg = segments[i]
      this._currentSegment = i

      // 使用 SpeakingStyleGenerator 生成 StyledTtsSegment
      const styledSegments = speakingStyleGenerator.generateFromCurve(
        { segments: [seg], trendDescription: context.stats.trend },
        { voice: 'zh-CN-XiaoxiaoNeural', rate: '+10%', pitch: '+8Hz', label: '叙事' },
        true, // 云端模式
      )

      const styled = styledSegments.segments[0]
      if (!styled) continue

      // 设置情感 TTS 参数
      tts.setEmotion(styled.params)

      // 触发段落回调（供波形动画消费）
      const segmentEvent: NarrativeSegmentEvent = {
        text: seg.text,
        index: i,
        total: segments.length,
        label: this.vectorToLabel(seg.emotionVector),
        emotionVector: seg.emotionVector,
        ttsParams: styled.params,
        durationMs: styled.estimatedDurationMs,
      }
      this.callbacks.onSegment?.(segmentEvent)

      log('INFO', 'emotional_narrative_speaking', {
        segment: i + 1,
        total: segments.length,
        style: seg.style,
        emotionLabel: segmentEvent.label,
        text: seg.text.slice(0, 40),
      })

      // 播报当前段落（使用当前 emotionParams）
      await tts.speak(seg.text)
    }

    // 触发结束回调
    const success = !signal?.aborted
    this.callbacks.onEnd?.({
      totalSegments: this._currentSegment + 1,
      totalDurationMs: 0,
      success,
    })

    this._state = success ? 'done' : 'idle'
    this._currentSegment = 0
  }

  /**
   * 情感向量 → 中文简短标签。
   */
  private vectorToLabel(vector: EmotionVector): string {
    for (const rule of VECTOR_TO_LABEL) {
      if (
        vector.valence >= rule.minValence &&
        vector.valence <= rule.maxValence &&
        vector.arousal >= rule.minArousal &&
        vector.arousal <= rule.maxArousal
      ) {
        return rule.label
      }
    }
    return '中性'
  }

  /**
   * 回退到中性叙事（情感数据不足或 LLM 失败时使用）。
   */
  private async fallbackNeutralNarrative(
    memoryService: MemoryService,
    customText?: string,
  ): Promise<{ success: boolean; message: string }> {
    const tts = this.ttsService
    if (!tts) {
      return { success: false, message: 'TTS 未就绪' }
    }

    // 尝试获取一些上下文让叙事不那么生硬
    const context = memoryEmotionBridge.getRecentEmotionContext(memoryService)
    const timeOfDay = this.getTimeOfDay()

    let text: string
    if (customText) {
      text = customText
    } else if (context.stats.totalEntries > 0) {
      const labelCN = this.emotionLabelToChinese(context.stats.dominantLabel)
      const trendCN = context.stats.trend === 'rising' ? '情绪整体不错'
        : context.stats.trend === 'falling' ? '情绪有些起伏'
        : '情绪比较平稳'
      text = `${timeOfDay}感觉你的${trendCN}，${labelCN}的时刻居多。希望你接下来的时间也能保持好心情。`
    } else {
      text = `${timeOfDay}看起来是个普通的一天。有什么想和我聊聊的吗？`
    }

    tts.setEmotion({
      voice: 'zh-CN-XiaoxiaoNeural',
      rate: '+8%',
      pitch: '+6Hz',
      label: '叙事·中性回退',
    })

    await tts.speak(text)

    return { success: true, message: '叙事完成（中性回退）' }
  }

  /**
   * 获取当前时段描述。
   */
  private getTimeOfDay(): string {
    const hour = new Date().getHours()
    if (hour < 6) return '深夜了，'
    if (hour < 9) return '早上好，'
    if (hour < 12) return '上午好，'
    if (hour < 14) return '中午好，'
    if (hour < 18) return '下午好，'
    if (hour < 22) return '晚上好，'
    return '夜深了，'
  }

  /**
   * 情感标签 → 中文。
   */
  private emotionLabelToChinese(label: string): string {
    const map: Record<string, string> = {
      happy: '开心',
      sad: '悲伤',
      angry: '生气',
      calm: '平静',
      anxious: '焦虑',
      neutral: '中性',
    }
    return map[label] || label
  }
}

/** 全局单例 */
export const emotionalNarrativeService = new EmotionalNarrativeService()
