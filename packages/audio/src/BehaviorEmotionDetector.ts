/**
 * BehaviorEmotionDetector — 基于实时用户交互行为的情绪检测器
 *
 * 持续采集用户物理交互指标（APM、窗口切换频率、鼠标抖动度），
 * 映射到行为情绪标签（焦躁/平静/专注/中性），为 TTS 情感自适应
 * 提供额外的情绪维度。
 *
 * 与 SentimentAnalyzer（内容情感）互补：
 *   - SentimentAnalyzer: AI 回复说了什么 → 正面/负面/中性
 *   - BehaviorEmotionDetector: 用户怎么交互 → 焦躁/平静/专注/中性
 *
 * 检测流程：
 *   1. 滑动窗口采集指标（默认 60s）
 *   2. 阈值规则映射到情绪标签
 *   3. 置信度评估（基于数据充足性）
 *   4. 输出 TTS 参数预设
 *
 * 集成点：
 *   - ChatExecutor.run() → detector.recordInteraction() 记录每次用户交互
 *   - ChatExecutor.toolLoop() → detector.recordAction() 记录工具调用
 *   - ChatExecutor.applySentimentToTts() → detector.getEmotion() 获取情绪并混合
 *   - BrowserWindow focus/blur → detector.recordWindowSwitch() 记录窗口切换
 */

import { screen, BrowserWindow } from 'electron'
import { log } from '@akemi-mio/core/logger/Logger'
import type { BehaviorEmotion, BehaviorMetrics, BehaviorEmotionResult, EmotionTtsParams } from './types'
import { BEHAVIOR_EMOTION_TTS_MAP } from './types'

// ══════════════════════════════════════════
//  配置常量
// ══════════════════════════════════════════

/** 滑动窗口大小（秒），默认 60s */
const DEFAULT_WINDOW_SECONDS = 60

/** APM 阈值：超过此值视为高活跃 */
const APM_HIGH_THRESHOLD = 30

/** APM 阈值：低于此值视为低活跃 */
const APM_LOW_THRESHOLD = 5

/** 窗口切换频率阈值（次/分钟）：超过此值视为频繁切换 */
const WINDOW_SWITCH_HIGH_THRESHOLD = 6

/** 鼠标抖动度阈值：超过此值视为高抖动 */
const JITTER_HIGH_THRESHOLD = 0.6

/** 鼠标抖动度阈值：低于此值视为平滑 */
const JITTER_LOW_THRESHOLD = 0.2

/** 鼠标位置采样间隔（毫秒），用于计算抖动度 */
const MOUSE_SAMPLE_INTERVAL_MS = 2000

/** 鼠标抖动滑动窗口（采样点数），保留最近 N 次采样 */
const JITTER_SAMPLE_COUNT = 15

/** 置信度所需的最小交互次数 */
const MIN_INTERACTIONS_FOR_CONFIDENCE = 3

/** 置信度所需的最小窗口切换次数 */
const MIN_SWITCHES_FOR_CONFIDENCE = 1

/** 撤回频率阈值（次/分钟）：超过此值视为频繁撤回 */
const RETRACTION_HIGH_THRESHOLD = 3

/** 疲惫检测：低 APM 阈值，持续低于此值一段时间 → 疲惫 */
const TIRED_APM_THRESHOLD = 3

/** 疲惫检测：长时间无操作阈值（秒），超过此值 → 推测疲惫/休息 */
const TIRED_IDLE_THRESHOLD_SEC = 180 // 3 分钟

/** 愉悦检测：APM 适中范围下限 */
const JOYFUL_APM_MIN = 8

/** 愉悦检测：APM 适中范围上限 */
const JOYFUL_APM_MAX = 25

/** 愉悦检测：窗口切换适中，说明不是焦躁切换 */
const JOYFUL_SWITCH_MAX = 4

/** 平均交互间隔（秒）：超过此值视为操作缓慢（疲惫特征） */
const SLOW_INTERVAL_THRESHOLD_SEC = 60

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

interface TimestampedAction {
  timestamp: number
}

interface TimestampedSwitch {
  timestamp: number
}

interface TimestampedRetraction {
  timestamp: number
}

interface MouseSample {
  x: number
  y: number
  timestamp: number
}

// ══════════════════════════════════════════
//  检测器
// ══════════════════════════════════════════

export class BehaviorEmotionDetector {
  /** 动作时间戳列表（用户消息 + 工具调用） */
  private actions: TimestampedAction[] = []

