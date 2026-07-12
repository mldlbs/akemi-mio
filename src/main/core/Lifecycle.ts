import { app, BrowserWindow, session } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { cpus, totalmem, freemem } from 'os'
import { log } from '../logger/Logger'
import { isWallpaperMode, onWallpaperEvent } from '../wallpaper/WallpaperService'
import { StateManager } from './StateManager'
import { detectGpu } from './GpuDetector'
import { eventBus } from './EventBus'
import { disableNCRendering } from './dwm'

let mainWindow: BrowserWindow | null = null
/** 全局清理函数集，在窗口销毁或应用退出时调用 */
let globalDisposers: (() => void)[] = []

export function addGlobalDisposer(fn: () => void): void {
  globalDisposers.push(fn)
}

export function runGlobalDisposers(): void {
  for (const fn of globalDisposers) {
    try {
      fn()
    } catch {}
  }
  globalDisposers = []
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function setMainWindow(w: BrowserWindow | null): void {
  mainWindow = w
}

export function createWindow(stateManager: StateManager): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 680,
    minWidth: 800,
    minHeight: 500,
    icon: existsSync(join(process.resourcesPath || '', 'icon.png'))
      ? join(process.resourcesPath || '', 'icon.png')
      : join(app.getAppPath(), 'icon.png'),
    frame: false,
    transparent: false,
    backgroundColor: '#f5f0eb',
    hasShadow: true,
    resizable: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    fullscreenable: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  })

  // ===== Content-Security-Policy =====
  // 开发模式: 宽松（Vite HMR 需要 inline script + websocket）
  // 生产模式: 严格，仅允许 self + remixicon CDN
  const isDev = !!process.env.ELECTRON_RENDERER_URL
  if (isDev) {
    // dev: Vite HMR 需要 'unsafe-inline' 和 connect-src 包含 ws://
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; " +
              "script-src 'self' 'unsafe-inline'; " +
              "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net/npm/remixicon@4/ https://fonts.googleapis.com; " +
              "font-src 'self' https://cdn.jsdelivr.net/npm/remixicon@4/ https://fonts.gstatic.com; " +
              "img-src 'self' data: blob:; " +
              "media-src 'self' blob:; " +
              "connect-src 'self' ws: http://localhost:*; " +
              "frame-ancestors 'none'",
          ],
        },
      })
    })
  } else {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; " +
              "script-src 'self'; " +
              "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net/npm/remixicon@4/; " +
              "font-src 'self' https://cdn.jsdelivr.net/npm/remixicon@4/; " +
              "img-src 'self' data: blob:; " +
              "media-src 'self' blob:; " +
              "connect-src 'self'; " +
              "frame-ancestors 'none'",
          ],
        },
      })
    })
  }

  mainWindow.setTitle(' ')

  // Mica 效果（Windows 11 原生背景模糊，代替 transparent: true 的 CPU 软件渲染）
  if (process.platform === 'win32') {
    try {
      if (mainWindow.setBackgroundMaterial) {
        mainWindow.setBackgroundMaterial('mica')
      }
    } catch {}
  }

  mainWindow.on('enter-full-screen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setFullScreen(false)
    }
  })

  stateManager.setPushToRenderer((state) => {
    mainWindow?.webContents.send('state:update', state)
  })

  // 渲染进程崩溃/无响应处理 — 同时清理资源
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log('ERROR', 'renderer_crashed', { reason: details.reason })
    runGlobalDisposers()
    app.relaunch()
    app.exit(0)
  })
  mainWindow.on('unresponsive', () => {
    log('WARN', 'renderer_unresponsive', {})
    let responded = false
    const onResponsive = () => {
      responded = true
      mainWindow?.removeListener('responsive', onResponsive)
      log('INFO', 'renderer_responsive_recovered', {})
    }
    mainWindow.on('responsive', onResponsive)
    setTimeout(() => {
      mainWindow?.removeListener('responsive', onResponsive)
      if (responded) return
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.isCrashed()) {
        log('ERROR', 'renderer_force_reload', {})
        runGlobalDisposers()
        app.relaunch()
        app.exit(0)
      } else if (!responded) {
        // 窗口未恢复也未崩溃 → 尝试 reload（不重启整个应用）
        log('WARN', 'renderer_still_unresponsive_after_timeout', {})
        try {
          mainWindow?.webContents.reload()
        } catch {}
      }
    }, 10000)
  })

  // 窗口关闭时清理
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.on('close', () => {
    // 窗口关闭时释放所有订阅，但保留服务（可能会在后台运行）
    log('INFO', 'window_close_dispose', { listeners: Object.keys(eventBus.getStats()) })
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.openDevTools()
    })
  }

  return mainWindow
}

/** 独立窗口：Agent 面板 */
let agentWindow: BrowserWindow | null = null

export function getAgentWindow(): BrowserWindow | null {
  return agentWindow
}

export function createAgentWindow(): BrowserWindow {
  if (agentWindow && !agentWindow.isDestroyed()) {
    agentWindow.focus()
    return agentWindow
  }

  agentWindow = new BrowserWindow({
    width: 480,
    height: 580,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    skipTaskbar: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  })

  agentWindow.setTitle('Agent — Akemi Mio')

  if (process.env.ELECTRON_RENDERER_URL) {
    agentWindow.loadURL(process.env.ELECTRON_RENDERER_URL.replace('index.html', 'agent.html'))
    // agentWindow.webContents.openDevTools()
  } else {
    agentWindow.loadFile(join(__dirname, '../renderer/agent.html'))
  }

  agentWindow.on('closed', () => {
    agentWindow = null
  })

  return agentWindow
}

export function closeAgentWindow(): void {
  if (agentWindow && !agentWindow.isDestroyed()) {
    agentWindow.close()
  }
}

export function setupStartupLogging(): void {
  log('INFO', 'startup', {
    project: 'akemi-mio',
    version: '1.0.0',
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
  })

  const cpuInfo = cpus()
  log('INFO', 'system_info', {
    cpu: cpuInfo[0]?.model?.trim() || 'unknown',
    cores: cpuInfo.length,
    memory_gb: parseFloat((totalmem() / 1024 ** 3).toFixed(1)),
    free_memory_gb: parseFloat((freemem() / 1024 ** 3).toFixed(1)),
  })

  detectGpu()
}

export function setupWallpaperListener(stateManager: StateManager): void {
  if (isWallpaperMode()) {
    try {
      onWallpaperEvent((event) => {
        try {
          if (event === 'pause') {
            const win = getMainWindow()
            win?.webContents.send('state:update', { recording: false })
          } else if (event === 'resume') {
            const win = getMainWindow()
            win?.webContents.send('state:update', { asr: 'ready' })
          }
        } catch (err) {
          log('WARN', 'wallpaper_event_handler_error', { error: String(err), event })
        }
      })
    } catch (err) {
      log('WARN', 'wallpaper_setup_error', { error: String(err) })
    }
  }
}
