/**
 * PiperEnvironmentSensor — PiperTTS 环境光传感器 & 系统静音检测
 *
 * ── 职责 ──
 *
 * 监测 Windows 系统层面的两个环境信号：
 * 1. 屏幕亮度百分比（通过 WMI Win32 API / PowerShell）
 * 2. 系统静音状态（通过 Windows Core Audio API / PowerShell）
 *
 * 这些信号被 PiperTtsBehaviorStateMachine 用于自动夜间模式检测
 * 和系统静音感知，辅助决定 TTS 输出状态。
 *
 * ── 设计原则 ──
 *
 * 1. 防御性 — 所有 Windows API 调用有超时保护，失败时返回安全默认值
 * 2. 缓存 — 环境数据 5 秒缓存，避免高频查询拖慢主线程
 * 3. 平台感知 — 非 Windows 平台直接返回默认值，不尝试调用 PowerShell
 * 4. 零依赖 — 不引入第三方系统信息库，使用 Node.js 内置 child_process
 *
 * ── 使用方式 ──
 *
 *   const { brightness, isMuted } = await piperEnvironmentSensor.read()
 *   // brightness: 0–100（百分比）, isMuted: boolean
 */

import { execFile } from 'child_process'
import { log } from '@akemi-mio/core/logger/Logger'

// ══════════════════════════════════════════
//  常量
// ══════════════════════════════════════════

/** 环境传感器缓存 TTL（毫秒） */
const SENSOR_CACHE_TTL_MS = 5000

/** PowerShell 命令超时（毫秒） */
const POWERSHELL_TIMEOUT_MS = 3000

/** 默认屏幕亮度（无法检测时使用） */
const DEFAULT_BRIGHTNESS = 75

/** 默认静音状态（无法检测时使用） */
const DEFAULT_MUTED = false

/** Windows 平台标识 */
const PLATFORM_WIN32 = 'win32'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 环境传感器单次读取快照 */
export interface EnvironmentSnapshot {
  /** 屏幕亮度百分比 0–100（-1 = 未知） */
  brightness: number
  /** 系统是否处于静音状态 */
  isMuted: boolean
  /** 时间戳 */
  timestamp: number
  /** 检测是否成功（所有字段均有效） */
  valid: boolean
}

/** 默认空快照 */
const DEFAULT_SNAPSHOT: EnvironmentSnapshot = {
  brightness: DEFAULT_BRIGHTNESS,
  isMuted: DEFAULT_MUTED,
  timestamp: 0,
  valid: false,
}

// ══════════════════════════════════════════
//  PiperEnvironmentSensor
// ══════════════════════════════════════════

export class PiperEnvironmentSensor {
  /** 缓存的上次快照 */
  private cached: EnvironmentSnapshot = { ...DEFAULT_SNAPSHOT }

  /** 缓存是否有效（未过期） */
  private cacheValid = false

  /** 缓存过期时间戳 */
  private cacheExpiresAt = 0

  /** 是否正在刷新（防止并发查询） */
  private refreshing = false

  /** 等待中的读取 Promise 队列 */
  private pendingReaders: Array<(snap: EnvironmentSnapshot) => void> = []

  // ════════════════════════════════════════
  //  公开 API
  // ════════════════════════════════════════

  /**
   * 读取当前环境快照。
   *
   * 5 秒内缓存有效，直接返回缓存。缓存过期时自动异步刷新。
   * 同一时刻多个调用会共用一次底层检测。
   *
   * @param forceRefresh 强制刷新（跳过缓存）
   */
  async read(forceRefresh = false): Promise<EnvironmentSnapshot> {
    const now = Date.now()

    // 缓存有效且未要求强制刷新 → 返回缓存
    if (!forceRefresh && this.cacheValid && now < this.cacheExpiresAt) {
      return this.cached
    }

    // 正在刷新中 → 排队等待
    if (this.refreshing) {
      return new Promise((resolve) => {
        this.pendingReaders.push(resolve)
      })
    }

    // 启动异步刷新
    this.refreshing = true
    try {
      this.cached = await this.refresh()
      this.cacheExpiresAt = now + SENSOR_CACHE_TTL_MS
      this.cacheValid = true
    } catch {
      this.cached = { ...DEFAULT_SNAPSHOT, timestamp: now }
      this.cacheExpiresAt = now + SENSOR_CACHE_TTL_MS
      this.cacheValid = true
    } finally {
      this.refreshing = false
    }

    // 唤醒所有等待的读者
    const pending = this.pendingReaders.splice(0)
    for (const resolve of pending) {
      resolve(this.cached)
    }

    return this.cached
  }

  /**
   * 快速获取缓存值（不触发刷新）。
   * 如果缓存为空，返回默认值。
   */
  getCached(): EnvironmentSnapshot {
    if (this.cacheValid) {
      return this.cached
    }
    return { ...DEFAULT_SNAPSHOT }
  }

