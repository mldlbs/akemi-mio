/**
 * PiperTtsStateMachine — PiperTTS 行为驱动状态机
 *
 * ── 状态定义 ──
 * - normal:  常规输出，由 PiperSceneAdaptor 决定具体参数
 * - night:   深夜安静模式 (22:00-07:00 + 亮度 < 30%) → 极低音量 + 慢速 + 轻柔模型
 * - meeting: 会议模式 (PiperSceneAdaptor 检测到会议) → 低音量 + 中速
 * - silent:  静默模式 (系统静音或屏幕关闭) → 暂停所有 TTS
 *
 * ── 架构关系 ──
 *   PiperTtsEnvironmentMonitor (亮度/静音/时间)
 *          │
 *          ▼
 *   PiperTtsStateMachine  ←→  PiperSceneAdaptor (场景检测)
 *          │
 *          ▼
 *   PiperBehaviorSidecar / TtsPiperBridge
 *
 * ── 设计原则 ──
 * - 非侵入：不修改 PiperSceneAdaptor，在其输出上叠加环境感知逻辑
 * - 降级友好：所有环境信号查询失败时回退到正常场景模式
 * - 去抖稳定：状态切换带最短持续时间检查，防止频繁闪烁
 */
import { log } from '../logger/Logger'
import { piperSceneAdaptor } from './PiperSceneAdaptor'
import { piperTtsEnvironmentMonitor } from './PiperTtsEnvironmentMonitor'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** PiperTTS 行为驱动状态 */
export type PiperTtsBehaviorState = 'normal' | 'night' | 'meeting' | 'silent'

/** 状态对应的语音参数配置 */
export interface PiperTtsStateConfig {
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
}

/** 状态机输出结果 */
export interface PiperTtsStateResult {
  /** 当前行为状态 */
  state: PiperTtsBehaviorState
  /** 语音参数配置 */
  config: PiperTtsStateConfig
  /** 置信度 0–1 */
  confidence: number
  /** 人类可读描述 */
  description: string
  /** 是否应暂停所有 TTS 输出 */
  pauseTts: boolean
  /** 是否来自外部手动覆盖 */
  isManualOverride: boolean
}

/** 状态机配置 */
export interface PiperTtsStateMachineConfig {
  /** 是否启用状态机 */
  enabled: boolean
  /** 手动覆盖状态（'auto' = 自动检测） */
  overrideState: PiperTtsBehaviorState | 'auto'
  /** 深夜模式开始小时（默认 22） */
  nightStartHour: number
  /** 深夜模式结束小时（默认 7） */
  nightEndHour: number
  /** 深夜模式触发最大亮度（默认 30%） */
  nightBrightnessThreshold: number
  /** 状态切换去抖时间（毫秒，默认 30s） */
  debounceMs: number
}

// ══════════════════════════════════════════
//  默认状态配置
// ══════════════════════════════════════════

/** 各状态的默认语音参数 */
const STATE_CONFIGS: Record<PiperTtsBehaviorState, PiperTtsStateConfig> = {
  normal: {
    piperModel: 'zh_CN-huayan-medium',
    piperSpeed: 1.0,
    piperPitch: 1.0,
    volume: 0.85,
    label: '正常·通用',
  },
  night: {
    piperModel: 'zh_CN-ling_ling-medium',
    piperSpeed: 0.8,
    piperPitch: 0.85,
    volume: 0.2,
    label: '深夜·静谧',
  },
  meeting: {
    piperModel: 'zh_CN-huayan-medium',
    piperSpeed: 0.9,
    piperPitch: 0.95,
    volume: 0.6,
    label: '会议·轻柔',
  },
  silent: {
    piperModel: 'zh_CN-huayan-medium',
    piperSpeed: 1.0,
    piperPitch: 1.0,
    volume: 0,
    label: '静默·暂停',
  },
}

const DEFAULT_CONFIG: PiperTtsStateMachineConfig = {
  enabled: true,
  overrideState: 'auto',
  nightStartHour: 22,
  nightEndHour: 7,
  nightBrightnessThreshold: 30,
  debounceMs: 30_000,
}

// ══════════════════════════════════════════
//  PiperTtsStateMachine
// ══════════════════════════════════════════

export class PiperTtsStateMachine {
  private config: PiperTtsStateMachineConfig

