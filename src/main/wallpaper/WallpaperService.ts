import { BrowserWindow } from 'electron'
import { watch, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { log } from '../logger/Logger'

// =============================================================================
// 壁纸模式检测
// =============================================================================

export function isWallpaperMode(): boolean {
  return !!process.env.WALLPAPER_ENGINE
}

// =============================================================================
// Wallpaper Engine 事件
// =============================================================================

export type WallpaperEvent = 'pause' | 'resume'

export type WallpaperListener = (event: WallpaperEvent) => void

export function onWallpaperEvent(listener: WallpaperListener): () => void {
  if (!isWallpaperMode()) return () => {}

  const handler = (msg: unknown) => {
    if (msg === 'pause' || msg === 'resume') listener(msg)
  }

  process.on('message', handler)
  return () => process.off('message', handler)
}

// =============================================================================
// 鼠标穿透 — 让桌面 overlay 窗口在无交互区域穿透点击
// =============================================================================

/**
 * 对指定窗口启用鼠标穿透。
 * 鼠标事件将穿透窗口传递到桌面，除非命中 .evolution-dashboard 区域。
 *
 * @param win 目标窗口
 * @param enabled 是否启用穿透
 */
export function setWindowMouseThrough(win: BrowserWindow | null, enabled: boolean): void {
  if (!win || win.isDestroyed()) return
  if (process.platform !== 'win32' && process.platform !== 'linux') return

  try {
    win.setIgnoreMouseEvents(enabled, { forward: true })
  } catch {
    // 某些 Electron 版本或平台可能不支持 forward 参数
    try {
      win.setIgnoreMouseEvents(enabled)
    } catch {
      // 静默失败
    }
  }
}

// =============================================================================
// 壁纸 CSS 热重载 — 监听文件变化并自动推送新样式到渲染进程
// =============================================================================

let cssWatcher: ReturnType<typeof watch> | null = null
let cssWatcherWins: BrowserWindow[] = []

/**
 * 开始监听壁纸 CSS 文件变化，变更时自动推送新样式到渲染进程。
 * 供进化系统修改 CSS 后即时生效。
 *
 * @param projectRoot 项目根目录
 * @param windows 接收样式更新的窗口列表
 */
export function startWallpaperCssWatcher(projectRoot: string, windows: BrowserWindow[]): void {
  stopWallpaperCssWatcher()

  const cssDir = join(projectRoot, 'src', 'renderer', 'src', 'styles')
  const targetFiles = ['wallpaper.css', 'wallpaper-evolution.css']

  if (!existsSync(cssDir)) {
    log('WARN', 'wallpaper_css_watcher_dir_missing', { dir: cssDir })
    return
  }

  cssWatcherWins = windows

  try {
    cssWatcher = watch(cssDir, (eventType, filename) => {
      if (!filename) return
      if (!targetFiles.includes(filename)) return
      if (eventType !== 'change') return

      const filePath = join(cssDir, filename)
      if (!existsSync(filePath)) return

      try {
        const css = readFileSync(filePath, 'utf-8')
        // 推送新样式到所有目标窗口
        for (const win of cssWatcherWins) {
          if (win && !win.isDestroyed()) {
            win.webContents.send('wallpaper:styles-updated', css, filename)
          }
        }
        log('INFO', 'wallpaper_css_hot_reloaded', { filename, size: css.length })
      } catch (err: any) {
        log('WARN', 'wallpaper_css_watcher_reload_failed', { filename, error: err.message })
      }
    })

    log('INFO', 'wallpaper_css_watcher_started', { dir: cssDir, files: targetFiles })
  } catch (err: any) {
    log('WARN', 'wallpaper_css_watcher_start_failed', { error: err.message })
  }
}

/**
 * 停止壁纸 CSS 文件监听
 */
export function stopWallpaperCssWatcher(): void {
  if (cssWatcher) {
    cssWatcher.close()
    cssWatcher = null
  }
  cssWatcherWins = []
}

// =============================================================================
// Re-export dashboard service
// =============================================================================

export { EvolutionDashboardService, type EvolutionDashboardState } from './EvolutionDashboardService'

// =============================================================================
// Re-export memory context service
// =============================================================================

export { MemoryContextService, type MemoryCardItem, type MemoryContextPayload, type MemoryContextConfig, type MemoryContextDisplayType } from './MemoryContextService'

// =============================================================================
// Re-export conversation context service
// =============================================================================

export { ConversationContextService, type ConversationTaskItem, type ConversationContextPayload, type ConversationContextConfig } from './ConversationContextService'

// =============================================================================
// Re-export file organizer progress service
// =============================================================================

export { FileOrganizerProgressService, type OrganizerProgressPayload, type FileMoveEvent, type FileMoveResult, type FileMoveStatus, type SessionStatus } from './FileOrganizerProgressService'

// =============================================================================
// Re-export wallpaper plugin system
// =============================================================================

export { WallpaperPluginRegistry, UserBehaviorPluginAdapter } from './plugin'
export type {
  IWallpaperPlugin,
  IBehaviorProvider,
  WallpaperPluginManifest,
  WallpaperPluginCapability,
  WallpaperBehaviorSnapshot,
} from './plugin'
