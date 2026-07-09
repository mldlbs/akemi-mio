/**
 * UserContextClassifier — 用户情境分类器
 *
 * 根据活跃窗口标题/进程名、时间段、空闲时间和交互模式，
 * 将用户当前状态分类为 work（工作） / leisure（休闲） / rest（休息）。
 *
 * 与现有模块的关系：
 *   - BehaviorEmotionDetector: 情绪状态（焦躁/平静/专注），本模块复用其 APM 数据
 *   - ContextualTtsAdvisor: 交流节奏 + 时段感知，本模块复用其交互记录
 *   - 本模块专注"用户在做什么活动"（窗口/进程），而非"用户感受如何"
 *
 * 集成点：
 *   1. ChatExecutor 初始化时调用 classifier.start() 启动轮询
 *   2. ChatExecutor.applySentimentToTts() 调用 getClassification() 获取情境
 *   3. applySentimentToTts() 中的情境混合层使用 getSmoothedParams() 获取过渡参数
 *   4. 系统托盘通过 IPC 切换覆盖模式
 *   5. ChatExecutor 关闭时调用 classifier.stop() 停止轮询
 *
 * 情境分类策略：
 *   - 活跃窗口标题/进程名匹配 WORK_PATTERNS → 工作
 *   - 活跃窗口标题/进程名匹配 LEISURE_PATTERNS → 休闲
 *   - 夜间 (23-6) + 低活跃 → 休息
 *   - 长时间无交互 (>2min) → 休息
 *   - 其他情况结合时间段 + 交互节奏综合判断
 */

import { execFile } from 'child_process'
import { log } from '../logger/Logger'
import {
  type UserContext,
  type ContextVoiceConfig,
  type ContextClassificationResult,
  type ContextIndicators,
  type ContextOverrideMode,
  type SmoothTransitionConfig,
  type DayPeriod,
  CONTEXT_VOICE_MAP,
  CONTEXT_OVERRIDE_MAP,
  DEFAULT_SMOOTH_TRANSITION,
  DEFAULT_USER_CONTEXT_CLASSIFIER_CONFIG,
  WORK_PROCESS_PATTERNS,
  LEISURE_PROCESS_PATTERNS,
} from './types'
import { contextualTtsAdvisor } from './ContextualTtsAdvisor'
import { behaviorEmotionDetector } from './BehaviorEmotionDetector'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

interface ActiveWindowInfo {
  title: string
  processName: string
}

/** 要监控的工作进程关键词（进程名快速匹配） */
const QUICK_WORK_PROCESS_NAMES = [
  'code', 'code.exe',
  'idea', 'idea64.exe',
  'WebStorm', 'webstorm64.exe',
  'pycharm64.exe',
  'clion64.exe',
  'goland64.exe',
  'WindowsTerminal',
  'cmd.exe', 'powershell.exe', 'pwsh.exe',
  'OUTLOOK.EXE',
  'WINWORD.EXE', 'EXCEL.EXE',
  'chrome.exe', 'firefox.exe', 'msedge.exe', // browser is contextual
  'slack.exe',
  'Teams.exe',
  'figma.exe',
  'postman.exe',
]

/** 要监控的休闲进程名（进程名快速匹配） */
const QUICK_LEISURE_PROCESS_NAMES = [
  'Spotify.exe',
  'wmplayer.exe',
  'vlc.exe',
  'mpv.exe',
  'steam.exe',
  'Battle.net.exe',
  'WeChat.exe',
  'QQ.exe',
  'Telegram.exe',
  'Discord.exe',
  'chrome.exe', 'firefox.exe', 'msedge.exe', // browser is contextual
]

// ══════════════════════════════════════════
//  UserContextClassifier
// ══════════════════════════════════════════

export class UserContextClassifier {
  /** 轮询定时器 */
  private pollTimer: ReturnType<typeof setInterval> | null = null

  /** 是否已启动 */
  private running = false

  /** 是否启用（用户可通过 IPC 关闭） */
  private enabled = true

  /** 当前覆盖模式（默认 auto） */
  private overrideMode: ContextOverrideMode = 'auto'

  /** 上次分类结果缓存 */
  private lastResult: ContextClassificationResult | null = null
  private lastResultTime = 0
  private readonly cacheTtlMs: number

  /** 去抖机制：记录当前稳定分类及持续时长 */
  private stableContext: UserContext | null = null
  private stableSince = 0
  private readonly debounceMs: number

