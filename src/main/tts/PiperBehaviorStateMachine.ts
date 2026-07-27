/**
 * PiperBehaviorStateMachine — PiperTTS 行为状态机
 *
 * ── 架构角色 ──
 *
 * 整合系统环境信号（当前时间、屏幕亮度、系统静音状态、屏幕状态）
 * 和 UserBehavior 行为信号（行为模式、活动状态、会议检测），通过规则引擎
 * 推导出当前最合适的 PiperTTS 工作状态（normal/night/meeting/silent），
 * 并映射为具体的 BehaviorSidecarInput 参数。
 *
 * ── 状态定义 ──
 *
 * normal  → 标准模式：默认参数
 * night   → 夜间模式：22:00-07:00 + 屏幕亮度 < 30%
 *            → 音量 20%、语速 0.8x、切换 ling_ling-medium（轻柔模型）
 * meeting → 会议模式：检测到会议/通话应用在前台
 *            → 音量 60%、语速 0.9x、轻柔参数
 * silent  → 静默模式：系统静音或屏幕关闭
 *            → 暂停全部 TTS 输出
 *
 * ── 规则优先级（高 → 低）──
 *   1. 系统静音 / 屏幕关闭 → silent
 *   2. 夜间时段 + 低亮度   → night
 *   3. 会议窗口             → meeting
 *   4. 默认                 → normal
 *
 * ── 传感器集成 ──
 *   屏幕亮度：Windows WMI (WmiMonitorBrightness) PowerShell 查询
 *   系统静音：Windows winmm.dll (waveOutGetVolume@0 → muted) PowerShell 查询
 *   系统时间：Date API
 *   会议检测：委托 PiperSceneAdaptor
 *   UserBehavior：通过 setBehaviorContext() 接受外部注入
 *
 * ── 设计原则 ──
 *   1. 无阻塞 — 传感器查询异步、缓存，不阻塞合成路径
 *   2. 安全降级 — 传感器不可用时退回到仅时间/行为信号判断
 *   3. 零外部依赖 — 不引入新的 npm 包，仅使用 Node.js/Electron 内置 API
 *   4. 可测试 — 状态评估逻辑纯函数，传感器独立为可 mock 的 Monitor
 *
 * ── 使用方式 ──
 *
 *   import { piperBehaviorStateMachine } from './PiperBehaviorStateMachine'
 *
 *   // 可选：注入 UserBehavior 行为上下文
 *   piperBehaviorStateMachine.setBehaviorContext({
 *     mode: 'focus',
 *     activityState: 'active',
 *     fullscreen: true,
 *   })
 *
 *   // 获取当前状态和对应的 BehaviorSidecarInput
 *   const output = await piperBehaviorStateMachine.evaluate()
 *   // output = { state: 'night', behaviorInput: { ... }, reason: '夜间时段+低亮度' }
 */

import { execFile } from 'child_process'
import { log } from '../logger/Logger'
import { piperSceneAdaptor } from './PiperSceneAdaptor'
import type { BehaviorSidecarInput } from './PiperBehaviorSidecar'
import type { BehaviorMode } from '../behavior/BehaviorStateMachine'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** PiperTTS 工作状态 */
export type PiperTtsState = 'normal' | 'night' | 'meeting' | 'silent'

/** 各状态的参数配置 */
export interface PiperTtsStateConfig {
  /** 音量 0–1 */
  volume: number
  /** 语速因子 0.5–2.0 */
  speed: number
  /** 音调因子 */
  pitch: number
  /** Piper 模型名 */
  model: string
  /** 是否暂停 TTS */
  pauseTts: boolean
}

/** 状态 → 参数映射表 */
export const PIPER_TTS_STATE_CONFIG: Record<PiperTtsState, PiperTtsStateConfig> = {
  normal: {
    volume: 0.85,
    speed: 1.0,
    pitch: 1.0,
    model: 'zh_CN-huayan-medium',
    pauseTts: false,
  },
  night: {
    volume: 0.2,
    speed: 0.8,
    pitch: 0.85,
    model: 'zh_CN-ling_ling-medium',
    pauseTts: false,
  },
  meeting: {
    volume: 0.6,
    speed: 0.9,
    pitch: 0.95,
    model: 'zh_CN-huayan-medium',
    pauseTts: false,
  },
  silent: {
    volume: 0,
    speed: 1.0,
    pitch: 1.0,
    model: 'zh_CN-huayan-medium',
    pauseTts: true,
  },
}

