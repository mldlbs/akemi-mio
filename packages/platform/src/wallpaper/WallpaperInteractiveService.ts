/**
 * WallpaperInteractiveService — 桌面壁纸交互模式服务
 *
 * 注册全局快捷键 CommandOrControl+Space 切换壁纸交互模式。
 * 交互模式下，壁纸 overlay 中的 Agent 输入面板激活，
 * 用户可直接在桌面上输入文字指令并查看实时反馈。
 *
 * 集成方式：
 * - 由 AppRuntime 在 Stage 7 惰性初始化
 * - 通过 IPC 推送 toggle 事件到渲染进程
 * - 交互模式状态持久化到 credentialsManager
 */

import { globalShortcut, BrowserWindow } from 'electron'
import { log } from '@akemi-mio/core/logger/Logger'
import { credentialsManager } from '@akemi-mio/core/credentials/CredentialsManager'

// =============================================================================
// 常量
// =============================================================================

/** 全局快捷键：切换壁纸交互模式 */
const TOGGLE_SHORTCUT = 'CommandOrControl+Space'

/** 持久化键名 */
const CONFIG_KEY_ENABLED = 'wp_interactive_enabled'
const CONFIG_KEY_SHORTCUT = 'wp_interactive_shortcut'

// =============================================================================
// 类型
// =============================================================================

export interface WallpaperInteractiveConfig {
  /** 功能是否启用 */
  enabled: boolean
  /** 当前绑定的快捷键 */
  shortcut: string
}

// =============================================================================
// 服务类
// =============================================================================

export class WallpaperInteractiveService {
  private windows: BrowserWindow[] = []
  private _registered = false
  private _enabled = false
  /** 当前实际注册的快捷键 */
  private _registeredShortcut = ''

  // ── 窗口注册 ──

  setWindow(win: BrowserWindow): void {
    if (!this.windows.includes(win)) {
      this.windows.push(win)
    }
  }

  removeWindow(win: BrowserWindow): void {
    this.windows = this.windows.filter((w) => w !== win)
  }

  // ── 配置 ──

  get enabled(): boolean {
    return this._enabled
  }

  getConfig(): WallpaperInteractiveConfig {
    const saved = credentialsManager.get(CONFIG_KEY_ENABLED)
    this._enabled = saved !== 'false'
    return {
      enabled: this._enabled,
      shortcut: credentialsManager.get(CONFIG_KEY_SHORTCUT) || TOGGLE_SHORTCUT,
    }
  }

  setConfig(config: Partial<WallpaperInteractiveConfig>): void {
    if (config.enabled !== undefined) {
      this._enabled = config.enabled
      credentialsManager.set(CONFIG_KEY_ENABLED, config.enabled ? 'true' : 'false')
    }
    if (config.shortcut) {
      credentialsManager.set(CONFIG_KEY_SHORTCUT, config.shortcut)
    }
    // 重新注册快捷键（使用存储的新值）
    this.unregisterShortcut()
    if (this._enabled) {
      this.registerShortcut()
    }
  }

  // ── 快捷键生命周期 ──

  /**
   * 启动服务：读取配置并注册快捷键
   */
  start(): void {
    this.getConfig()
    if (this._enabled) {
      this.registerShortcut()
    }
    log('INFO', 'wallpaper_interactive_started', {
      enabled: this._enabled,
      shortcut: this.getConfig().shortcut,
    })
  }

  /**
   * 停止服务：注销快捷键并清理
   */
  stop(): void {
    this.unregisterShortcut()
    this.windows = []
    log('INFO', 'wallpaper_interactive_stopped', {})
  }

  /**
   * 推送 toggle 事件到所有注册窗口
   */
  toggleInteractive(): boolean {
    const newState = !this._interactiveState
    this._interactiveState = newState
    this.broadcastToggle(newState)
    return newState
  }

  /**
   * 强制设置交互模式状态
   */
  setInteractiveState(active: boolean): void {
    this._interactiveState = active
    this.broadcastToggle(active)
  }

  // ── 内部状态 ──

  /** 当前交互模式的运行时状态（未持久化） */
  private _interactiveState = false

  // ── 私有方法 ──

  private registerShortcut(): void {
    if (this._registered) return

    const shortcut = credentialsManager.get(CONFIG_KEY_SHORTCUT) || TOGGLE_SHORTCUT
    try {
      const registered = globalShortcut.register(shortcut, () => {
        this.toggleInteractive()
      })
      if (registered) {
        this._registered = true
        this._registeredShortcut = shortcut
        log('INFO', 'wallpaper_interactive_shortcut_registered', { shortcut })
      } else {
        log('WARN', 'wallpaper_interactive_shortcut_failed', { shortcut })
      }
    } catch (err: any) {
      log('WARN', 'wallpaper_interactive_shortcut_error', {
        shortcut,
        error: err.message,
      })
    }
  }

  private unregisterShortcut(): void {
    if (!this._registered) return

    const shortcut = this._registeredShortcut
    try {
      globalShortcut.unregister(shortcut)
      this._registered = false
      this._registeredShortcut = ''
      log('INFO', 'wallpaper_interactive_shortcut_unregistered', { shortcut })
    } catch {
      this._registered = false
      this._registeredShortcut = ''
    }
  }

  private broadcastToggle(active: boolean): void {
    for (const win of this.windows) {
      if (win && !win.isDestroyed()) {
        win.webContents.send('wallpaper:interactive:toggle', { active })
      }
    }
  }
}
