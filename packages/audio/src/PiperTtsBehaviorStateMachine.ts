/**
 * PiperTtsBehaviorStateMachine — PiperTTS 行为感知状态机
 *
 * ── 概述 ──
 *
 * 自动检测并管理 PiperTTS 的四种语音输出状态，基于多维度信号：
 * - UserBehavior 行为标签（行为模式、活动状态、全屏状态）
 * - 环境光传感器（屏幕亮度百分比）
 * - 系统静音状态
 * - 窗口情境（会议检测 via PiperSceneAdaptor）
 *
 * 每种状态映射到一组 Piper 语音参数（模型、语速、音调、音量），
 * 结果可注入 PiperBehaviorSidecar 实现自适应输出。
 *
 * ── 状态定义 ──
 *
 * Normal  — 标准输出，无特殊约束
 * Night   — 夜间模式（22:00–07:00 + 低亮度 < 30%）：极低音量、慢速、轻柔模型
 * Meeting — 会议模式（会议窗口检测到）：低音量、中速
 * Silent  — 静默模式（系统静音 / 屏幕关闭 / 用户离开）：暂停所有 TTS
 *
 * ── 信号源顺序（最后写入者覆盖） ──
 *
 *   1. 环境传感器（屏幕亮度 + 系统静音）
 *   2. PiperSceneAdaptor（会议检测 / 时段检测）
 *   3. UserBehaviorService（行为标签：活动状态、全屏、空闲）
 *   4. UserBehaviorTtsContract（上游已聚合的行为需求）
 *     └── 最终合成 → BehaviorSidecarInput → PiperBehaviorSidecar
 *
 * ── 使用方式 ──
 *
 *   const stateMachine = piperTtsBehaviorStateMachine
 *   await stateMachine.evaluate()               // 重新评估状态
 *   const state = stateMachine.getCurrentState() // 读取状态
 *   const params = stateMachine.getPiperParams() // 获取 Piper 参数
 *   const input = stateMachine.toBehaviorInput() // 转换为 BehaviorSidecarInput
 *   piperBehaviorSidecar.setBehavior(input)      // 注入边车
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { piperSceneAdaptor } from './PiperSceneAdaptor'
import { piperEnvironmentSensor, type EnvironmentSnapshot } from './PiperEnvironmentSensor'
import type { BehaviorSidecarInput } from './PiperBehaviorSidecar'
import type { PiperSceneConfig } from './types'

// ══════════════════════════════════════════
//  状态定义
// ══════════════════════════════════════════

/** 行为感知状态机的四种输出状态 */
export type PiperAutoState = 'Normal' | 'Night' | 'Meeting' | 'Silent'

/** 每种状态对应的 PiperTTS 语音参数 */
export interface PiperAutoStateConfig {
  /** Piper 模型名 */
  piperModel: string
  /** 语速因子 (0.5–2.0) */
  piperSpeed: number
  /** 音调因子 */
  piperPitch: number
  /** 音量 0.0–1.0 */
  volume: number
  /** 人类可读标签 */
  label: string
  /** 对应的 BehaviorSidecarInput outputMode */
  outputMode: BehaviorSidecarInput['outputMode']
  /** 是否暂停 TTS（Silent 状态使用） */
  pauseTts: boolean
}

/** 各状态默认语音参数 */
const STATE_CONFIG_MAP: Record<PiperAutoState, PiperAutoStateConfig> = {
  Normal: {
    piperModel: 'zh_CN-huayan-medium',
    piperSpeed: 1.0,
    piperPitch: 1.0,
    volume: 0.85,
    label: '正常·标准',
    outputMode: 'normal',
    pauseTts: false,
  },
  Night: {
    piperModel: 'zh_CN-ling_ling-medium',
    piperSpeed: 0.78,
    piperPitch: 0.85,
    volume: 0.2,
    label: '夜间·静谧',
    outputMode: 'gentle',
    pauseTts: false,
  },
  Meeting: {
    piperModel: 'zh_CN-huayan-medium',
    piperSpeed: 0.9,
    piperPitch: 0.95,
    volume: 0.5,
    label: '会议·轻柔',
    outputMode: 'minimal',
    pauseTts: false,
  },
  Silent: {
    piperModel: 'zh_CN-huayan-medium',
    piperSpeed: 1.0,
    piperPitch: 1.0,
    volume: 0,
    label: '静默·暂停',
    outputMode: 'silent',
    pauseTts: true,
  },
}