  /** 窗口切换时间戳列表 */
  private windowSwitches: TimestampedSwitch[] = []

  /** 撤回/重做操作时间戳列表 */
  private retractions: TimestampedRetraction[] = []

  /** 鼠标采样历史（用于计算抖动度） */
  private mouseSamples: MouseSample[] = []

  /** 滑动窗口大小（秒） */
  private windowSeconds: number

  /** 鼠标采样定时器 */
  private mouseTimer: ReturnType<typeof setInterval> | null = null

  /** 窗口切换事件监听器是否已绑定 */
  private windowListenerBound = false

  /** 关联的 BrowserWindow（用于监听 focus/blur） */
  private boundWindow: BrowserWindow | null = null

  /** 是否已启动 */
  private running = false

  /** 是否启用（用户可通过 IPC 关闭） */
  private enabled = true

  /** 上次检测结果缓存（避免频繁重算） */
  private lastResult: BehaviorEmotionResult | null = null
  private lastResultTime = 0
  /** 缓存有效期（毫秒），在此期间直接返回缓存 */
  private readonly CACHE_TTL_MS = 3000

  constructor(windowSeconds = DEFAULT_WINDOW_SECONDS) {
    this.windowSeconds = windowSeconds
  }

  // ── 生命周期 ──

  /**
   * 启动行为监控。
   * 绑定 BrowserWindow focus/blur 事件，启动鼠标采样定时器。
   */
  start(mainWindow?: BrowserWindow): void {
    if (this.running) return
    this.running = true

    // 绑定窗口切换监听
    if (mainWindow && !this.windowListenerBound) {
      this.bindWindowEvents(mainWindow)
    }

    // 启动鼠标采样
    this.startMouseSampling()

    log('INFO', 'behavior_emotion_detector_started', {
      window_seconds: this.windowSeconds,
      mouse_sample_interval_ms: MOUSE_SAMPLE_INTERVAL_MS,
    })
  }

  /**
   * 停止行为监控。
   * 解绑事件监听器，停止定时器。
   */
  stop(): void {
    if (!this.running) return
    this.running = false

    this.unbindWindowEvents()
    this.stopMouseSampling()

    log('INFO', 'behavior_emotion_detector_stopped')
  }