  /** 轮询间隔（ms） */
  private readonly pollIntervalMs: number

  /** 空闲超时（秒） */
  private readonly idleThresholdSec: number

  /** 最小置信度阈值 */
  private readonly minConfidence: number

  /** 最近一次活跃窗口信息缓存 */
  private lastActiveWindow: ActiveWindowInfo | null = null

  /** 最近一次交互时间戳 */
  private lastInteractionTime = Date.now()

  /** 平滑过渡配置 */
  private transitionConfig: SmoothTransitionConfig = { ...DEFAULT_SMOOTH_TRANSITION }

  /** 上次使用的语音参数（用于平滑过渡） */
  private previousVoiceConfig: ContextVoiceConfig | null = null

  constructor() {
    const cfg = DEFAULT_USER_CONTEXT_CLASSIFIER_CONFIG
    this.pollIntervalMs = cfg.pollIntervalMs
    this.idleThresholdSec = cfg.idleThresholdSec
    this.minConfidence = cfg.minConfidence
    this.debounceMs = cfg.debounceSec * 1000
    this.cacheTtlMs = cfg.cacheTtlMs
  }

  // ── 生命周期 ──

  /** 启动情境轮询 */
  start(): void {
    if (this.running) return
    this.running = true

    // 立即执行一次分类
    this.poll().catch(() => {})

    // 设置定时轮询
    this.pollTimer = setInterval(() => {
      this.poll().catch(() => {})
    }, this.pollIntervalMs)

    log('INFO', 'user_context_classifier_started', {
      pollIntervalMs: this.pollIntervalMs,
      idleThresholdSec: this.idleThresholdSec,
    })
  }

  /** 停止情境轮询 */
  stop(): void {
    if (!this.running) return
    this.running = false

    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }

    this.lastResult = null
    this.lastResultTime = 0
    this.stableContext = null
    this.stableSince = 0
    this.previousVoiceConfig = null

