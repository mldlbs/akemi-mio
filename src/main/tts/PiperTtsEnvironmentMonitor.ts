/**
 * PiperTtsEnvironmentMonitor — PiperTTS 环境信号监控器
 *
 * ── 职责 ──
 * 监控影响语音输出的环境信号：
 * 1. 屏幕亮度（通过 WMI / Windows API）
 * 2. 系统静音状态（通过 Windows Audio API）
 * 3. 当前时间（本地时区）
 *
 * ── 设计 ──
 * - 使用 PowerShell 后台查询 Windows 系统状态，与 app-window-polling 同模式
 * - 结果缓存（带 TTL），避免频繁调用 PowerShell
 * - 所有查询静默失败（查询失败时返回 null，不影响 TTS 正常输出）
 * - 支持事件驱动：信号变化时回调通知
 *
 * ── 集成 ──
 * 由 PiperTtsStateMachine 消费。不直接依赖其他 TTS 模块。
 */
import { log } from '../logger/Logger'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 环境信号快照 */
export interface EnvironmentSignals {
  /** 屏幕亮度百分比 0–100，null 表示无法获取 */
  screenBrightness: number | null
  /** 系统是否静音，null 表示无法判断 */
  systemMuted: boolean | null
  /** 当前小时 (0–23) */
  currentHour: number
  /** 信号采集时间戳 */
  timestamp: number
}

/** 环境信号变化回调 */
export type SignalChangeCallback = (signals: EnvironmentSignals) => void

// ══════════════════════════════════════════
//  常量
// ══════════════════════════════════════════

/** PowerShell 查询超时（毫秒） */
const PS_TIMEOUT_MS = 3000

/** 信号缓存 TTL（毫秒） */
const CACHE_TTL_MS = 30_000

