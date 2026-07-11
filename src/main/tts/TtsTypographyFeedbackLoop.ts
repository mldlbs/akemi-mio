/**
 * TtsTypographyFeedbackLoop — TTS ↔ Plan:工业颂歌 公众号排版处理 强化回路
 *
 * 职责：
 * 1. 消费 TTS 执行输出作为「公众号排版处理」的反馈信号
 * 2. 将用户隐式反馈（重听/跳过/中断/自然完成）映射为排版质量指标
 * 3. 根据累积的排版质量指标调整 TypographyMemory 参数
 * 4. 使用 EMA 阻尼防止反馈振荡发散
 * 5. 初始阶段人工监控闭环稳定性，收敛后转为自动运行
 *
 * 回路循环：
 *   TTS 播放完成 → EventBus 事件 → TtsTypographyFeedbackLoop
 *     → 隐式反馈关联 → 排版质量评分 → 阻尼分析
 *     → TypographyMemory 参数调整 → 排版上下文优化
 *     → 下次 TTS 输入文本更干净 → 更好的 TTS 输出质量
 *
 * 阻尼机制（复用 ToolFeedbackLoop 已验证模式）：
 * - EMA 平滑：alpha 默认 0.3
 * - 最小样本量：达到前不输出调整
 * - 收敛检测：EMA 变化率持续低于阈值
 * - 振荡防护：方向变化超过阈值时降低 alpha
 * - 滞回区：参数切换需跨越阈值带
 *
 * 排版指标映射：
 *   SKIP / INTERRUPT → 对应排版参数负向信号
 *   REPLAY → 正向信号，当前排版参数获得确认
 *   COMPLETED_NATURALLY → 正向信号
 */

import { log } from '../logger/Logger'
import { eventBus, SubscriptionTracker } from '../core/EventBus'
import { TypographyMemoryManager, TypographyParameters } from '../creativity/TypographyMemoryManager'
import type { ImplicitFeedbackAction } from './types'
import { implicitFeedbackTracker } from './ImplicitFeedbackTracker'

// ══════════════════════════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════════════════════════

/** 排版参数 — 反馈回路可调整的关键参数 */
export type AdjustableTypographyParam = keyof Pick<
  TypographyParameters,
  'sentenceDensity' | 'citationStyle' | 'introLength' | 'paragraphSpacing' | 'emphasisStyle'
>

/** 排版参数值及其可选范围 */
const PARAM_OPTIONS: Record<AdjustableTypographyParam, readonly string[]> = {
  sentenceDensity: ['dense', 'normal', 'sparse'] as const,
  citationStyle: ['blockquote', 'indent', 'inline_quote', 'none'] as const,
  introLength: ['none', 'short', 'medium', 'long'] as const,
  paragraphSpacing: ['compact', 'normal', 'wide'] as const,
  emphasisStyle: ['bold', 'color_mark', 'bg_mark', 'none'] as const,
}

/** 单次 TTS → 排版反馈样本 */
interface TypographyFeedbackSample {
  /** 关联的故事 ID（如 "工业颂歌"） */
  storyId: string
  /** 平台标签（如 "公众号"） */
  platformTag: string
  /** TTS 隐式反馈动作 */
  action: ImplicitFeedbackAction
  /** 当时的排版参数（从 ImplicitFeedbackTracker 上下文获取） */
  typographyParams: Partial<TypographyParameters>
  /** 时间戳 */
  timestamp: number
}

/** EMA 排版质量状态 */
interface TtsTypographyEMAState {
  /** 当前 EMA 正向率（0-1），越高表示排版质量越好 */
  emaPositiveRate: number
  /** 累计样本数 */
  sampleCount: number
  /** 上次更新时间戳 */
  lastUpdated: number
  /** 上一次的 EMA 值（用于收敛检测） */
  prevEmaValue: number
  /** 振荡检测：方向变化历史 */
  recentDirectionChanges: number[]
  /** 当前每个排版参数的累积正向率 */
  paramPositiveRates: Partial<Record<AdjustableTypographyParam, number>>
  /** 每个参数的建议调整方向（1=升档，-1=降档，0=维持） */
  paramAdjustmentDirection: Partial<Record<AdjustableTypographyParam, -1 | 0 | 1>>
  /** 各参数样本数 */
  paramSampleCounts: Partial<Record<AdjustableTypographyParam, number>>
}

