/**
 * AppWindowPolling — 前台窗口轮询模块
 *
 * ── 职责 ──
 * 独立的 Windows 前台窗口标题轮询服务，从 UserBehaviorService 中提取。
 * 通过 PowerShell 调用 user32.dll 获取活动窗口标题。
 *
 * ── 设计 ──
 * - 纯解耦：不依赖 UserBehaviorService 内部状态
 * - 回调驱动：通过 onUpdate 回调通知窗口变更
 * - 平台约束：仅在 Windows 上启用 (process.platform !== 'win32' 时静默)
 *
 * ── 独立性 ──
 * ⭐⭐⭐⭐⭐ 最高独立度，可在 UserBehaviorService 外部独立测试和使用
 */

import { log } from '@akemi-mio/core/logger/Logger'

// =============================================================================
// 类型定义
// =============================================================================

/** 应用类别 — 通过窗口标题启发式判断 */
export type AppCategory = 'code' | 'browser' | 'media' | 'communication' | 'other'

/** 窗口更新回调 */
export type WindowUpdateCallback = (title: string, category: AppCategory) => void

// =============================================================================
// 应用类别检测（通过窗口标题关键词匹配）
// =============================================================================

const CODE_PATTERNS = [
  /code|vs ?code|visual\s*studio|editor|ide|vim|neovim|jetbrains|intellij|pycharm|webstorm|sublime|atom/i,
  /\.(ts|js|tsx|jsx|py|go|rs|java|cpp|c|h|cs|vue|svelte|md)\b/i,
]
const BROWSER_PATTERNS = [/chrome|firefox|edge|safari|opera|brave|browser/i]
const MEDIA_PATTERNS = [/music|spotify|player|video|youtube|bilibili|netflix|hbo|disney\+|media\s*player/i]
const COMM_PATTERNS = [/wechat|微信|telegram|discord|slack|teams|skype|zoom|meeting|chat/i]

/**
 * 根据窗口标题检测应用类别。
 * 纯函数，无副作用。
 */
export function detectAppCategory(title: string): AppCategory {
  const lower = title
  if (COMM_PATTERNS.some((p) => p.test(lower))) return 'communication'
  if (CODE_PATTERNS.some((p) => p.test(lower))) return 'code'
  if (BROWSER_PATTERNS.some((p) => p.test(lower))) return 'browser'
  if (MEDIA_PATTERNS.some((p) => p.test(lower))) return 'media'
  return 'other'
}

// =============================================================================
// AppWindowPolling
// =============================================================================

export interface AppWindowPollingOptions {
  /** 轮询间隔 ms，默认 5000 */
  pollIntervalMs?: number
  /**
   * 可选：是否应执行本轮轮询的检查函数。
   * 返回 false 时跳过本次轮询。用于在特定条件下（如窗口聚焦时）暂停轮询。
   * 例如: `() => !this.state.focused`
   */
  shouldPoll?: () => boolean
}

/**
 * AppWindowPolling — 前台窗口轮询服务
 *
 * 在 Windows 上通过 PowerShell 定期获取活动窗口标题，
 * 检测应用类别，并通过回调通知使用者。
 *
 * 使用示例:
 * ```ts
 * const polling = new AppWindowPolling()
 * polling.start((title, category) => {
 *   console.log(`当前窗口: ${title} (${category})`)
 * })
 * // ... later
 * polling.stop()
 * ```
 */
export class AppWindowPolling {
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private lastWindowTitle: string = ''
  private onUpdate: WindowUpdateCallback | null = null
  private readonly pollIntervalMs: number
  private readonly shouldPoll: (() => boolean) | null = null

  constructor(options?: AppWindowPollingOptions) {
    this.pollIntervalMs = options?.pollIntervalMs ?? 5000
    this.shouldPoll = options?.shouldPoll ?? null
  }

  // ==================== 生命周期 ====================

  /**
   * 开始轮询。
   * 仅在 Windows 上实际启用；非 Windows 平台静默不操作。
   *
   * @param onUpdate 窗口标题变化时的回调
   */
  start(onUpdate: WindowUpdateCallback): void {
    this.onUpdate = onUpdate

    // 仅在 Windows 上启用前台应用检测
    if (process.platform !== 'win32') {
      log('INFO', 'app_window_polling_skipped', { platform: process.platform, reason: '仅支持 Windows' })
      return
    }

    if (this.pollTimer) {
      log('WARN', 'app_window_polling_already_started')
      return
    }

    this.pollTimer = setInterval(() => {
      // 如果设定了 shouldPoll 检查且返回 false，跳过本轮轮询
      if (this.shouldPoll && !this.shouldPoll()) return
      this.pollForegroundWindow()
    }, this.pollIntervalMs)

    log('INFO', 'app_window_polling_started', { intervalMs: this.pollIntervalMs })
  }

  /** 停止轮询 */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.onUpdate = null
    log('INFO', 'app_window_polling_stopped')
  }

  /** 获取最后识别的窗口标题 */
  getLastWindowTitle(): string {
    return this.lastWindowTitle
  }

  /** 当前是否在轮询中 */
  isPolling(): boolean {
    return this.pollTimer !== null
  }

  // ==================== 内部方法 ====================

  private async pollForegroundWindow(): Promise<void> {
    try {
      const title = await this.getForegroundWindowTitle()
      if (title && title !== this.lastWindowTitle) {
        this.lastWindowTitle = title
        const category = detectAppCategory(title)
        this.onUpdate?.(title, category)
      }
    } catch {
      // 静默失败 — 前台检测是辅助功能
    }
  }

  /**
   * 通过 PowerShell 获取当前前台窗口标题。
   * 使用 Add-Type 编译一行 C# 代码调用 user32.dll。
   */
  private async getForegroundWindowTitle(): Promise<string> {
    const { exec } = require('child_process')
    const { promisify } = require('util')
    const execAsync = promisify(exec)

    const script = `
      Add-Type @'
        using System;
        using System.Runtime.InteropServices;
        using System.Text;
        public class ForegroundWin {
          [DllImport("user32.dll")]
          public static extern IntPtr GetForegroundWindow();
          [DllImport("user32.dll")]
          public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
          public static string GetTitle() {
            IntPtr hWnd = GetForegroundWindow();
            StringBuilder sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            return sb.ToString();
          }
        }
'@
      [ForegroundWin]::GetTitle()
    `

    try {
      const { stdout } = await execAsync(
        `powershell -NoProfile -NonInteractive -Command "${script.replace(/"/g, '\\"').replace(/\n/g, '; ')}"`,
        { timeout: 2000, windowsHide: true },
      )
      return (stdout || '').trim()
    } catch {
      return ''
    }
  }
}