/** 后台轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 60_000

// ══════════════════════════════════════════
//  PiperTtsEnvironmentMonitor
// ══════════════════════════════════════════

export class PiperTtsEnvironmentMonitor {
  // ── 缓存 ──
  private cachedBrightness: number | null = null
  private cachedMuted: boolean | null = null
  private lastCacheTime = 0

  // ── 轮询 ──
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private changeCallbacks: SignalChangeCallback[] = []

  // ── 上次信号值（用于检测变化） ──
  private lastSignals: EnvironmentSignals | null = null

  // ════════════════════════════════════════
  //  生命周期
  // ════════════════════════════════════════

  /**
   * 开始后台信号轮询。
   * 仅在 Windows 上实际启用。
   */
  start(): void {
    if (process.platform !== 'win32') {
      log('INFO', 'piper_env_monitor_skipped', { platform: process.platform, reason: '仅支持 Windows' })
      return
    }

    if (this.pollTimer) return

    // 立即采集一次
    this.collectAllSignals()

    // 定时轮询
    this.pollTimer = setInterval(() => {
      this.collectAllSignals()
    }, POLL_INTERVAL_MS)

    log('INFO', 'piper_env_monitor_started', { pollIntervalMs: POLL_INTERVAL_MS })
  }

  /**
   * 停止后台轮询。
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.changeCallbacks = []
    log('INFO', 'piper_env_monitor_stopped')
  }

  /**
   * 注册信号变化回调。
   * 返回取消订阅函数。
   */
  onChange(cb: SignalChangeCallback): () => void {
    this.changeCallbacks.push(cb)
    return () => {
      const idx = this.changeCallbacks.indexOf(cb)
      if (idx >= 0) this.changeCallbacks.splice(idx, 1)
    }
  }

  // ════════════════════════════════════════
  //  信号查询 API（走缓存）
  // ════════════════════════════════════════

  /**
   * 获取当前环境信号快照。
   * 优先使用缓存，缓存过期时异步刷新。
   */
  getSignals(): EnvironmentSignals {
    this.refreshCacheIfExpired()
    return {
      screenBrightness: this.cachedBrightness,
      systemMuted: this.cachedMuted,
      currentHour: new Date().getHours(),
      timestamp: Date.now(),
    }
  }

  /**
   * 仅获取屏幕亮度（快速查询，走缓存）。
   */
  getScreenBrightness(): number | null {
    this.refreshCacheIfExpired()
    return this.cachedBrightness
  }

  /**
   * 仅获取系统静音状态（快速查询，走缓存）。
   */
  getSystemMuted(): boolean | null {
    this.refreshCacheIfExpired()
    return this.cachedMuted
  }

  /**
   * 获取当前小时（本地时区）。
   */
  getCurrentHour(): number {
    return new Date().getHours()
  }

  // ════════════════════════════════════════
  //  缓存管理
  // ════════════════════════════════════════

  /**
   * 如果缓存过期，异步刷新所有信号。
   * 刷新期间缓存值保持旧值不变。
   */
  private refreshCacheIfExpired(): void {
    if (Date.now() - this.lastCacheTime < CACHE_TTL_MS) return
    // 后台刷新，不阻塞调用方
    this.collectAllSignals()
  }

  /**
   * 异步采集所有环境信号（PowerShell）。
   */
  private async collectAllSignals(): Promise<void> {
    try {
      const [brightness, muted] = await Promise.all([
        this.fetchScreenBrightness(),
        this.fetchSystemMuted(),
      ])

      this.cachedBrightness = brightness
      this.cachedMuted = muted
      this.lastCacheTime = Date.now()

      const signals: EnvironmentSignals = {
        screenBrightness: brightness,
        systemMuted: muted,
        currentHour: new Date().getHours(),
        timestamp: this.lastCacheTime,
      }

      // 检测变化并通知
      this.detectAndNotify(signals)
    } catch {
      // 静默失败，保留旧缓存值
    }
  }

  // ════════════════════════════════════════
  //  PowerShell 信号采集
  // ════════════════════════════════════════

  /**
   * 通过 PowerShell WMI 查询屏幕亮度。
   *
   * 使用 Get-CimInstance 查询 WmiMonitorBrightness 类。
   * 某些系统/显示器可能不支持此 WMI 类，此时返回 null。
   */
  private async fetchScreenBrightness(): Promise<number | null> {
    try {
      const script = `
        try {
          $brightness = Get-CimInstance -Namespace "root/WMI" -ClassName "WmiMonitorBrightness" -ErrorAction Stop
          if ($brightness -and $brightness.CurrentBrightness -ne $null) {
            Write-Output $brightness.CurrentBrightness
          } else {
            Write-Output "null"
          }
        } catch {
          Write-Output "null"
        }
      `

      const result = await this.runPowerShell(script)
      const trimmed = result.trim()

      if (trimmed === 'null' || trimmed === '') return null

      const value = parseInt(trimmed, 10)
      return isNaN(value) ? null : Math.max(0, Math.min(100, value))
    } catch {
      return null
    }
  }

  /**
   * 通过 PowerShell + Win32 API 检测系统是否静音。
   *
   * 使用 waveOutGetVolume 检测主音量是否为零（近似静音检测）。
   * 更准确的方式是通过 CoreAudio API 的 IMMDevice 接口查询 mute 状态，
   * 但 waveOutGetVolume 更简单且跨 Windows 版本一致。
   */
  private async fetchSystemMuted(): Promise<boolean | null> {
    try {
      const script = `
        Add-Type -TypeDefinition @'
          using System.Runtime.InteropServices;
          public class AudioCheck {
            [DllImport("winmm.dll")]
            public static extern int waveOutGetVolume(System.IntPtr hwo, out uint dwVolume);
            public static bool IsMuted() {
              uint vol;
              int result = waveOutGetVolume(System.IntPtr.Zero, out vol);
              if (result != 0) return false;
              // waveOutGetVolume 返回左右声道各 16 位的值
              // 如果左右声道均为 0，视为静音
              uint left = vol & 0xFFFF;
              uint right = (vol >> 16) & 0xFFFF;
              return left == 0 && right == 0;
            }
          }
'@
        if ([AudioCheck]::IsMuted()) { Write-Output "true" } else { Write-Output "false" }
      `

      const result = await this.runPowerShell(script)
      const trimmed = result.trim().toLowerCase()

      if (trimmed === 'true') return true
      if (trimmed === 'false') return false
      return null
    } catch {
      return null
    }
  }

  /**
   * 执行 PowerShell 命令并返回 stdout。
   * 统一封装 exec 的 promisify 与超时。
   */
  private runPowerShell(script: string): Promise<string> {
    const { exec } = require('child_process')
    const { promisify } = require('util')
    const execAsync = promisify(exec)

    // 将多行脚本转为一行（PowerShell -Command 需要）
    const oneLiner = script
      .replace(/\r?\n/g, '; ')
      .replace(/"/g, '\\"')

    return execAsync(
      `powershell -NoProfile -NonInteractive -Command "${oneLiner}"`,
      { timeout: PS_TIMEOUT_MS, windowsHide: true },
    ).then((r: { stdout: string }) => r.stdout || '')
     .catch(() => '')
  }

  // ════════════════════════════════════════
  //  变化检测与通知
  // ════════════════════════════════════════

  /**
   * 检测信号是否发生变化并通知监听器。
   */
  private detectAndNotify(signals: EnvironmentSignals): void {
    const prev = this.lastSignals
    if (!prev) {
      this.lastSignals = signals
      return
    }

    const changed =
      prev.screenBrightness !== signals.screenBrightness ||
      prev.systemMuted !== signals.systemMuted

    if (changed) {
      this.lastSignals = signals
      log('DEBUG', 'piper_env_signals_changed', {
        brightness: signals.screenBrightness,
        muted: signals.systemMuted,
        hour: signals.currentHour,
      })
      for (const cb of this.changeCallbacks) {
        try {
          cb(signals)
        } catch {
          // 静默
        }
      }
    }
  }

  /**
   * 强制刷新缓存（供外部在需要时调用）。
   */
  forceRefresh(): void {
    this.lastCacheTime = 0
    this.collectAllSignals()
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例 */
export const piperTtsEnvironmentMonitor = new PiperTtsEnvironmentMonitor()