// ══════════════════════════════════════════════════════════════
//  配置常量
// ══════════════════════════════════════════════════════════════

/** EMA 平滑因子（默认 0.3 = 更依赖近期数据） */
const DEFAULT_ALPHA = 0.3

/** 最小样本量：达到后输出第一次调整建议 */
const MIN_SAMPLES_FOR_ADJUSTMENT = 5

/** 收敛检测：最近 N 个样本的 EMA 变化率均低于此值视为收敛 */
const CONVERGENCE_RATE_THRESHOLD = 0.02

/** 收敛检测窗口大小 */
const CONVERGENCE_WINDOW = 5

/** 振荡防护：最近 N 个样本中方向变化超过此值 → 降低 alpha */
const OSCILLATION_DIRECTION_CHANGES = 4

/** 振荡检测窗口大小 */
const OSCILLATION_WINDOW = 10

/** 振荡时降低到的基础 alpha */
const OSCILLATION_REDUCED_ALPHA = 0.1

/** 评估周期 ms（默认 30s，不每次事件都评估） */
const EVALUATION_INTERVAL_MS = 30_000

/** 正向信号阈值：高于此值表示当前排版参数工作良好 */
const POSITIVE_SIGNAL_THRESHOLD = 0.65

/** 负向信号阈值：低于此值表示需要调整排版参数 */
const NEGATIVE_SIGNAL_THRESHOLD = 0.4

/** 隐式反馈动作 → 正向/负向信号映射 */
const FEEDBACK_WEIGHTS: Record<ImplicitFeedbackAction, number> = {
  REPLAY: 0.9,               // 重听 = 强烈正向
  COMPLETED_NATURALLY: 0.7,  // 自然完成 = 正向
  CONTINUE_CONVERSATION: 0.6, // 继续对话 = 正向
  MODIFY_REQUEST: 0.3,       // 修改指令 = 轻微正向（可能想要不同风格）
  INTERRUPT_SPEECH: 0.2,     // 打断 = 轻微负向
  SKIP: 0.15,                // 跳过 = 负向
}

/** 默认故事/平台（工业颂歌 公众号） */
const DEFAULT_STORY_ID = '工业颂歌'
const DEFAULT_PLATFORM_TAG = '公众号'

/** 最大调整记录数 */
const MAX_ADJUSTMENT_HISTORY = 50

// ══════════════════════════════════════════════════════════════
//  配置接口
// ══════════════════════════════════════════════════════════════

export interface TtsTypographyFeedbackLoopConfig {
  /** EMA 平滑因子（0-1），默认 0.3 */
  alpha?: number
  /** 最小样本量，默认 5 */
  minSamples?: number
  /** 正向信号阈值，默认 0.65 */
  positiveThreshold?: number
  /** 负向信号阈值，默认 0.4 */
  negativeThreshold?: number
  /** 评估间隔 ms，默认 30000 */
  evaluationIntervalMs?: number
  /** 目标故事 ID，默认 "工业颂歌" */
  storyId?: string
  /** 目标平台标签，默认 "公众号" */
  platformTag?: string
  /** 调试模式 */
  debug?: boolean
  /** 初始运行模式：'manual'（人工监控）| 'auto'（自动运行） */
  mode?: 'manual' | 'auto'
}

// ══════════════════════════════════════════════════════════════
//  质量报告类型
// ══════════════════════════════════════════════════════════════

export interface TtsTypographyQualityReport {
  storyId: string
  platformTag: string
  totalSamples: number
  emaPositiveRate: number
  convergenceStatus: 'converging' | 'stable' | 'oscillating' | 'insufficient_data'
  paramDetails: Array<{
    paramName: AdjustableTypographyParam
    positiveRate: number
    sampleCount: number
    recommendedDirection: -1 | 0 | 1
  }>
  recommendedAction: 'none' | 'adjust_typography'
  recentAdjustments: number
}

export interface TtsTypographyLoopDiagnostics {
  mode: 'manual' | 'auto'
  alpha: number
  storyId: string
  platformTag: string
  totalSamples: number
  emaPositiveRate: number
  convergenceStatus: string
  recentAdjustments: Array<{ action: string; params: string; at: number; reason: string }>
}

// ══════════════════════════════════════════════════════════════
//  核心服务
// ══════════════════════════════════════════════════════════════