  /** 启用/禁用行为情绪检测（用户可关闭） */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      this.lastResult = null
      this.lastResultTime = 0
    }
    log('INFO', 'behavior_emotion_enabled', { enabled })
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /**
   * 更新关联的 BrowserWindow（窗口重建时调用）。
   */
  updateWindow(mainWindow: BrowserWindow | null): void {
    if (this.boundWindow === mainWindow) return
    this.unbindWindowEvents()
    this.boundWindow = null
    if (mainWindow && this.running) {
      this.bindWindowEvents(mainWindow)
    }
  }

  // ── 数据采集 ──

  /** 记录一次用户交互（消息发送、工具调用等） */
  recordInteraction(): void {
    this.actions.push({ timestamp: Date.now() })
    this.pruneOldActions()
    // 交互发生后立即使缓存失效
    this.lastResult = null
  }

  /** 记录一次动作（工具调用等，与 recordInteraction 相同语义） */
  recordAction(): void {
    this.recordInteraction()
  }

  /**
   * 记录一次撤回/重做操作（用户撤销消息、回退工具调用等）。
   * 高频率撤回是焦躁/不确定的情绪信号。
   */
  recordRetraction(): void {
    this.retractions.push({ timestamp: Date.now() })
    this.pruneOldRetractions()
    this.lastResult = null
  }

  /** 记录一次窗口切换 */
  recordWindowSwitch(): void {
    this.windowSwitches.push({ timestamp: Date.now() })
    this.pruneOldSwitches()
    this.lastResult = null
  }

  // ── 情绪检测 ──

  /**
   * 获取当前行为情绪。
   *
   * 3 秒内有缓存直接返回，避免高频重算。
   * 数据不足时返回 neutral。
   */
  getEmotion(): BehaviorEmotionResult {
    if (!this.enabled) {
      return this.neutralResult('disabled')
    }

    const now = Date.now()
    if (this.lastResult && now - this.lastResultTime < this.CACHE_TTL_MS) {
      return this.lastResult
    }

    const metrics = this.computeMetrics()
    const result = this.classifyEmotion(metrics)
    this.lastResult = result
    this.lastResultTime = now
    return result
  }

  /**
   * 获取当前行为情绪对应的 TTS 参数（便捷方法）。
   */
  getEmotionTtsParams(): EmotionTtsParams {
    const result = this.getEmotion()
    return result.ttsParams
  }

  // ── 私有：指标计算 ──

  /**
   * 从滑动窗口计算当前行为指标。
   */
  private computeMetrics(): BehaviorMetrics {
    const now = Date.now()
    const cutoff = now - this.windowSeconds * 1000

    // 计算窗口内的动作数
    const recentActions = this.actions.filter((a) => a.timestamp >= cutoff)
    const totalActions = recentActions.length
    const apm = totalActions / (this.windowSeconds / 60)

    // 计算窗口内的窗口切换数
    const recentSwitches = this.windowSwitches.filter((s) => s.timestamp >= cutoff)
    const totalWindowSwitches = recentSwitches.length
    const windowSwitchesPerMin = totalWindowSwitches / (this.windowSeconds / 60)

    // 计算撤回频率
    const recentRetractions = this.retractions.filter((r) => r.timestamp >= cutoff)
    const totalRetractions = recentRetractions.length
    const retractionsPerMin = totalRetractions / (this.windowSeconds / 60)

    // 计算平均交互间隔（秒）
    const meanInteractionIntervalSec = this.computeMeanInterval(recentActions)

    // 计算鼠标抖动度
    const mouseJitter = this.computeMouseJitter()

    return {
      apm: Math.round(apm * 10) / 10,
      windowSwitchesPerMin: Math.round(windowSwitchesPerMin * 10) / 10,
      mouseJitter: Math.round(mouseJitter * 100) / 100,
      windowSeconds: this.windowSeconds,
      totalActions,
      totalWindowSwitches,
      totalRetractions,
      retractionsPerMin: Math.round(retractionsPerMin * 10) / 10,
      meanInteractionIntervalSec: Math.round(meanInteractionIntervalSec * 10) / 10,
      lastUpdated: now,
    }
  }

  /**
   * 计算最近交互的平均间隔（秒）。
   * 如果交互数少于 2，返回 0。
   */
  private computeMeanInterval(recentActions: TimestampedAction[]): number {
    if (recentActions.length < 2) return 0
    const sorted = [...recentActions].sort((a, b) => a.timestamp - b.timestamp)
    let totalGap = 0
    for (let i = 1; i < sorted.length; i++) {
      totalGap += (sorted[i].timestamp - sorted[i - 1].timestamp) / 1000
    }
    return totalGap / (sorted.length - 1)
  }

  /**
   * 计算鼠标抖动度（0–1）。
   *
   * 算法：计算相邻采样点之间的方向变化角度的方差。
   * 方向变化大 → 抖动度高（鼠标在频繁改变方向）。
   * 方向变化小 → 抖动度低（鼠标沿平滑路径移动）。
   */
  private computeMouseJitter(): number {
    const samples = this.mouseSamples
    if (samples.length < 3) return 0

    // 计算相邻向量之间的夹角变化
    const angleChanges: number[] = []
    for (let i = 2; i < samples.length; i++) {
      const p0 = samples[i - 2]
      const p1 = samples[i - 1]
      const p2 = samples[i]

      // 向量 v1 = p1 - p0, v2 = p2 - p1
      const v1x = p1.x - p0.x
      const v1y = p1.y - p0.y
      const v2x = p2.x - p1.x
      const v2y = p2.y - p1.y

      const len1 = Math.sqrt(v1x * v1x + v1y * v1y)
      const len2 = Math.sqrt(v2x * v2x + v2y * v2y)

      // 忽略静止点
      if (len1 < 2 || len2 < 2) continue

      // cos(θ) = (v1·v2) / (|v1| × |v2|)
      const dot = v1x * v2x + v1y * v2y
      const cosAngle = Math.max(-1, Math.min(1, dot / (len1 * len2)))
      const angle = Math.acos(cosAngle) // 0 (同方向) ~ π (反向)

      angleChanges.push(angle)
    }

    if (angleChanges.length === 0) return 0

    // 计算方向变化的均值和方差
    const mean = angleChanges.reduce((s, a) => s + a, 0) / angleChanges.length
    const variance = angleChanges.reduce((s, a) => s + (a - mean) ** 2, 0) / angleChanges.length

    // 归一化：最大理论方差 ≈ (π/2)^2 ≈ 2.47
    // 将方差映射到 0–1
    return Math.min(1, variance / 2.0)
  }

  // ── 私有：情绪分类 ──

  /**
   * 基于指标阈值规则分类行为情绪。
   *
   * 规则优先级（从高到低）：
   *   1. 高 APM + 高窗口切换 + 高抖动 + 高撤回 → anxious（焦躁）
   *   2. 适中 APM + 适中窗口切换 + 低撤回 → joyful（愉悦）
   *   3. 低 APM + 长时间隔 + 深夜时段 → tired（疲惫）
   *   4. 高 APM + 低窗口切换 + 低抖动 → focused（专注）
   *   5. 低 APM + 低窗口切换 + 低抖动 → calm（平静）
   *   6. 其他 → neutral（中性）
   */
  private classifyEmotion(metrics: BehaviorMetrics): BehaviorEmotionResult {
    const {
      apm,
      windowSwitchesPerMin,
      mouseJitter,
      retractionsPerMin,
      totalActions,
      totalWindowSwitches,
      totalRetractions,
      meanInteractionIntervalSec,
    } = metrics

    // 数据充足性检查
    const hasEnoughData = totalActions >= MIN_INTERACTIONS_FOR_CONFIDENCE

    let emotion: BehaviorEmotion
    let confidence: number

    if (!hasEnoughData) {
      emotion = 'neutral'
      confidence = 0.1
    } else if (
      (apm >= APM_HIGH_THRESHOLD && windowSwitchesPerMin >= WINDOW_SWITCH_HIGH_THRESHOLD && mouseJitter >= JITTER_HIGH_THRESHOLD) ||
      (retractionsPerMin >= RETRACTION_HIGH_THRESHOLD && apm >= APM_HIGH_THRESHOLD)
    ) {
      // 高活跃 + 频繁切换 + 鼠标抖动 + 高撤回 → 焦躁
      emotion = 'anxious'
      confidence = 0.75 + (apm / 100) * 0.25
    } else if (
      apm >= JOYFUL_APM_MIN &&
      apm <= JOYFUL_APM_MAX &&
      windowSwitchesPerMin <= JOYFUL_SWITCH_MAX &&
      retractionsPerMin < RETRACTION_HIGH_THRESHOLD &&
      mouseJitter < JITTER_HIGH_THRESHOLD
    ) {
      // 适中 APM + 低切换 + 低撤回 + 低抖动 → 愉悦
      emotion = 'joyful'
      confidence = 0.6 + (apm / 50) * 0.3
    } else if (apm <= TIRED_APM_THRESHOLD && meanInteractionIntervalSec >= SLOW_INTERVAL_THRESHOLD_SEC && this.isLateNight()) {
      // 极低 APM + 长时间隔 + 深夜 → 疲惫
      emotion = 'tired'
      confidence = 0.7 + (1 - apm / TIRED_APM_THRESHOLD) * 0.3
    } else if (apm >= APM_HIGH_THRESHOLD && windowSwitchesPerMin < WINDOW_SWITCH_HIGH_THRESHOLD && mouseJitter < JITTER_HIGH_THRESHOLD) {
      // 高活跃 + 少切换 + 鼠标平稳 → 专注
      emotion = 'focused'
      confidence = 0.7 + (apm / 100) * 0.3
    } else if (apm <= APM_LOW_THRESHOLD && windowSwitchesPerMin < WINDOW_SWITCH_HIGH_THRESHOLD && mouseJitter <= JITTER_LOW_THRESHOLD) {
      // 低活跃 + 少切换 + 鼠标平滑 → 平静
      emotion = 'calm'
      confidence = 0.7 + (1 - apm / APM_LOW_THRESHOLD) * 0.3
    } else {
      // 混合信号 → 计算各情绪得分，取最高
      const scores = this.computeEmotionScores(metrics)
      const entries = Object.entries(scores) as Array<[BehaviorEmotion, number]>
      entries.sort((a, b) => b[1] - a[1])
      emotion = entries[0][0]
      confidence = entries[0][1]
    }

    // 限制置信度范围
    confidence = Math.min(1, Math.max(0.1, confidence))

    const scores = this.computeEmotionScores(metrics)
    const ttsParams = { ...BEHAVIOR_EMOTION_TTS_MAP[emotion] }

    if (emotion !== 'neutral' && confidence > 0.3) {
      log('INFO', 'behavior_emotion_detected', {
        emotion,
        confidence: confidence.toFixed(2),
        apm: metrics.apm,
        windowSwitchesPerMin: metrics.windowSwitchesPerMin,
        mouseJitter: metrics.mouseJitter,
        totalActions: metrics.totalActions,
      })
    }

    return {
      emotion,
      scores,
      metrics,
      confidence: Math.round(confidence * 100) / 100,
      ttsParams,
    }
  }

  /**
   * 计算各情绪标签的得分（0–1），用于混合信号时的软分类。
   */
  private computeEmotionScores(metrics: BehaviorMetrics): Record<BehaviorEmotion, number> {
    const { apm, windowSwitchesPerMin, mouseJitter, retractionsPerMin, meanInteractionIntervalSec } = metrics

    // 标准化各指标到 0–1
    const apmNorm = Math.min(1, apm / 60) // 60 APM = 1.0
    const switchNorm = Math.min(1, windowSwitchesPerMin / 12) // 12 次/分钟 = 1.0
    const jitterNorm = Math.min(1, mouseJitter) // 已归一化
    const retractNorm = Math.min(1, retractionsPerMin / 6) // 6 次/分钟撤回 = 1.0
    const intervalNorm = Math.min(1, meanInteractionIntervalSec / TIRED_IDLE_THRESHOLD_SEC) // 长间隔归一化
    const isLateNight = this.isLateNight() ? 1 : 0

    // anxious 得分：高 APM + 高切换 + 高抖动 + 高撤回
    const anxiousScore = apmNorm * 0.3 + switchNorm * 0.25 + jitterNorm * 0.2 + retractNorm * 0.25

    // joyful 得分：适中 APM + 低切换 + 低撤回 + 低抖动
    const joyfulApmGoodness = apmNorm > 0.15 && apmNorm < 0.45 ? 1 - Math.abs(apmNorm - 0.3) * 2 : 0
    const joyfulScore = joyfulApmGoodness * 0.4 + (1 - switchNorm) * 0.2 + (1 - retractNorm) * 0.2 + (1 - jitterNorm) * 0.2

    // tired 得分：极低 APM + 长间隔 + 深夜
    const tiredScore = (1 - apmNorm) * 0.35 + intervalNorm * 0.25 + isLateNight * 0.4

    // focused 得分：高 APM + 低切换 + 低抖动
    const focusedScore = apmNorm * 0.5 + (1 - switchNorm) * 0.25 + (1 - jitterNorm) * 0.25

    // calm 得分：低 APM + 低切换 + 低抖动
    const calmScore = (1 - apmNorm) * 0.4 + (1 - switchNorm) * 0.3 + (1 - jitterNorm) * 0.3

    // neutral 得分：中等水平，作为兜底
    const neutralScore = 1 - Math.max(anxiousScore, joyfulScore, tiredScore, focusedScore, calmScore)

    // 归一化：确保总和为 1
    const total = anxiousScore + joyfulScore + tiredScore + focusedScore + calmScore + neutralScore
    if (total === 0) {
      return { anxious: 0, calm: 0, focused: 0, neutral: 1, tired: 0, joyful: 0 }
    }

    return {
      anxious: Math.round((anxiousScore / total) * 100) / 100,
      joyful: Math.round((joyfulScore / total) * 100) / 100,
      tired: Math.round((tiredScore / total) * 100) / 100,
      calm: Math.round((calmScore / total) * 100) / 100,
      focused: Math.round((focusedScore / total) * 100) / 100,
      neutral: Math.round((neutralScore / total) * 100) / 100,
    }
  }

  /**
   * 判断当前是否为深夜时段（23:00–06:00）。
   */
  private isLateNight(): boolean {
    const hour = new Date().getHours()
    return hour >= 23 || hour < 6
  }

  // ── 私有：鼠标采样 ──

  /**
   * 启动鼠标位置采样定时器。
   * 每隔 MOUSE_SAMPLE_INTERVAL_MS 记录一次屏幕光标位置。
   */
  private startMouseSampling(): void {
    if (this.mouseTimer) return
    this.mouseTimer = setInterval(() => {
      try {
        const point = screen.getCursorScreenPoint()
        this.mouseSamples.push({
          x: point.x,
          y: point.y,
          timestamp: Date.now(),
        })
        // 保留最近 N 次采样
        if (this.mouseSamples.length > JITTER_SAMPLE_COUNT) {
          this.mouseSamples = this.mouseSamples.slice(-JITTER_SAMPLE_COUNT)
        }
      } catch {
        // screen.getCursorScreenPoint() 在某些平台上可能抛异常
        // 静默忽略，不影响其他功能
      }
    }, MOUSE_SAMPLE_INTERVAL_MS)
  }

  /** 停止鼠标采样定时器 */
  private stopMouseSampling(): void {
    if (this.mouseTimer) {
      clearInterval(this.mouseTimer)
      this.mouseTimer = null
    }
    this.mouseSamples = []
  }

  // ── 私有：窗口切换监听 ──

  /** 窗口 focus 事件处理器引用（用于精确解绑） */
  private onFocusHandler: (() => void) | null = null
  /** 窗口 blur 事件处理器引用 */
  private onBlurHandler: (() => void) | null = null

  /**
   * 绑定 BrowserWindow 的 focus/blur 事件以检测窗口切换。
   */
  private bindWindowEvents(win: BrowserWindow): void {
    if (this.windowListenerBound) return

    this.onFocusHandler = () => {
      this.recordWindowSwitch()
    }

    this.onBlurHandler = () => {
      // blur 不直接计为切换（用户可能只是临时失焦），
      // 而是由下次 focus 时计数（表示"切回来"的动作）。
    }

    win.on('focus', this.onFocusHandler)
    win.on('blur', this.onBlurHandler)
    // 窗口销毁时自动解绑
    win.once('closed', () => {
      this.unbindWindowEvents()
    })

    this.boundWindow = win
    this.windowListenerBound = true
  }

  /** 解绑窗口事件监听器 */
  private unbindWindowEvents(): void {
    if (this.boundWindow && this.windowListenerBound) {
      if (this.onFocusHandler) {
        this.boundWindow.removeListener('focus', this.onFocusHandler)
        this.onFocusHandler = null
      }
      if (this.onBlurHandler) {
        this.boundWindow.removeListener('blur', this.onBlurHandler)
        this.onBlurHandler = null
      }
      this.windowListenerBound = false
      this.boundWindow = null
    }
  }

  // ── 私有：数据清理 ──

  /** 清理窗口外的旧动作记录 */
  private pruneOldActions(): void {
    const cutoff = Date.now() - this.windowSeconds * 2 * 1000 // 保留 2x 窗口
    this.actions = this.actions.filter((a) => a.timestamp >= cutoff)
  }

  /** 清理窗口外的旧切换记录 */
  private pruneOldSwitches(): void {
    const cutoff = Date.now() - this.windowSeconds * 2 * 1000
    this.windowSwitches = this.windowSwitches.filter((s) => s.timestamp >= cutoff)
  }

  // ── 私有：工具方法 ──

  /** 生成中性结果（用于禁用/数据不足） */
  private neutralResult(reason: string): BehaviorEmotionResult {
    return {
      emotion: 'neutral',
      scores: { anxious: 0, calm: 0, focused: 0, neutral: 1, tired: 0, joyful: 0 },
      metrics: {
        apm: 0,
        windowSwitchesPerMin: 0,
        mouseJitter: 0,
        windowSeconds: this.windowSeconds,
        totalActions: 0,
        totalWindowSwitches: 0,
        totalRetractions: 0,
        retractionsPerMin: 0,
        meanInteractionIntervalSec: 0,
        lastUpdated: Date.now(),
      },
      confidence: 0,
      ttsParams: { ...BEHAVIOR_EMOTION_TTS_MAP['neutral'] },
    }
  }

  // ── 状态查询 ──

  /** 获取当前原始指标（供调试/UI 展示） */
  getMetrics(): BehaviorMetrics {
    return this.computeMetrics()
  }

  /** 获取所有支持的映射（供调试/UI 展示） */
  getAllEmotionMappings(): Array<{ emotion: BehaviorEmotion; params: EmotionTtsParams }> {
    return (Object.keys(BEHAVIOR_EMOTION_TTS_MAP) as BehaviorEmotion[]).map((emotion) => ({
      emotion,
      params: BEHAVIOR_EMOTION_TTS_MAP[emotion],
    }))
  }

  /** 重置所有运行时数据 */
  reset(): void {
    this.actions = []
    this.windowSwitches = []
    this.retractions = []
    this.mouseSamples = []
    this.lastResult = null
    this.lastResultTime = 0
  }

  /** 清理窗口外的旧撤回记录 */
  private pruneOldRetractions(): void {
    const cutoff = Date.now() - this.windowSeconds * 2 * 1000
    this.retractions = this.retractions.filter((r) => r.timestamp >= cutoff)
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例，供 ChatExecutor 使用 */
export const behaviorEmotionDetector = new BehaviorEmotionDetector()