/** 环境传感器快照 */
export interface SensorSnapshot {
  /** 当前小时 (0–23) */
  hour: number
  /** 屏幕亮度百分比 0–100, null = 未知 */
  screenBrightness: number | null
  /** 系统是否静音, null = 未知 */
  systemMuted: boolean | null
  /** 屏幕是否关闭, null = 未知 */
  screenOff: boolean | null
  /** 传感器快照时间戳 */
  timestamp: number
}

/** UserBehavior 行为上下文（外部注入） */
export interface BehaviorContext {
  /** 行为模式 */
  mode?: BehaviorMode | null
  /** 活动状态 */
  activityState?: string | null
  /** 是否全屏 */
  fullscreen?: boolean | null
  /** 窗口是否聚焦 */
  focused?: boolean | null
}

/** 状态机输出 */
export interface StateMachineOutput {
  /** 当前状态 */
  state: PiperTtsState
  /** 对应的 BehaviorSidecarInput */
  behaviorInput: BehaviorSidecarInput
  /** 人类可读的判断原因 */
  reason: string
  /** 传感器快照（调试用） */
  sensorSnapshot: SensorSnapshot
}

/** 默认传感器快照（全未知） */
const DEFAULT_SENSOR_SNAPSHOT: SensorSnapshot = {
  hour: new Date().getHours(),
  screenBrightness: null,
  systemMuted: null,
  screenOff: null,
  timestamp: Date.now(),
}

// ══════════════════════════════════════════
//  传感器监控器
// ══════════════════════════════════════════

/**
 * 传感器监控器配置
 */
export interface MonitorConfig {
  /** 屏幕亮度查询间隔（毫秒） */
  brightnessPollMs: number
  /** 系统静音查询间隔（毫秒） */
  mutePollMs: number
  /** PowerShell 命令超时（毫秒） */
  powershellTimeoutMs: number
  /** 传感器缓存有效期（毫秒），过期后返回 null */
  sensorCacheTtlMs: number
}

const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
  brightnessPollMs: 30000,
  mutePollMs: 30000,
  powershellTimeoutMs: 5000,
  sensorCacheTtlMs: 60000,
}

/**
 * 传感器监控 — 收集屏幕亮度、系统静音等环境信号。
 *
 * 所有传感器查询异步执行，结果缓存以避免阻塞合成路径。
 * 传感器不可用时安全降级（返回 null）。
 */
class SensorMonitor {
  private config: MonitorConfig

  // 缓存
  private _brightness: number | null = null
  private _brightnessTime = 0
  private _muted: boolean | null = null
  private _mutedTime = 0
  /** 屏幕关闭时间戳（由外部通过 powerMonitor 注入，0 = 屏幕已开启） */
  private _screenOffTimestamp = 0

  // 轮询定时器
  private brightnessTimer: ReturnType<typeof setInterval> | null = null
  private muteTimer: ReturnType<typeof setInterval> | null = null

  // Win32 平台标记（缓存以避免重复检测）
  private _isWin32 = process.platform === 'win32'

  constructor(config?: Partial<MonitorConfig>) {
    this.config = { ...DEFAULT_MONITOR_CONFIG, ...config }
  }

  // ── 生命周期 ──

  /** 启动传感器轮询 */
  start(): void {
    this.stop()

    if (this._isWin32) {
      this.brightnessTimer = setInterval(() => {
        this.pollBrightness()
      }, this.config.brightnessPollMs)
      // 首次立即查询
      this.pollBrightness()

      this.muteTimer = setInterval(() => {
        this.pollSystemMute()
      }, this.config.mutePollMs)
      this.pollSystemMute()
    }

    log('INFO', 'piper_state_machine_monitor_started', {
      win32: this._isWin32,
      brightnessPollMs: this.config.brightnessPollMs,
      mutePollMs: this.config.mutePollMs,
    })
  }

  /** 停止传感器轮询 */
  stop(): void {
    if (this.brightnessTimer) {
      clearInterval(this.brightnessTimer)
      this.brightnessTimer = null
    }
    if (this.muteTimer) {
      clearInterval(this.muteTimer)
      this.muteTimer = null
    }
  }