export class TtsTypographyFeedbackLoop {
  private config: Required<TtsTypographyFeedbackLoopConfig>
  private state: TtsTypographyEMAState
  private subs = new SubscriptionTracker()
  private lastEvaluationTime = 0
  private recentAdjustments: Array<{ action: string; params: string; at: number; reason: string }> = []
  private typographyManager: TypographyMemoryManager

  constructor(config?: TtsTypographyFeedbackLoopConfig) {
    this.config = {
      alpha: config?.alpha ?? DEFAULT_ALPHA,
      minSamples: config?.minSamples ?? MIN_SAMPLES_FOR_ADJUSTMENT,
      positiveThreshold: config?.positiveThreshold ?? POSITIVE_SIGNAL_THRESHOLD,
      negativeThreshold: config?.negativeThreshold ?? NEGATIVE_SIGNAL_THRESHOLD,
      evaluationIntervalMs: config?.evaluationIntervalMs ?? EVALUATION_INTERVAL_MS,
      storyId: config?.storyId ?? DEFAULT_STORY_ID,
      platformTag: config?.platformTag ?? DEFAULT_PLATFORM_TAG,
      debug: config?.debug ?? false,
      mode: config?.mode ?? 'manual',
    }

    this.state = this.createInitialState()
    this.typographyManager = new TypographyMemoryManager()

    log('INFO', 'tts_typography_feedback_loop_created', {
      mode: this.config.mode,
      storyId: this.config.storyId,
      platformTag: this.config.platformTag,
      alpha: this.config.alpha,
      minSamples: this.config.minSamples,
    })
  }

  // ══════════════════════════════════════════════════════════════
  //  生命周期
  // ══════════════════════════════════════════════════════════════

  /** 启动反馈回路：订阅 EventBus TTS 事件 */
  start(): void {
    eventBus.track(
      'tts.playback.started',
      () => this.onTtsPlaybackStarted(),
      this.subs,
      'tts_typography_loop:playback_start',
    )
    eventBus.track(
      'tts.playback.finished',
      () => this.onTtsPlaybackFinished(),
      this.subs,
      'tts_typography_loop:playback_finish',
    )

    log('INFO', 'tts_typography_feedback_loop_started', {
      mode: this.config.mode,
      storyId: this.config.storyId,
    })
  }

  /** 停止反馈回路 */
  stop(): void {
    this.subs.dispose()
    this.reset()
    log('INFO', 'tts_typography_feedback_loop_stopped')
  }

  /** 切换运行模式 */
  setMode(mode: 'manual' | 'auto'): void {
    this.config.mode = mode
    log('INFO', 'tts_typography_loop_mode_changed', { mode })
  }

  /** 更新配置 */
  updateConfig(patch: Partial<TtsTypographyFeedbackLoopConfig>): void {
    if (patch.alpha !== undefined) this.config.alpha = patch.alpha
    if (patch.minSamples !== undefined) this.config.minSamples = patch.minSamples
    if (patch.positiveThreshold !== undefined) this.config.positiveThreshold = patch.positiveThreshold
    if (patch.negativeThreshold !== undefined) this.config.negativeThreshold = patch.negativeThreshold
    if (patch.evaluationIntervalMs !== undefined) this.config.evaluationIntervalMs = patch.evaluationIntervalMs
    if (patch.storyId !== undefined) this.config.storyId = patch.storyId
    if (patch.platformTag !== undefined) this.config.platformTag = patch.platformTag
    if (patch.debug !== undefined) this.config.debug = patch.debug
    if (patch.mode !== undefined) this.config.mode = patch.mode
    log('INFO', 'tts_typography_loop_config_updated', {
      alpha: this.config.alpha,
      mode: this.config.mode,
    })
  }

  // ══════════════════════════════════════════════════════════════
  //  事件处理
  // ══════════════════════════════════════════════════════════════

  /** TTS 播放开始时标记时间 */
  private onTtsPlaybackStarted(): void {
    // 记录开始时间，用于后续计算播放时长
    if (this.config.debug) {
      log('DEBUG', 'tts_typography_playback_start')
    }
  }