  /** 当前稳定状态（去抖后） */
  private stableState: PiperTtsBehaviorState = 'normal'
  private stableSince = 0
  private lastResult: PiperTtsStateResult | null = null

  constructor(config?: Partial<PiperTtsStateMachineConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  // ════════════════════════════════════════
  //  配置管理
  // ════════════════════════════════════════

  updateConfig(partial: Partial<PiperTtsStateMachineConfig>): void {
    this.config = { ...this.config, ...partial }
    log('INFO', 'piper_tts_sm_config_updated', {
      enabled: this.config.enabled,
      overrideState: this.config.overrideState,
    })
  }

  getConfig(): PiperTtsStateMachineConfig {
    return { ...this.config }
  }

  /**
   * 设置手动覆盖状态。
   * 设为 'auto' 恢复自动检测。
   */
  setOverrideState(state: PiperTtsBehaviorState | 'auto'): void {
    const prev = this.config.overrideState
    if (prev === state) return
    this.config.overrideState = state
    this.lastResult = null
    this.stableState = 'normal'
    this.stableSince = 0
    log('INFO', 'piper_tts_sm_override', { from: prev, to: state })
  }

  getOverrideState(): PiperTtsBehaviorState | 'auto' {
    return this.config.overrideState
  }

  // ════════════════════════════════════════
  //  核心 API
  // ════════════════════════════════════════

  /**
   * 获取当前状态机的输出结果。
   *
   * 综合环境信号 + 场景检测，决定当前状态和语音参数。
   * 结果带去抖逻辑，避免频繁状态闪烁。
   */
  getState(): PiperTtsStateResult {
    // ── 禁用：返回正常状态 ──
    if (!this.config.enabled) {
      return this.buildNormalResult('状态机已禁用', false)
    }

    // ── 手动覆盖 ──
    if (this.config.overrideState !== 'auto') {
      const state = this.config.overrideState
      return this.buildResult(state, 1.0, `手动·${STATE_CONFIGS[state].label}`, true)
    }

    // ── 自动检测 ──
    const raw = this.detectState()
    return this.applyDebounce(raw)
  }

  /**
   * 强制刷新（忽略缓存）。
   */
  refresh(): PiperTtsStateResult {
    this.lastResult = null
    this.stableState = 'normal'
    this.stableSince = 0
    return this.getState()
  }

  /**
   * 获取当前稳定状态的只读信息（供调试/UI）。
   */
  getStatus(): {
    enabled: boolean
    currentState: PiperTtsBehaviorState
    overrideState: PiperTtsBehaviorState | 'auto'
  } {
    return {
      enabled: this.config.enabled,
      currentState: this.stableState,
      overrideState: this.config.overrideState,
    }
  }

  // ════════════════════════════════════════
  //  状态检测
  // ════════════════════════════════════════

  /**
   * 检测当前状态（无去抖）。
   *
   * 优先级（高 → 低）：
   * 1. 静默模式：系统静音 → silent
   * 2. 深夜模式：22:00-07:00 + 亮度 < 30% → night
   * 3. 会议模式：PiperSceneAdaptor 检测到会议 → meeting
   * 4. 正常模式：委托 PiperSceneAdaptor 场景配置 → normal
   */
  private detectState(): PiperTtsStateResult {
    const signals = piperTtsEnvironmentMonitor.getSignals()

    // ── 规则 1：系统静音 → 静默 ──
    if (signals.systemMuted === true) {
      return this.buildResult('silent', 0.9, '系统静音，暂停 TTS', false)
    }

    // ── 规则 2：深夜安静模式 ──
    const hour = signals.currentHour
    const brightness = signals.screenBrightness
    const isNightTime = this.isNightHour(hour)
    const isLowBrightness = brightness !== null && brightness < this.config.nightBrightnessThreshold

    if (isNightTime && isLowBrightness) {
      return this.buildResult(
        'night',
        brightness !== null ? 0.85 : 0.6,
        `深夜时段 (${hour}:00) + 屏幕低亮度 (${brightness}%)`,
        false,
      )
    }

    // 单纯深夜（亮度不可用或不足），使用环境光不足时的宽松判定
    if (isNightTime && brightness === null) {
      // 如果亮度不可获取，仅按时间判定（置信度较低）
      return this.buildResult('night', 0.55, `深夜时段 (${hour}:00)·无亮度数据`, false)
    }

    // ── 规则 3：会议模式 ──
    // 委托 PiperSceneAdaptor 的会议检测能力
    try {
      const sceneResult = piperSceneAdaptor.getAdaptedConfig()
      if (sceneResult.scene === 'meeting' && sceneResult.confidence >= 0.4) {
        return this.buildResult('meeting', sceneResult.confidence, sceneResult.description, false)
      }
    } catch {
      // 场景检测失败时降级到 normal
    }

    // ── 默认：正常模式 ──
    // 尝试获取场景适配器的参数作为正常模式的基线
    try {
      const sceneResult = piperSceneAdaptor.getAdaptedConfig()
      if (sceneResult.confidence >= 0.3) {
        return {
          state: 'normal',
          config: {
            piperModel: sceneResult.config.piperModel,
            piperSpeed: sceneResult.config.piperSpeed,
            piperPitch: sceneResult.config.piperPitch,
            volume: sceneResult.config.volume,
            label: `正常·${sceneResult.config.label}`,
          },
          confidence: sceneResult.confidence,
          description: sceneResult.description,
          pauseTts: false,
          isManualOverride: sceneResult.isManualOverride,
        }
      }
    } catch {
      // 降级到默认配置
    }

    return this.buildNormalResult('正常·默认', false)
  }

  // ════════════════════════════════════════
  //  去抖机制
  // ════════════════════════════════════════

  /**
   * 应用去抖逻辑：状态必须稳定一段时间后才切换。
   * 防止频繁闪烁（如亮度在阈值附近波动）。
   */
  private applyDebounce(raw: PiperTtsStateResult): PiperTtsStateResult {
    const now = Date.now()

    // silent 状态立即生效（安全关键）
    if (raw.state === 'silent') {
      this.stableState = 'silent'
      this.stableSince = now
      this.lastResult = raw
      return raw
    }

    if (this.stableState === raw.state) {
      // 同状态持续中
      this.stableSince = this.stableSince || now

      // 去抖期已过 → 允许
      if (now - this.stableSince >= this.config.debounceMs) {
        this.lastResult = raw
        return raw
      }

      // 高置信度可提前通过去抖
      if (raw.confidence >= 0.8) {
        this.lastResult = raw
        return raw
      }

      // 仍在去抖中 → 返回上一次结果（如果有）
      if (this.lastResult) {
        return {
          ...this.lastResult,
          confidence: raw.confidence * 0.8,
          description: `去抖·${raw.description}`,
        }
      }

      return raw
    }

    // 状态变化：记录新状态
    this.stableState = raw.state
    this.stableSince = now

    // 高置信度直接切换
    if (raw.confidence >= 0.65) {
      this.lastResult = raw
      return raw
    }

    // 低置信度切换 → 保持上次结果
    if (this.lastResult) {
      return {
        ...this.lastResult,
        confidence: raw.confidence * 0.5,
        description: `过渡·${raw.description}`,
      }
    }

    return raw
  }

  // ════════════════════════════════════════
  //  工具方法
  // ════════════════════════════════════════

  /**
   * 判断当前小时是否属于深夜时间范围。
   * 支持跨午夜范围（如 22:00-07:00）。
   */
  private isNightHour(hour: number): boolean {
    const { nightStartHour, nightEndHour } = this.config
    if (nightStartHour > nightEndHour) {
      // 跨午夜：22:00-07:00
      return hour >= nightStartHour || hour <= nightEndHour
    }
    // 同一天内
    return hour >= nightStartHour && hour <= nightEndHour
  }

  /** 构建状态结果 */
  private buildResult(
    state: PiperTtsBehaviorState,
    confidence: number,
    description: string,
    isManualOverride: boolean,
  ): PiperTtsStateResult {
    const config = STATE_CONFIGS[state]
    return {
      state,
      config: { ...config },
      confidence: Math.min(1, Math.max(0, confidence)),
      description,
      pauseTts: state === 'silent',
      isManualOverride,
    }
  }

  /** 构建正常模式结果 */
  private buildNormalResult(description: string, isManualOverride: boolean): PiperTtsStateResult {
    return this.buildResult('normal', 0.5, description, isManualOverride)
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例 */
export const piperTtsStateMachine = new PiperTtsStateMachine()