// ══════════════════════════════════════════
//  信号输入定义
// ══════════════════════════════════════════

/** 行为标签（来自 UserBehaviorService） */
export interface BehaviorTagInput {
  /** 活动状态 */
  activityState: string
  /** 是否全屏 */
  fullscreen: boolean
  /** 窗口是否聚焦 */
  focused: boolean
  /** 行为模式 */
  mode: string
  /** 距上次活动毫秒数 */
  idleTimeMs: number
}

/** 状态机决策输入 */
export interface AutoStateInput {
  /** 环境传感器快照 */
  environment: EnvironmentSnapshot
  /** 当前场景自适应结果中的配置 */
  sceneConfig: PiperSceneConfig | null
  /** 当前检测到的场景名 */
  sceneName: string | null
  /** UserBehavior 行为标签（可选） */
  behaviorTags: BehaviorTagInput | null
}

// ══════════════════════════════════════════
//  默认值
// ══════════════════════════════════════════

const DEFAULT_STATE_CONFIG: PiperAutoStateConfig = { ...STATE_CONFIG_MAP.Normal }

/** 去抖间隔（毫秒）：状态切换后至少保持此时间 */
const STATE_DEBOUNCE_MS = 10000

/** 夜间模式亮度阈值（百分比） */
const NIGHT_BRIGHTNESS_THRESHOLD = 30

/** 夜间模式时间段开始（22:00） */
const NIGHT_HOUR_START = 22

/** 夜间模式时间段结束（07:00） */
const NIGHT_HOUR_END = 7

// ══════════════════════════════════════════
//  PiperTtsBehaviorStateMachine
// ══════════════════════════════════════════

export class PiperTtsBehaviorStateMachine {
  /** 当前状态 */
  private currentState: PiperAutoState = 'Normal'

  /** 当前状态的语音参数 */
  private currentConfig: PiperAutoStateConfig = { ...DEFAULT_STATE_CONFIG }

  /** 上次状态切换的时间戳 */
  private lastTransitionTime = 0

  /** 决策原始输入（调试用） */
  private lastInput: AutoStateInput | null = null

  /** 决策原因（调试用） */
  private lastReason = '初始状态'

  /** 自动评估是否启用 */
  private enabled = true

  /** 手动覆盖的状态（null = 自动模式） */
  private manualOverride: PiperAutoState | null = null

  /** 过去 N 次评估的状态记录（防抖用） */
  private readonly recentStates: PiperAutoState[] = []

  // ════════════════════════════════════════
  //  配置
  // ════════════════════════════════════════

