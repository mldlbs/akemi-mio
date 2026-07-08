import { BrowserWindow } from 'electron'

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
// Re-export dashboard service
// =============================================================================

export { EvolutionDashboardService, type EvolutionDashboardState } from './EvolutionDashboardService'