  /** 获取当前传感器快照 */
  getSnapshot(): SensorSnapshot {
    const now = Date.now()
    return {
      hour: new Date().getHours(),
      screenBrightness:
        now - this._brightnessTime < this.config.sensorCacheTtlMs ? this._brightness : null,
      systemMuted:
        now - this._mutedTime < this.config.sensorCacheTtlMs ? this._muted : null,
      screenOff:
        this._screenOffTimestamp > 0 && now - this._screenOffTimestamp < this.config.sensorCacheTtlMs
          ? true
          : null,
      timestamp: now,
    }
  }

  /** 外部注入屏幕关闭状态 */
  setScreenOff(value: boolean): void {
    // 由外部（AppRuntime/powerMonitor）在 lock-screen / unlock 事件时注入
    if (value) {
      this._screenOffTimestamp = Date.now()
    } else {
      this._screenOffTimestamp = 0
    }
  }

  /** 强制刷新亮度（通常需求时调用） */
  async refreshBrightness(): Promise<number | null> {
    if (!this._isWin32) return null
    return this.pollBrightness()
  }

  /** 强制刷新静音状态 */
  async refreshMute(): Promise<boolean | null> {
    if (!this._isWin32) return null
    return this.pollSystemMute()
  }

  // ── 私有：传感器查询 ──

  /**
   * 通过 Windows WMI 查询屏幕亮度。
   * PowerShell: (Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness).CurrentBrightness
   * 返回 0–100 或 null（失败时）
   */
  private pollBrightness(): number | null {
    if (!this._isWin32) return null

    // 先尝试从缓存返回（避免频繁调用 PowerShell）
    const now = Date.now()
    if (now - this._brightnessTime < this.config.brightnessPollMs / 2) {
      return this._brightness
    }

    // 异步启动查询，不等待（缓存会在回调中更新）
    this.execBrightnessQuery()
    return this._brightness
  }