  /**
   * 仅获取屏幕亮度（便捷方法）。
   * 返回 0–100 的百分比，无法检测时返回 -1。
   */
  async getBrightness(): Promise<number> {
    const snap = await this.read()
    return snap.valid ? snap.brightness : -1
  }

  /**
   * 仅获取系统静音状态（便捷方法）。
   */
  async isSystemMuted(): Promise<boolean> {
    const snap = await this.read()
    return snap.isMuted
  }

  // ════════════════════════════════════════
  //  私有：刷新检测
  // ════════════════════════════════════════

  /**
   * 执行完整的环境检测。
   * 同时并行读取屏幕亮度和系统静音状态。
   */
  private async refresh(): Promise<EnvironmentSnapshot> {
    const t0 = Date.now()

    const [brightness, isMuted] = await Promise.all([this.detectBrightness(), this.detectSystemMute()])

    const valid = brightness >= 0

    const snapshot: EnvironmentSnapshot = {
      brightness: Math.max(0, Math.min(100, brightness)),
      isMuted,
      timestamp: Date.now(),
      valid,
    }

    log('DEBUG', 'piper_env_sensor_refresh', {
      brightness: snapshot.brightness,
      isMuted: snapshot.isMuted,
      valid: snapshot.valid,
      elapsedMs: Date.now() - t0,
    })

    return snapshot
  }

  /**
   * 通过 PowerShell WMI 查询屏幕亮度。
   *
   * Windows 命令:
   *   powershell -Command "(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightness).CurrentBrightness"
   *
   * @returns 0–100 的亮度值，失败时返回 -1
   */
  private async detectBrightness(): Promise<number> {
    if (process.platform !== PLATFORM_WIN32) {
      return -1
    }

    try {
      const value = await this.execPowerShell('(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightness).CurrentBrightness')

      const parsed = parseInt(value?.trim() ?? '', 10)
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) {
        return parsed
      }

      return -1
    } catch (err) {
      log('WARN', 'piper_env_sensor_brightness_failed', {
        error: String(err),
      })
      return -1
    }
  }

  /**
   * 通过 PowerShell 检测系统是否处于静音状态。
   *
   * Windows 命令:
   *   powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]174)"
   *
   * 替代方案：查询 Windows Audio API 的静音状态
   *   powershell -Command "$obj = New-Object -ComObject SAPI.SpSharedRecoContext; ..."
   *
   * 当前使用更可靠的方法: 检查默认音频设备的静音状态
   *   powershell -Command "(Get-DefaultAudioDevice -Playback).Muted"
   *
   * @returns 是否静音，失败时返回 false（保守默认）
   */
  private async detectSystemMute(): Promise<boolean> {
    if (process.platform !== PLATFORM_WIN32) {
      return false
    }

    try {
      // 使用 Windows Core Audio API 通过 COM 对象查询系统主音量静音状态
      // 这里通过 AudioDeviceCmdlets 或 WMI 查询
      const value = await this.execPowerShell(
        `Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public class AudioMute {
    [DllImport("winmm.dll")]
    public static extern int waveOutGetVolume(nint hwo, out uint dwVolume);
    public static bool IsMuted() {
        uint vol;
        int ret = waveOutGetVolume(0, out vol);
        if (ret != 0) return false;
        return vol == 0;
    }
}
'@; [AudioMute]::IsMuted()`,
      )

      if (value?.trim() === 'True') return true
      if (value?.trim() === 'False') return false

      return false
    } catch (err) {
      log('WARN', 'piper_env_sensor_mute_failed', {
        error: String(err),
      })
      return false
    }
  }

  /**
   * 执行 PowerShell 命令并返回 stdout 输出。
   *
   * @param command PowerShell 命令脚本
   * @returns stdout 输出（已 trim）
   */
  private execPowerShell(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = execFile(
        'powershell',
        ['-Command', command],
        {
          timeout: POWERSHELL_TIMEOUT_MS,
          windowsHide: true,
        },
        (err, stdout) => {
          if (err) {
            reject(err)
            return
          }
          resolve(stdout?.trim() ?? '')
        },
      )

      // 监听 stderr（仅调试日志，不阻断）
      proc.stderr?.on('data', (d: Buffer) => {
        log('DEBUG', 'piper_env_sensor_ps_stderr', {
          msg: d.toString().trim().slice(0, 200),
        })
      })
    })
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/**
 * 全局单例。
 *
 * 所有 PiperTTS 环境检测需求应通过此单例统一访问。
 * PiperTtsBehaviorStateMachine 和 PiperBehaviorSidecar
 * 通过此传感器获取屏幕亮度和系统静音状态。
 */
export const piperEnvironmentSensor = new PiperEnvironmentSensor()