  /** 启用/禁用自动状态评估 */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    log('INFO', 'piper_state_machine_enabled', { enabled })
    if (!enabled) {
      // 禁用时回到 Normal
      this.transitionTo('Normal', '状态机已禁用')
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /** 手动覆盖到指定状态（null = 恢复自动） */
  setManualOverride(state: PiperAutoState | null): void {
    if (this.manualOverride === state) return
    this.manualOverride = state

    if (state) {
      const config = STATE_CONFIG_MAP[state]
      this.currentConfig = { ...config }
      this.currentState = state
      this.lastTransitionTime = Date.now()
      log('INFO', 'piper_state_machine_override', {
        state,
        config: config.label,
        piperModel: config.piperModel,
        speed: config.piperSpeed,
        volume: config.volume,
      })
    } else {
      log('INFO', 'piper_state_machine_override_cleared')
    }
  }

  getManualOverride(): PiperAutoState | null {
    return this.manualOverride
  }

  // ════════════════════════════════════════
  //  查询
  // ════════════════════════════════════════

  /** 获取当前状态名 */
  getCurrentState(): PiperAutoState {
    return this.currentState
  }

  /** 获取当前状态的完整语音配置 */
  getCurrentConfig(): Readonly<PiperAutoStateConfig> {
    return Object.freeze({ ...this.currentConfig })
  }

  /** 获取当前状态的 Piper 语音参数 */
  getPiperParams(): { piperModel: string; piperSpeed: number; piperPitch: number; volume: number } {
    return {
      piperModel: this.currentConfig.piperModel,
      piperSpeed: this.currentConfig.piperSpeed,
      piperPitch: this.currentConfig.piperPitch,
      volume: this.currentConfig.volume,
    }
  }

  /** 转换为 BehaviorSidecarInput，供 PiperBehaviorSidecar.setBehavior() 使用 */
  toBehaviorInput(): BehaviorSidecarInput {
    return {
      outputMode: this.currentConfig.outputMode === 'normal' ? null : this.currentConfig.outputMode,
      pauseTts: this.currentConfig.pauseTts,
      rateSuggestion: 0,
      pitchSuggestion: 0,
      volumeSuggestion: this.currentConfig.volume,
    }
  }

  /** 获取决策摘要（调试/日志用） */
  getDecisionSummary(): {
    state: PiperAutoState
    label: string
    config: PiperAutoStateConfig
    reason: string
    isOverride: boolean
    hasBehaviorTags: boolean
  } {
    return {
      state: this.currentState,
      label: this.currentConfig.label,
      config: { ...this.currentConfig },
      reason: this.lastReason,
      isOverride: this.manualOverride !== null,
      hasBehaviorTags: this.lastInput?.behaviorTags !== null,
    }
  }

  // ════════════════════════════════════════
  //  核心评估
  // ════════════════════════════════════════

  /**
   * 重新评估当前状态。
   *
   * 从各信号源采集最新数据，运行决策逻辑，必要时切换状态。
   * 结果会同时更新 currentState 和 currentConfig。
   *
   * @returns 切换后的状态名
   */
  async evaluate(): Promise<PiperAutoState> {
    // 手动覆盖 → 不自动切换
    if (this.manualOverride) {
      return this.currentState
    }

    if (!this.enabled) {
      return this.currentState
    }

    // ── 采集信号 ──
    const envSnapshot = await piperEnvironmentSensor.read()

    let sceneConfig: PiperSceneConfig | null = null
    let sceneName: string | null = null
    try {
      const sceneResult = piperSceneAdaptor.getAdaptedConfig()
      sceneConfig = sceneResult.config
      sceneName = sceneResult.scene
    } catch {
      // PiperSceneAdaptor 尚未初始化
    }

    // 行为标签通过外部注入（由 TtsPiperBridge 在评估前设置）
    const input: AutoStateInput = {
      environment: envSnapshot,
      sceneConfig,
      sceneName,
      behaviorTags: this.lastInput?.behaviorTags ?? null,
    }

    this.lastInput = input

    // ── 决策逻辑 ──
    const { newState, reason } = this.decideState(input)

    // ── 去抖：状态需要持续稳定一段时间才切换 ──
    const resolved = this.applyDebounce(newState, reason)

    // ── 状态已变化 → 执行切换 ──
    if (resolved !== this.currentState) {
      this.transitionTo(resolved, reason)
    }

    return this.currentState
  }

  /**
   * 从外部注入行为标签（由 TtsPiperBridge 等调用者提供）。
   *
   * 行为标签来自 UserBehaviorService.getEnrichedState()，
   * 在每次 evaluate() 前通过此方法注入。
   */
  setBehaviorTags(tags: BehaviorTagInput | null): void {
    this.lastInput = {
      ...(this.lastInput ?? {
        environment: piperEnvironmentSensor.getCached(),
        sceneConfig: null,
        sceneName: null,
        behaviorTags: null,
      }),
      behaviorTags: tags,
    }
  }

  // ════════════════════════════════════════
  //  私有：决策逻辑
  // ════════════════════════════════════════

  /**
   * 核心决策逻辑 — 从输入信号决定新的状态。
   *
   * 优先级（高 → 低）：
   *   1. 系统静音 / 屏幕关闭 / 全屏且非聚焦 → Silent
   *   2. 会议场景检测 → Meeting
   *   3. 夜间时段 (22:00–07:00) + 低亮度 (< 30%) → Night
   *   4. 行为标签：用户离开或空闲太久 → Silent
   *   5. 以上都不满足 → Normal
   */
  private decideState(input: AutoStateInput): { newState: PiperAutoState; reason: string } {
    const { environment, sceneConfig, sceneName, behaviorTags } = input

    // ── 优先级 1: Silent 条件 ──
    if (environment.isMuted) {
      return { newState: 'Silent', reason: '系统静音' }
    }

    if (behaviorTags) {
      if (behaviorTags.activityState === 'away') {
        return { newState: 'Silent', reason: '行为标签: 用户已离开' }
      }

      // 全屏 + 非聚焦 → 可能在看视频/演示 → Silent
      if (behaviorTags.fullscreen && !behaviorTags.focused) {
        return { newState: 'Silent', reason: '行为标签: 全屏非聚焦（可能观看媒体）' }
      }

      // 空闲超 5 分钟 → Silent（对空房间不说话）
      if (behaviorTags.idleTimeMs > 5 * 60 * 1000) {
        return { newState: 'Silent', reason: '行为标签: 空闲超 5 分钟' }
      }
    }

    // ── 优先级 2: 会议检测 ──
    if (sceneName === 'meeting') {
      return { newState: 'Meeting', reason: '会议场景已检测' }
    }

    // ── 优先级 3: 夜间模式（时间 + 亮度） ──
    const currentHour = new Date().getHours()
    const isNightTime = currentHour >= NIGHT_HOUR_START || currentHour <= NIGHT_HOUR_END
    const isBrightnessLow =
      environment.valid && environment.brightness >= 0 ? environment.brightness < NIGHT_BRIGHTNESS_THRESHOLD : sceneName === 'late_night' // 降级：使用场景检测

    if (isNightTime && isBrightnessLow) {
      return {
        newState: 'Night',
        reason: `夜间时段 (${currentHour}:00) + 低亮度 (${environment.brightness}%)`,
      }
    }

    // 纯夜间时段（无亮度数据）→ 也切 Night
    if (isNightTime && !environment.valid) {
      return {
        newState: 'Night',
        reason: `夜间时段 (${currentHour}:00)（无法获取亮度，保守切换）`,
      }
    }

    // ── 优先级 4: 场景检测退化为 Night（late_night 场景） ──
    if (sceneName === 'late_night' && isNightTime) {
      return { newState: 'Night', reason: '深夜场景 + 夜间时段' }
    }

    // ── 默认: Normal ──
    return { newState: 'Normal', reason: '无特殊约束，标准输出' }
  }

  /**
   * 应用去抖：防止状态在短时间内频繁切换。
   *
   * 如果状态变化距离上次切换不足去抖窗口，且变化不可靠（置信度低），
   * 则保持当前状态。会议和静默属于"硬"切换，不受去抖限制。
   */
  private applyDebounce(newState: PiperAutoState, reason: string): PiperAutoState {
    const now = Date.now()

    // 没有变化 → 不需要去抖
    if (newState === this.currentState) {
      return newState
    }

    // "硬"切换：Silent 总是立即生效
    if (newState === 'Silent' || this.currentState === 'Silent') {
      return newState
    }

    // 去抖期内 → 保持原状态，但记录趋势
    if (now - this.lastTransitionTime < STATE_DEBOUNCE_MS) {
      log('DEBUG', 'piper_state_machine_debounce', {
        from: this.currentState,
        to: newState,
        reason,
        debounceRemainingMs: STATE_DEBOUNCE_MS - (now - this.lastTransitionTime),
      })
      return this.currentState
    }

    return newState
  }

  /**
   * 执行状态切换。
   */
  private transitionTo(newState: PiperAutoState, reason: string): void {
    const prev = this.currentState
    const prevConfig = this.currentConfig

    this.currentState = newState
    this.currentConfig = { ...STATE_CONFIG_MAP[newState] }
    this.lastTransitionTime = Date.now()
    this.lastReason = reason

    log('INFO', 'piper_state_machine_transition', {
      from: prev,
      to: newState,
      prevModel: prevConfig.piperModel,
      newModel: this.currentConfig.piperModel,
      prevSpeed: prevConfig.piperSpeed,
      newSpeed: this.currentConfig.piperSpeed,
      prevVolume: prevConfig.volume,
      newVolume: this.currentConfig.volume,
      reason,
    })
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/**
 * 全局单例。
 *
 * 所有 PiperTTS 行为感知状态管理应通过此单例统一访问。
 * 由 TtsPiperBridge 在每次合成前调用 evaluate() 获取最新状态，
 * 并通过 toBehaviorInput() 将决策注入 PiperBehaviorSidecar。
 */
export const piperTtsBehaviorStateMachine = new PiperTtsBehaviorStateMachine()