  /** TTS 播放完成时触发评估节流 */
  private onTtsPlaybackFinished(): void {
    const now = Date.now()

    // 定期执行策略评估（节流）
    if (now - this.lastEvaluationTime >= this.config.evaluationIntervalMs) {
      this.lastEvaluationTime = now
      this.evaluateAndAdjust().catch((err) =>
        log('WARN', 'tts_typography_evaluation_error', { error: String(err) }),
      )
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  反馈样本记录
  // ══════════════════════════════════════════════════════════════

  /**
   * 记录一次 TTS 隐式反馈样本。
   * 由外部（如 ChatExecutor 或 ImplicitFeedbackTracker）在用户产生反馈时调用。
   *
   * @param action 隐式反馈动作
   * @param storyId 故事 ID（可选，默认 "工业颂歌"）
   * @param platformTag 平台标签（可选，默认 "公众号"）
   */
  recordFeedback(
    action: ImplicitFeedbackAction,
    storyId?: string,
    platformTag?: string,
  ): void {
    const now = Date.now()
    const sid = storyId || this.config.storyId
    const pt = platformTag || this.config.platformTag

    // 1. 获取当前的排版参数
    const records = this.typographyManager.queryRecords(sid, pt, { limit: 1 })
    const currentParams: Partial<TypographyParameters> = records.length > 0
      ? { ...records[0].parameters }
      : {}

    // 2. 更新 EMA 状态
    const signalWeight = FEEDBACK_WEIGHTS[action] ?? 0.5
    this.updateEMA(signalWeight, currentParams, now)

    // 3. 在 auto 模式下立即评估（节流由 onTtsPlaybackFinished 处理）
    if (this.config.mode === 'auto') {
      const elapsed = now - this.lastEvaluationTime
      if (elapsed >= this.config.evaluationIntervalMs) {
        this.lastEvaluationTime = now
        this.evaluateAndAdjust().catch((err) =>
          log('WARN', 'tts_typography_evaluation_error', { error: String(err) }),
        )
      }
    }

    if (this.config.debug) {
      log('DEBUG', 'tts_typography_feedback_recorded', {
        action,
        storyId: sid,
        sampleCount: this.state.sampleCount,
        emaPositiveRate: Math.round(this.state.emaPositiveRate * 100),
      })
    }
  }

  /**
   * 便捷方法：从 ImplicitFeedbackTracker 同步反馈信号。
   * 当系统检测到用户自然完成了对话或 TTS 播放时，
   * 通过此方法将 COMPLETED_NATURALLY 反馈注入回路。
   */
  recordFromTracker(): void {
    const trackerStatus = implicitFeedbackTracker.getStatus()

    if (trackerStatus.modelInitialized && trackerStatus.totalSamples > 0) {
      // 只要模型已初始化且有样本，说明用户有自然的交互行为 →
      // 注入一个中度正向信号，表示当前排版在听觉体验上是可接受的
      this.recordFeedback('CONTINUE_CONVERSATION')
    }

    if (this.config.debug) {
      log('DEBUG', 'tts_typography_tracker_sync', {
        modelInitialized: trackerStatus.modelInitialized,
        totalSamples: trackerStatus.totalSamples,
        feedbackRecorded: trackerStatus.modelInitialized && trackerStatus.totalSamples > 0,
      })
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  EMA 状态管理
  // ══════════════════════════════════════════════════════════════

  private createInitialState(): TtsTypographyEMAState {
    return {
      emaPositiveRate: 0.5,
      sampleCount: 0,
      lastUpdated: 0,
      prevEmaValue: 0.5,
      recentDirectionChanges: [],
      paramPositiveRates: {},
      paramAdjustmentDirection: {},
      paramSampleCounts: {},
    }
  }

  /**
   * 更新 EMA 状态，纳入一次新样本。
   */
  private updateEMA(
    signalWeight: number,
    currentParams: Partial<TypographyParameters>,
    timestamp: number,
  ): void {
    const prevEma = this.state.emaPositiveRate
    this.state.sampleCount++
    this.state.prevEmaValue = prevEma
    this.state.lastUpdated = timestamp

    // 计算新的 EMA 值
    const newEma = this.computeEMA(prevEma, signalWeight)
    this.state.emaPositiveRate = newEma

    // 检测方向变化（用于振荡防护）
    const direction = newEma > prevEma ? 1 : (newEma < prevEma ? -1 : 0)
    if (direction !== 0) {
      this.state.recentDirectionChanges.push(direction)
      if (this.state.recentDirectionChanges.length > OSCILLATION_WINDOW) {
        this.state.recentDirectionChanges = this.state.recentDirectionChanges.slice(-OSCILLATION_WINDOW)
      }
    }

    // 更新各排版参数的累积评分
    for (const [key, value] of Object.entries(currentParams)) {
      if (value === undefined || value === null) continue
      const paramName = key as AdjustableTypographyParam
      if (!PARAM_OPTIONS[paramName]) continue

      const currentRate = this.state.paramPositiveRates[paramName] ?? 0.5
      const currentCount = this.state.paramSampleCounts[paramName] ?? 0
      const newCount = currentCount + 1

      // 增量更新平均值
      const newRate = currentRate + (signalWeight - currentRate) / newCount
      this.state.paramPositiveRates[paramName] = newRate
      this.state.paramSampleCounts[paramName] = newCount

      // 推断调整方向
      if (newCount >= this.config.minSamples) {
        if (newRate < this.config.negativeThreshold) {
          // 负向信号 → 当前参数可能不理想，建议向相邻值调整
          // 如果是值序列中的第一个 → 升档；最后一个 → 降档；中间 → 两边尝试
          this.state.paramAdjustmentDirection[paramName] = this.inferAdjustmentDirection(paramName, value as string)
        } else if (newRate >= this.config.positiveThreshold) {
          this.state.paramAdjustmentDirection[paramName] = 0 // 维持
        }
      }
    }
  }

  /**
   * 根据当前参数值和位置推断调整方向。
   * 如果是选项列表中的首位 → +1（升档），末位 → -1（降档），中间 → 维持。
   */
  private inferAdjustmentDirection(param: AdjustableTypographyParam, currentValue: string): -1 | 0 | 1 {
    const options = PARAM_OPTIONS[param]
    if (!options || options.length <= 1) return 0

    const index = options.indexOf(currentValue)
    if (index === 0) return 1    // 第一个选项 → 增大
    if (index === options.length - 1) return -1  // 最后一个选项 → 减小
    return 0  // 中间选项 → 维持先不动
  }

  // ══════════════════════════════════════════════════════════════
  //  EMA 计算与收敛检测
  // ══════════════════════════════════════════════════════════════

  private computeEMA(prev: number, value: number): number {
    const alpha = this.getEffectiveAlpha()
    return alpha * value + (1 - alpha) * prev
  }

  private getEffectiveAlpha(): number {
    if (this.detectOscillation()) {
      return OSCILLATION_REDUCED_ALPHA
    }
    return this.config.alpha
  }

  private detectOscillation(): boolean {
    const changes = this.state.recentDirectionChanges.slice(-OSCILLATION_WINDOW)
    if (changes.length < 4) return false

    let flipCount = 0
    for (let i = 1; i < changes.length; i++) {
      if (changes[i] !== 0 && changes[i] !== changes[i - 1]) {
        flipCount++
      }
    }
    return flipCount >= OSCILLATION_DIRECTION_CHANGES
  }

  private detectConvergence(): 'converging' | 'stable' | 'oscillating' | 'insufficient_data' {
    if (this.state.sampleCount < this.config.minSamples) {
      return 'insufficient_data'
    }

    if (this.detectOscillation()) {
      return 'oscillating'
    }

    const recentChanges = this.state.recentDirectionChanges.slice(-CONVERGENCE_WINDOW)
    if (recentChanges.length < CONVERGENCE_WINDOW) {
      return 'converging'
    }

    const allStable = recentChanges.every((c) => c === 0)
    if (allStable) {
      return 'stable'
    }

    return 'converging'
  }

  // ══════════════════════════════════════════════════════════════
  //  策略评估与参数调整
  // ══════════════════════════════════════════════════════════════

  /**
   * 评估当前状态并决定是否调整排版参数。
   */
  private async evaluateAndAdjust(): Promise<void> {
    const convergence = this.detectConvergence()

    // 样本不足或仍在振荡时不做调整
    if (convergence === 'insufficient_data') {
      if (this.config.debug) {
        log('DEBUG', 'tts_typography_eval_insufficient', {
          samples: this.state.sampleCount,
          needed: this.config.minSamples,
        })
      }
      return
    }

    if (convergence === 'oscillating') {
      log('WARN', 'tts_typography_oscillation_detected', {
        samples: this.state.sampleCount,
        alphaReduced: true,
      })
      return
    }

    // 检查是否需要调整排版参数
    const needsAdjustment = this.shouldAdjustTypography()

    if (!needsAdjustment) {
      if (this.config.debug) {
        log('DEBUG', 'tts_typography_eval_no_adjustment', {
          emaRate: Math.round(this.state.emaPositiveRate * 100),
          threshold: Math.round(this.config.negativeThreshold * 100),
        })
      }
      return
    }

    // 构建调整参数
    const adjustedParams = this.buildAdjustedParams()

    // manual 模式：记录日志供人工确认
    if (this.config.mode === 'manual') {
      const paramSummary = Object.entries(adjustedParams)
        .map(([k, v]) => `${k}:${String(v)}`)
        .join(', ')
      log('INFO', 'tts_typography_manual_suggest', {
        storyId: this.config.storyId,
        platformTag: this.config.platformTag,
        emaRate: Math.round(this.state.emaPositiveRate * 100),
        suggestedParams: paramSummary,
        convergence,
        message: `【人工监控】建议更新排版参数：${paramSummary}`,
      })
      return
    }

    // auto 模式：自动执行调整
    await this.applyTypographyAdjustment(adjustedParams, convergence)
  }

  /**
   * 判断是否需要调整排版参数。
   * 条件：整体 EMA 正向率低于负向阈值，且有足够的样本。
   */
  private shouldAdjustTypography(): boolean {
    if (this.state.sampleCount < this.config.minSamples) return false

    // 全局正向率过低 → 需要调整
    if (this.state.emaPositiveRate < this.config.negativeThreshold) return true

    // 单个排版参数正向率过低 → 需要调整
    for (const paramName of Object.keys(PARAM_OPTIONS) as AdjustableTypographyParam[]) {
      const rate = this.state.paramPositiveRates[paramName]
      const count = this.state.paramSampleCounts[paramName]
      if (count && count >= this.config.minSamples && rate !== undefined && rate < this.config.negativeThreshold) {
        return true
      }
    }

    return false
  }

  /**
   * 构建调整后的排版参数。
   * 对需要调整的参数逐一生成建议值，未采样/评分达标的参数继承基线值。
   */
  private buildAdjustedParams(): TypographyParameters {
    // 获取当前排版参数作为基线
    const records = this.typographyManager.queryRecords(
      this.config.storyId,
      this.config.platformTag,
      { limit: 1 },
    )
    const baseFallback: TypographyParameters = {
      sentenceDensity: 'normal',
      citationStyle: 'blockquote',
      introLength: 'medium',
      paragraphSpacing: 'normal',
      emphasisStyle: 'bold',
      listStyle: 'bullet',
      sectionDivider: 'line',
      imageCaption: 'below_center',
    }
    const base: TypographyParameters = records.length > 0
      ? { ...baseFallback, ...records[0].parameters }
      : { ...baseFallback }

    const result: TypographyParameters = { ...base }

    for (const paramName of Object.keys(PARAM_OPTIONS) as AdjustableTypographyParam[]) {
      const rate = this.state.paramPositiveRates[paramName]
      const count = this.state.paramSampleCounts[paramName]
      const direction = this.state.paramAdjustmentDirection[paramName]

      // 只有样本充足且评分偏低的参数才调整
      if (count && count >= this.config.minSamples && rate !== undefined
        && rate < this.config.negativeThreshold && direction !== 0) {
        const currentValue = base[paramName]
        if (currentValue && typeof currentValue === 'string') {
          const adjusted = this.adjustParamValue(paramName, currentValue, direction)
          if (adjusted !== currentValue) {
            result[paramName] = adjusted as any
          }
        }
      }
    }

    return result
  }

  /**
   * 沿选项序列调整参数值。
   * direction=1 → 下一个选项（更宽松/更多），-1 → 上一个选项（更紧凑/更少）
   */
  private adjustParamValue(param: AdjustableTypographyParam, current: string, direction: -1 | 0 | 1): string {
    const options = PARAM_OPTIONS[param]
    if (!options || options.length <= 1 || direction === 0) return current

    const index = options.indexOf(current)
    if (index === -1) return current

    const newIndex = Math.max(0, Math.min(options.length - 1, index + direction))
    return options[newIndex]
  }

  /**
   * 将调整后的排版参数写入 TypographyMemory。
   */
  private async applyTypographyAdjustment(
    adjustedParams: TypographyParameters,
    convergence: string,
  ): Promise<void> {
    // 检查是否有实际变更
    const changedParams = Object.entries(adjustedParams).filter(
      ([key, value]) => {
        const records = this.typographyManager.queryRecords(
          this.config.storyId,
          this.config.platformTag,
          { limit: 1 },
        )
        if (records.length === 0) return true
        return String(records[0].parameters[key as keyof TypographyParameters]) !== String(value)
      },
    )

    if (changedParams.length === 0) {
      log('INFO', 'tts_typography_adjust_no_change', {
        storyId: this.config.storyId,
      })
      return
    }

    const paramSummary = changedParams.map(([k, v]) => `${k}:${String(v)}`).join(', ')
    const reason = `TTS 反馈自动调整（EMA正向率=${Math.round(this.state.emaPositiveRate * 100)}%，收敛=${convergence}，样本=${this.state.sampleCount}）`

    // 以 source='evolution' 保存到 TypographyMemory
    this.typographyManager.saveRecord({
      storyId: this.config.storyId,
      platformTag: this.config.platformTag,
      chapterNumber: -1, // 特殊章节号表示来自进化调整
      chapterTitle: 'TTS反馈自动调整',
      parameters: adjustedParams,
      source: 'evolution',
      userCorrections: reason,
      createdAt: Date.now(),
    })

    // 记录调整历史
    this.recentAdjustments.push({
      action: 'adjust_typography',
      params: paramSummary,
      at: Date.now(),
      reason,
    })
    if (this.recentAdjustments.length > MAX_ADJUSTMENT_HISTORY) {
      this.recentAdjustments = this.recentAdjustments.slice(-MAX_ADJUSTMENT_HISTORY)
    }

    log('INFO', 'tts_typography_adjustment_applied', {
      storyId: this.config.storyId,
      platformTag: this.config.platformTag,
      params: paramSummary,
      emaRate: Math.round(this.state.emaPositiveRate * 100),
      convergence,
      samples: this.state.sampleCount,
    })
  }

  // ══════════════════════════════════════════════════════════════
  //  诊断接口
  // ══════════════════════════════════════════════════════════════

  /**
   * 生成质量报告（供人工监控）。
   */
  generateReport(): TtsTypographyQualityReport {
    const convergence = this.detectConvergence()
    const paramDetails: TtsTypographyQualityReport['paramDetails'] = []

    for (const paramName of Object.keys(PARAM_OPTIONS) as AdjustableTypographyParam[]) {
      paramDetails.push({
        paramName,
        positiveRate: this.state.paramPositiveRates[paramName] ?? 0.5,
        sampleCount: this.state.paramSampleCounts[paramName] ?? 0,
        recommendedDirection: this.state.paramAdjustmentDirection[paramName] ?? 0,
      })
    }

    return {
      storyId: this.config.storyId,
      platformTag: this.config.platformTag,
      totalSamples: this.state.sampleCount,
      emaPositiveRate: Math.round(this.state.emaPositiveRate * 1000) / 1000,
      convergenceStatus: convergence,
      paramDetails,
      recommendedAction: this.shouldAdjustTypography() ? 'adjust_typography' : 'none',
      recentAdjustments: this.recentAdjustments.length,
    }
  }

  /**
   * 获取诊断信息。
   */
  getDiagnostics(): TtsTypographyLoopDiagnostics {
    return {
      mode: this.config.mode,
      alpha: this.getEffectiveAlpha(),
      storyId: this.config.storyId,
      platformTag: this.config.platformTag,
      totalSamples: this.state.sampleCount,
      emaPositiveRate: Math.round(this.state.emaPositiveRate * 1000) / 1000,
      convergenceStatus: this.detectConvergence(),
      recentAdjustments: [...this.recentAdjustments].reverse(),
    }
  }

  /** 获取当前配置的只读副本 */
  getConfig(): Readonly<TtsTypographyFeedbackLoopConfig> {
    return { ...this.config }
  }

  /** 重置状态 */
  reset(): void {
    this.state = this.createInitialState()
    this.lastEvaluationTime = 0
    this.recentAdjustments = []
    log('INFO', 'tts_typography_feedback_loop_reset')
  }
}

// ══════════════════════════════════════════════════════════════
//  全局单例
// ══════════════════════════════════════════════════════════════

/** 全局单例，初始为人工监控模式 */
export const ttsTypographyFeedbackLoop = new TtsTypographyFeedbackLoop({
  mode: 'manual',
})