  private execBrightnessQuery(): void {
    const proc = execFile(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness).CurrentBrightness',
      ],
      { timeout: this.config.powershellTimeoutMs, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) {
          log('WARN', 'piper_state_machine_brightness_failed', {
            error: err?.message ?? 'no output',
          })
          return
        }
        const val = parseInt(stdout.trim(), 10)
        if (!isNaN(val) && val >= 0 && val <= 100) {
          this._brightness = val
          this._brightnessTime = Date.now()
          log('DEBUG', 'piper_state_machine_brightness', { brightness: val })
        }
      },
    )
    // 防止进程句柄泄漏
    proc.unref()
  }

  /**
   * 通过 Windows winmm.dll 查询系统是否静音。
   * waveOutGetVolume 返回左右声道音量，各 16 位（0–0xFFFF）。
   * 左声道为 0 → 系统静音。
   *
   * PowerShell inline C#:
   *   Add-Type -TypeDefinition '...'; [AudioMute]::IsMuted()
   */
  private pollSystemMute(): boolean | null {
    if (!this._isWin32) return null

    const now = Date.now()
    if (now - this._mutedTime < this.config.mutePollMs / 2) {
      return this._muted
    }

    this.execMuteQuery()
    return this._muted
  }

  private execMuteQuery(): void {
    const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class AudioMute {
    [DllImport("winmm.dll")]
    public static extern int waveOutGetVolume(IntPtr hwo, out uint dwVolume);
    public static bool IsMuted() {
        uint vol;
        int ret = waveOutGetVolume(IntPtr.Zero, out vol);
        if (ret != 0) return false;
        return (vol & 0xFFFF) == 0;
    }
}
'@
[AudioMute]::IsMuted()
`.trim()

    const proc = execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: this.config.powershellTimeoutMs, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) {
          log('WARN', 'piper_state_machine_mute_failed', {
            error: err?.message ?? 'no output',
          })
          return
        }
        const trimmed = stdout.trim().toLowerCase()
        if (trimmed === 'true') {
          this._muted = true
          this._mutedTime = Date.now()
          log('DEBUG', 'piper_state_machine_mute', { muted: true })
        } else if (trimmed === 'false') {
          this._muted = false
          this._mutedTime = Date.now()
        }
        // else: 无法解析，保持原值
      },
    )
    proc.unref()
  }
}

// ══════════════════════════════════════════
//  PiperBehaviorStateMachine
// ══════════════════════════════════════════

export class PiperBehaviorStateMachine {
  /** 传感器监控器 */
  readonly sensorMonitor: SensorMonitor

  /** 外部注入的 UserBehavior 行为上下文 */
  private _behaviorContext: BehaviorContext = {}

  /** 是否已启动 */
  private _started = false

  /** 最近一次评估结果 */
  private _lastOutput: StateMachineOutput | null = null

  /** 最近一次评估时间 */
  private _lastEvalTime = 0

  /** 评估结果缓存时间（防抖） */
  private readonly EVAL_CACHE_TTL_MS = 2000

  constructor(monitorConfig?: Partial<MonitorConfig>) {
    this.sensorMonitor = new SensorMonitor(monitorConfig)
  }

  // ══════════════════════════════════════════
  //  生命周期
  // ══════════════════════════════════════════

  /**
   * 启动状态机（启动传感器轮询）。
   * 在应用初始化时调用一次。
   */
  start(): void {
    if (this._started) return
    this._started = true
    this.sensorMonitor.start()
    log('INFO', 'piper_state_machine_started')
  }

  /**
   * 停止状态机。
   */
  stop(): void {
    if (!this._started) return
    this._started = false
    this.sensorMonitor.stop()
    log('INFO', 'piper_state_machine_stopped')
  }

  /** 是否已启动 */
  get started(): boolean {
    return this._started
  }

  // ══════════════════════════════════════════
  //  行为上下文注入
  // ══════════════════════════════════════════

  /**
   * 设置外部 UserBehavior 行为上下文。
   *
   * 由 TtsPiperBridge 在每次合成前调用，将最新的行为状态注入状态机。
   * 传入 null 或空对象则重置为默认值。
   */
  setBehaviorContext(ctx: BehaviorContext | null): void {
    this._behaviorContext = ctx ?? {}
  }

  /**
   * 获取当前行为上下文的只读快照。
   */
  getBehaviorContext(): Readonly<BehaviorContext> {
    return Object.freeze({ ...this._behaviorContext })
  }

  // ══════════════════════════════════════════
  //  核心评估方法
  // ══════════════════════════════════════════

  /**
   * 评估当前状态 — 根据传感器快照和行为上下文推导最佳状态。
   *
   * 如果未启动，退回到仅基于时间+行为上下文的轻量判断。
   *
   * 结果内部缓存 2 秒以防抖（频繁调用时不重复执行规则引擎）。
   */
  async evaluate(): Promise<StateMachineOutput> {
    const now = Date.now()

    // 缓存命中（2 秒内）
    if (this._lastOutput && now - this._lastEvalTime < this.EVAL_CACHE_TTL_MS) {
      return this._lastOutput
    }

    // 获取当前传感器快照
    const sensor = this.sensorMonitor.getSnapshot()

    // 执行状态规则评估（纯函数）
    const output = this.evaluateRules(sensor, this._behaviorContext)

    this._lastOutput = output
    this._lastEvalTime = now

    return output
  }

  /**
   * 强制重新评估（跳过缓存）。
   * 在行为上下文发生重大变化时调用。
   */
  async forceEvaluate(): Promise<StateMachineOutput> {
    this._lastOutput = null
    this._lastEvalTime = 0
    return this.evaluate()
  }

  /**
   * 获取最近一次评估结果。
   * 如果从未评估过，返回默认 normal 状态。
   */
  getLastOutput(): StateMachineOutput {
    return (
      this._lastOutput ?? {
        state: 'normal',
        behaviorInput: this.stateToBehaviorInput('normal'),
        reason: '初始默认',
        sensorSnapshot: DEFAULT_SENSOR_SNAPSHOT,
      }
    )
  }

  // ══════════════════════════════════════════
  //  规则引擎（纯函数，可测试）
  // ══════════════════════════════════════════

  /**
   * 状态规则评估 — 纯函数，不依赖实例状态。
   *
   * 规则优先级（高 → 低）：
   *   1. 系统静音 / 屏幕关闭 → silent
   *   2. 夜间时段 (22:00-07:00) + 低亮度 (< 30%) → night
   *   3. 会议窗口检测 → meeting
   *   4. 默认 → normal
   *
   * 屏幕亮度未知时，仅凭夜间时段也触发 night（安全优先）。
   * 传感器数据过期时（超过 cacheTtl），忽略该传感器信号。
   */
  evaluateRules(
    sensor: SensorSnapshot,
    behavior: BehaviorContext,
  ): StateMachineOutput {
    // ── 规则 1: 系统静音 / 屏幕关闭 → silent ──
    if (sensor.systemMuted === true || sensor.screenOff === true) {
      return {
        state: 'silent',
        behaviorInput: this.stateToBehaviorInput('silent'),
        reason: sensor.systemMuted ? '系统静音' : '屏幕关闭',
        sensorSnapshot: sensor,
      }
    }

    // ── 规则 2: 夜间时段 + 低亮度 → night ──
    const hour = sensor.hour
    const isNight = hour >= 22 || hour < 7
    const brightness = sensor.screenBrightness
    const isLowBrightness = brightness !== null && brightness < 30

    if (isNight && (isLowBrightness || brightness === null)) {
      // 晚上 22 点后 + 亮度 < 30%（或未知）→ 夜间模式
      // 安全优先：亮度未知时在深夜时段也触发
      return {
        state: 'night',
        behaviorInput: this.stateToBehaviorInput('night'),
        reason: brightness !== null
          ? `夜间时段+低亮度(${brightness}%)`
          : `夜间时段(亮度未知，安全降级)`,
        sensorSnapshot: sensor,
      }
    }

    // ── 规则 3: 会议检测 → meeting（委托 PiperSceneAdaptor）──
    // 仅在白天且非夜间时检查会议
    const sceneResult = piperSceneAdaptor.getAdaptedConfig()
    if (sceneResult.scene === 'meeting' && sceneResult.confidence >= 0.5) {
      return {
        state: 'meeting',
        behaviorInput: this.stateToBehaviorInput('meeting'),
        reason: `会议检测: ${sceneResult.description}`,
        sensorSnapshot: sensor,
      }
    }

    // ── 全屏但不是会议 → 也走 meeting 模式（避免打扰） ──
    if (behavior.fullscreen === true) {
      return {
        state: 'meeting',
        behaviorInput: this.stateToBehaviorInput('meeting'),
        reason: '全屏模式，降低 TTS 干扰',
        sensorSnapshot: sensor,
      }
    }

    // ── 规则 4: 默认 → normal ──
    return {
      state: 'normal',
      behaviorInput: this.stateToBehaviorInput('normal'),
      reason: '无特殊行为约束',
      sensorSnapshot: sensor,
    }
  }

  // ══════════════════════════════════════════
  //  状态 → BehaviorSidecarInput 转换
  // ══════════════════════════════════════════

  /**
   * 将 PiperTtsState 转换为 BehaviorSidecarInput。
   *
   * 将状态机的状态/参数映射为边车能够消费的行为上下文格式。
   * 只有非 normal 状态才设置 outputMode 和 rateSuggestion/volumeSuggestion，
   * 避免覆盖上层已经设定的行为上下文。
   */
  stateToBehaviorInput(state: PiperTtsState): BehaviorSidecarInput {
    const cfg = PIPER_TTS_STATE_CONFIG[state]

    switch (state) {
      case 'silent':
        return {
          outputMode: 'silent',
          pauseTts: true,
          rateSuggestion: 0,
          pitchSuggestion: 0,
          volumeSuggestion: 0,
        }

      case 'night':
        return {
          outputMode: 'gentle',
          pauseTts: false,
          rateSuggestion: -20, // 缓慢 (0.8x)
          pitchSuggestion: -15, // 低沉 (0.85x) ≈ ling_ling-medium
          volumeSuggestion: cfg.volume, // 0.2
        }

      case 'meeting':
        return {
          outputMode: 'gentle',
          pauseTts: false,
          rateSuggestion: -10, // 稍慢 (0.9x)
          pitchSuggestion: -5, // 稍低
          volumeSuggestion: cfg.volume, // 0.6
        }

      case 'normal':
      default:
        return {
          outputMode: null,
          pauseTts: false,
          rateSuggestion: 0,
          pitchSuggestion: 0,
          volumeSuggestion: cfg.volume, // 0.85
        }
    }
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/**
 * 全局单例。
 *
 * 由 TtsPiperBridge 在合成前调用 evaluate() 获取当前状态，
 * 将结果与 UserBehaviorTtsNeed 合并后注入 PiperBehaviorSidecar。
 *
 * start() 在 AppRuntime 初始化时调用，启动传感器轮询。
 * stop() 在应用退出时调用，停止传感器轮询。
 */
export const piperBehaviorStateMachine = new PiperBehaviorStateMachine()