    log('INFO', 'user_context_classifier_stopped')
  }

  /** 启用/禁用情境分类 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      this.lastResult = null
      this.lastResultTime = 0
    }
    log('INFO', 'user_context_classifier_enabled', { enabled })
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /** 记录用户交互时间（由 ChatExecutor 调用） */
  recordInteraction(): void {
    this.lastInteractionTime = Date.now()
  }

  // ── 覆盖模式 ──

  /** 设置情境覆盖模式 */
  setOverrideMode(mode: ContextOverrideMode): void {
    if (this.overrideMode === mode) return
    this.overrideMode = mode
    // 切换覆盖模式时重置缓存，确保下次查询立即生效
    this.lastResult = null
    this.lastResultTime = 0
    this.stableContext = null
    this.stableSince = 0
    log('INFO', 'user_context_override', { mode })
  }

  getOverrideMode(): ContextOverrideMode {
    return this.overrideMode
  }

  /** 获取覆盖模式对应的用户情境（auto 时返回 null） */
  getOverrideContext(): UserContext | null {
    return CONTEXT_OVERRIDE_MAP[this.overrideMode]
  }

  // ── 平滑过渡 ──

  /** 配置平滑过渡 */
  setTransitionConfig(config: Partial<SmoothTransitionConfig>): void {
    if (config.durationSec !== undefined) this.transitionConfig.durationSec = config.durationSec
    if (config.enabled !== undefined) this.transitionConfig.enabled = config.enabled
  }

  getTransitionConfig(): SmoothTransitionConfig {
    return { ...this.transitionConfig }
  }

  // ── 情境分类 ──

  /**
   * 获取当前情境分类结果。
   *
   * 优先级：
   *   1. 手动覆盖模式 → 直接返回覆盖的情境
   *   2. 缓存有效 → 返回缓存
   *   3. 执行分类 → 应用去抖 → 缓存并返回
   */
  getClassification(): ContextClassificationResult {
    // 1. 手动覆盖
    const overrideCtx = this.getOverrideContext()
    if (overrideCtx) {
      const config = CONTEXT_VOICE_MAP[overrideCtx]
      return {
        context: overrideCtx,
        confidence: 1.0,
        voiceConfig: { ...config },
        description: `手动覆盖·${config.label}`,
        indicators: this.buildIndicators(),
      }
    }

    if (!this.enabled) {
      return this.defaultResult('分类已禁用')
    }

    // 2. 缓存
    const now = Date.now()
    if (this.lastResult && (now - this.lastResultTime) < this.cacheTtlMs) {
      return this.lastResult
    }

    // 3. 执行分类
    const rawResult = this.classify()

    // 4. 去抖：避免频繁切换
    const debounced = this.applyDebounce(rawResult)

    this.lastResult = debounced
    this.lastResultTime = now
    return debounced
  }

  /**
   * 获取带平滑过渡的语音参数。
   *
   * 当情境切换时，rate/pitch 会逐步从旧值过渡到新值，
   * 避免参数突变造成的听觉不适。
   */
  getSmoothedParams(): ContextVoiceConfig {
    const result = this.getClassification()
    const targetConfig = result.voiceConfig

    if (!this.transitionConfig.enabled || !this.previousVoiceConfig) {
      this.previousVoiceConfig = { ...targetConfig }
      return { ...targetConfig }
    }

    const prev = this.previousVoiceConfig

    // 如果 voice 变了（情境切换），直接使用新 voice
    // rate/pitch 做平滑过渡
    if (prev.voice !== targetConfig.voice) {
      // voice 变了 = 情境切换，开始过渡
      const blended = this.lerpParams(prev, targetConfig)
      return blended
    }

    // voice 没变 = 同情境下微调，直接使用目标
    this.previousVoiceConfig = { ...targetConfig }
    return { ...targetConfig }
  }

  /** 重置平滑过渡状态 */
  resetTransition(): void {
    this.previousVoiceConfig = null
  }

  /** 强制刷新分类（忽略缓存） */
  refresh(): ContextClassificationResult {
    this.lastResult = null
    this.lastResultTime = 0
    return this.getClassification()
  }

  /** 重置运行时数据 */
  reset(): void {
    this.lastResult = null
    this.lastResultTime = 0
    this.stableContext = null
    this.stableSince = 0
    this.previousVoiceConfig = null
    this.lastActiveWindow = null
    this.lastInteractionTime = Date.now()
  }

  /** 获取上次的活跃窗口信息（供调试/UI） */
  getLastActiveWindow(): ActiveWindowInfo | null {
    return this.lastActiveWindow
  }

  // ── 私有：轮询 ──

  /**
   * 执行一次轮询：检测活跃窗口 → 更新分类。
   * 静默处理错误，不影响主流程。
   */
  private async poll(): Promise<void> {
    try {
      const windowInfo = await this.detectActiveWindow()
      if (windowInfo) {
        this.lastActiveWindow = windowInfo
      }
    } catch {
      // 静默忽略——窗口检测是辅助性的，不应影响主流程
    }
  }

  // ── 私有：活跃窗口检测（Windows） ──

  /**
   * 使用 PowerShell 检测当前活跃的窗口标题和进程名。
   *
   * 调用 Windows API (user32.dll) 获取前台窗口信息，
   * 比解析 tasklist 更高效。
   */
  private detectActiveWindow(): Promise<ActiveWindowInfo | null> {
    return new Promise((resolve) => {
      try {
        const ps = execFile(
          'powershell',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Diagnostics;
public class Win32 {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@;
$h = [Win32]::GetForegroundWindow();
$sb = New-Object System.Text.StringBuilder 256;
[Win32]::GetWindowText($h, $sb, 256);
$title = $sb.ToString();
$pid = 0;
[Win32]::GetWindowThreadProcessId($h, [ref]$pid);
$proc = (Get-Process -Id $pid -ErrorAction SilentlyContinue);
if ($proc) { Write-Output "$title|$($proc.ProcessName)" } else { Write-Output "$title|unknown" }`,
          ],
          {
            timeout: 3000,
            windowsHide: true,
          },
          (err, stdout) => {
            if (err) {
              resolve(null)
              return
            }
            const line = stdout?.toString().trim()
            if (!line) {
              resolve(null)
              return
            }
            const sep = line.lastIndexOf('|')
            if (sep < 0) {
              resolve(null)
              return
            }
            const title = line.substring(0, sep).trim()
            const processName = line.substring(sep + 1).trim()
            resolve({ title, processName })
          },
        )
      } catch {
        resolve(null)
      }
    })
  }

  // ── 私有：分类逻辑 ──

  /**
   * 核心分类逻辑。
   *
   * 规则优先级：
   *   1. 空闲超时 → rest（无论窗口是什么）
   *   2. 深夜 (23-6) → rest（降权）
   *   3. 窗口标题/进程名匹配 WORK_PATTERNS → work
   *   4. 窗口标题/进程名匹配 LEISURE_PATTERNS → leisure
   *   5. 默认依据时间段 + APM 推断
   */
  private classify(): ContextClassificationResult {
    const windowInfo = this.lastActiveWindow
    const idleSec = Math.round((Date.now() - this.lastInteractionTime) / 1000)
    const dayPeriod = contextualTtsAdvisor.getDayPeriod()
    const apm = behaviorEmotionDetector.getMetrics().apm

    const indicators: ContextIndicators = {
      activeWindowTitle: windowInfo?.title ?? null,
      activeProcessName: windowInfo?.processName ?? null,
      idleSeconds: idleSec,
      dayPeriod,
      apm,
    }

    // 规则 1：空闲超时 → rest
    if (idleSec >= this.idleThresholdSec) {
      const confidence = Math.min(0.9, 0.5 + (idleSec - this.idleThresholdSec) / this.idleThresholdSec * 0.4)
      return this.buildResult('rest', confidence, '长时间无交互', indicators)
    }

    // 规则 2：深夜 → rest
    if (dayPeriod === 'late_night') {
      // 深夜但还在交互 → rest 但置信度适中
      return this.buildResult('rest', 0.65, '深夜时段', indicators)
    }

    // 规则 3 & 4：基于窗口标题/进程名匹配
    if (windowInfo) {
      const combined = `${windowInfo.processName} ${windowInfo.title}`.toLowerCase()

      // 计算工作匹配度
      const workScore = this.computePatternScore(combined, WORK_PROCESS_PATTERNS)
      const leisureScore = this.computePatternScore(combined, LEISURE_PROCESS_PATTERNS)

      if (workScore > leisureScore && workScore > 0) {
        const confidence = Math.min(0.85, 0.5 + workScore * 0.15)
        return this.buildResult('work', confidence, `工作应用: ${windowInfo.processName}`, indicators)
      }

      if (leisureScore > workScore && leisureScore > 0) {
        const confidence = Math.min(0.8, 0.4 + leisureScore * 0.2)
        return this.buildResult('leisure', confidence, `休闲应用: ${windowInfo.processName}`, indicators)
      }
    }

    // 规则 5：兜底——基于时段 + APM 推断
    if ((dayPeriod === 'morning' || dayPeriod === 'afternoon') && apm >= 10) {
      // 工作时间 + 活跃 → work（低置信度）
      return this.buildResult('work', 0.4, '工作时间·活跃', indicators)
    }

    if (dayPeriod === 'evening' && apm < 10) {
      // 傍晚 + 低活跃 → leisure
      return this.buildResult('leisure', 0.45, '傍晚·放松', indicators)
    }

    // 默认：leisure（中性偏向 relax）
    return this.buildResult('leisure', 0.35, '默认·休闲', indicators)
  }

  /**
   * 计算文本与一组正则模式的匹配得分。
   * 返回匹配到的模式数量（每匹配一个 +1）。
   */
  private computePatternScore(text: string, patterns: RegExp[]): number {
    let score = 0
    for (const p of patterns) {
      p.lastIndex = 0
      if (p.test(text)) {
        score++
      }
    }
    return score
  }

  // ── 私有：去抖 ──

  /**
   * 应用去抖逻辑：只有持续 debounceMs 毫秒都分类为同一情境才切换。
   *
   * 防止因窗口快速切换（Alt+Tab）导致的情境抖动。
   */
  private applyDebounce(raw: ContextClassificationResult): ContextClassificationResult {
    const now = Date.now()

    if (this.stableContext === raw.context) {
      // 同情境持续中 —— 更新稳定时长
      this.stableSince = this.stableSince || now
      const elapsed = now - this.stableSince

      if (elapsed < this.debounceMs && raw.confidence < 0.7) {
        // 仍在去抖期内且置信度不高 —— 返回之前缓存的分类结果
        // 但保持 raw 的 confidence/description 更新
        const prevResult = this.lastResult
        if (prevResult && prevResult.context !== raw.context) {
          return {
            ...prevResult,
            confidence: raw.confidence * 0.8,
            indicators: raw.indicators,
            description: `去抖中·${raw.description}`,
          }
        }
      }

      // 去抖期已过或高置信度 —— 允许切换
      return raw
    }

    // 情境变了：记录新情境起始时间
    this.stableContext = raw.context
    this.stableSince = now

    // 高置信度直接切换，低置信度保留上一次
    if (raw.confidence >= this.minConfidence + 0.2) {
      return raw
    }

    // 低置信度切换 —— 使用上一次结果（若有）
    const prevResult = this.lastResult
    if (prevResult) {
      return {
        ...prevResult,
        confidence: raw.confidence * 0.5,
        indicators: raw.indicators,
        description: `过渡·${raw.description}`,
      }
    }

    return raw
  }

  // ── 私有：参数平滑 ──

  /**
   * 线性插值两个 ContextVoiceConfig 的 rate/pitch。
   *
   * 每调用一次，参数向目标靠近 transitionDurationSec 的进度。
   */
  private lerpParams(from: ContextVoiceConfig, to: ContextVoiceConfig): ContextVoiceConfig {
    const now = Date.now()

    // 计算过渡进度：假设两次 getSmoothedParams 调用间隔 ≤ pollIntervalMs
    // 这里使用固定步进：每次向目标移动 1/5 的过渡进度（约 5 步完成过渡）
    // 实际步长由 ChatExecutor 的调用频率决定
    const stepRatio = 0.25 // 每次移动 25%，4 步完成

    const fromRate = parseInt(from.rate.replace(/[^0-9-]/g, '')) || 0
    const toRate = parseInt(to.rate.replace(/[^0-9-]/g, '')) || 0
    const blendedRate = Math.round(fromRate + (toRate - fromRate) * stepRatio)

    const fromPitch = parseInt(from.pitch.replace(/[^0-9-]/g, '')) || 0
    const toPitch = parseInt(to.pitch.replace(/[^0-9-]/g, '')) || 0
    const blendedPitch = Math.round(fromPitch + (toPitch - fromPitch) * stepRatio)

    const fromVol = from.volume
    const toVol = to.volume
    const blendedVol = Math.round((fromVol + (toVol - fromVol) * stepRatio) * 100) / 100

    const result: ContextVoiceConfig = {
      voice: to.voice, // voice 立即切换（voice 角色名不应渐变）
      rate: `${blendedRate >= 0 ? '+' : ''}${blendedRate}%`,
      pitch: `${blendedPitch >= 0 ? '+' : ''}${blendedPitch}Hz`,
      volume: blendedVol,
      piperModel: to.piperModel, // piper 模型立即切换
      piperSpeed: from.piperSpeed + (to.piperSpeed - from.piperSpeed) * stepRatio,
      piperPitch: from.piperPitch + (to.piperPitch - from.piperPitch) * stepRatio,
      label: `${to.label}·过渡`,
    }

    // 如果已非常接近目标，直接跳到目标值
    const rateDiff = Math.abs(blendedRate - toRate)
    const pitchDiff = Math.abs(blendedPitch - toPitch)
    if (rateDiff <= 2 && pitchDiff <= 1) {
      this.previousVoiceConfig = { ...to }
      return { ...to }
    }

    // 更新 previous 为当前插值结果（供下次继续过渡）
    this.previousVoiceConfig = { ...result }
    return result
  }

  // ── 私有：工具方法 ──

  /** 构建原始指标 */
  private buildIndicators(): ContextIndicators {
    return {
      activeWindowTitle: this.lastActiveWindow?.title ?? null,
      activeProcessName: this.lastActiveWindow?.processName ?? null,
      idleSeconds: Math.round((Date.now() - this.lastInteractionTime) / 1000),
      dayPeriod: contextualTtsAdvisor.getDayPeriod(),
      apm: behaviorEmotionDetector.getMetrics().apm,
    }
  }

  /** 构建分类结果 */
  private buildResult(
    context: UserContext,
    confidence: number,
    reason: string,
    indicators: ContextIndicators,
  ): ContextClassificationResult {
    const voiceConfig = { ...CONTEXT_VOICE_MAP[context] }
    const contextLabel: Record<UserContext, string> = {
      work: '工作',
      leisure: '休闲',
      rest: '休息',
    }

    return {
      context,
      confidence: Math.min(1, Math.max(0, confidence)),
      voiceConfig,
      description: `${contextLabel[context]}·${reason}`,
      indicators,
    }
  }

  /** 生成禁用/兜底结果 */
  private defaultResult(reason: string): ContextClassificationResult {
    return {
      context: 'leisure',
      confidence: 0,
      voiceConfig: { ...CONTEXT_VOICE_MAP.leisure },
      description: reason,
      indicators: this.buildIndicators(),
    }
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例，供 ChatExecutor 使用 */
export const userContextClassifier = new UserContextClassifier()
