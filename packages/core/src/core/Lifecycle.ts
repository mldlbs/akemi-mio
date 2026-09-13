import { app, BrowserWindow, globalShortcut, screen, session } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { cpus, totalmem, freemem } from 'os'
import { log } from '@akemi-mio/core/logger/Logger'
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
              "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net/npm/remixicon@4/ https://fonts.googleapis.com; " +
              "font-src 'self' https://cdn.jsdelivr.net/npm/remixicon@4/ https://fonts.gstatic.com; " +
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
    mainWindow?.on('responsive', onResponsive)
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
      mainWindow?.webContents.openDevTools()
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

export interface WallpaperDeps {
  isWallpaperMode: () => boolean
  onWallpaperEvent: (cb: (event: string) => void) => void
}

// ════════════════════════════════════════════════════════════════
// 多形态窗口（Multi-form windows）
//
// 设计要点 —— 为什么是"每形态一个常驻窗口"而不是"一个窗口切属性"：
//
// transparent / frame / alwaysOnTop 这些 BrowserWindow 标志一经创建即不可变更
// （Electron 官方限制，改 transparent 必须重建窗口）。若三形态共用一个窗口，
// 从壁纸（不透明、全屏、置底）切到宠物（透明、小窗、置顶）时必然要销毁重建，
// 重建期间会黑屏闪一下，且丢失渲染进程状态。
//
// 因此这里为每个形态维护一个独立的、懒创建的窗口，切换 = 显隐 + 焦点，
// 没有任何重建开销，形态间的状态也各自保留。
// ════════════════════════════════════════════════════════════════

/** 形态标识。与 src/renderer/src/forms/types.ts 的 FormKind 保持同步。 */
export type FormKind = 'pet' | 'chat' | 'wallpaper'

// ════════════════════════════════════════════════════════════════
// 形态窗口位置持久化
//
// 用户把宠物拖到屏幕右下角，重启后它应该还在那儿 —— 否则每次开机都要重新摆一次，
// 这是桌面宠物最基本的体贴。
//
// 只持久化 pet 与 chat：壁纸铺满整屏，位置无意义。
// 存一个独立小文件而非塞进 StateManager（后者是纯内存态）、也不塞进主配置
// （位置是高频变动的小数据，混进大配置会引发无谓的整体重写）。
// ════════════════════════════════════════════════════════════════

interface StoredBounds {
  x: number
  y: number
  width?: number
  height?: number
}

const FORMS_STATE_FILE = 'forms-window-state.json'

function formsStatePath(): string {
  // 与 packages/core/src/config 的 WORKSPACE_ROOT 约定一致：userData 目录。
  // 这里不 import config 模块以避免循环依赖（config 不依赖 Lifecycle，但
  // Lifecycle 被 config 的消费者间接引用），故自行解析同一路径。
  try {
    const base = process.env.USER_DATA_DIR || app.getPath('userData')
    return join(base, FORMS_STATE_FILE)
  } catch {
    return join(app.getAppPath(), FORMS_STATE_FILE)
  }
}

function readFormsState(): Record<string, StoredBounds> {
  try {
    const p = formsStatePath()
    if (!existsSync(p)) return {}
    const raw = readFileSync(p, 'utf-8')
    // Windows 编辑器可能写入 BOM，JSON.parse 会直接抛 —— 与项目其它读 JSON 处保持一致容错
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (err) {
    log('WARN', 'forms_state_read_failed', { error: String(err) })
    return {}
  }
}

function writeFormsState(state: Record<string, StoredBounds>): void {
  try {
    writeFileSync(formsStatePath(), JSON.stringify(state, null, 2), 'utf-8')
  } catch (err) {
    log('WARN', 'forms_state_write_failed', { error: String(err) })
  }
}

/**
 * 校验存储的位置在当前显示器拓扑下是否仍然可见。
 *
 * 必要性：用户可能拔掉了外接显示器，而持久化的坐标落在已不存在的屏幕上。
 * 不做校验的话，窗口会被恢复到屏幕外 —— 表现为"应用启动了但看不见"，
 * 用户完全无从自救。
 */
function isBoundsVisible(b: StoredBounds, width: number, height: number): boolean {
  if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) return false
  // 至少要有一个显示器与窗口矩形有足够的交集（保留 80x40 的可见抓手）
  const MIN_VISIBLE_W = 80
  const MIN_VISIBLE_H = 40
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea
    const overlapW = Math.min(b.x + width, a.x + a.width) - Math.max(b.x, a.x)
    const overlapH = Math.min(b.y + height, a.y + a.height) - Math.max(b.y, a.y)
    return overlapW >= MIN_VISIBLE_W && overlapH >= MIN_VISIBLE_H
  })
}

/** 保存某形态窗口的位置（仅在窗口可见且非壁纸时）。 */
export function saveFormBounds(kind: FormKind): void {
  if (kind === 'wallpaper') return
  const win = getFormWindow(kind)
  if (!win || win.isDestroyed()) return
  if (win.isMinimized() || !win.isVisible()) return
  const b = win.getBounds()
  const state = readFormsState()
  state[kind] = { x: b.x, y: b.y, width: b.width, height: b.height }
  writeFormsState(state)
}

/** 恢复位置到窗口上（越界则丢弃，用默认位置）。 */
function restoreFormBounds(kind: FormKind, win: BrowserWindow, spec: FormWindowSpec): void {
  if (kind === 'wallpaper') return
  const stored = readFormsState()[kind]
  if (!stored) return

  const width = spec.size.width
  const height = spec.size.height
  if (!isBoundsVisible(stored, width, height)) {
    log('INFO', 'form_bounds_discarded', { kind, stored })
    return
  }
  win.setBounds({ x: stored.x, y: stored.y, width, height })
}


/**
 * 形态窗口参数表。
 *
 * 该表是主进程侧的唯一真相源；渲染进程的 FORM_REGISTRY 负责视觉与元数据描述，
 * 两边在 htmlFile / 尺寸上必须一致。之所以不跨进程共享同一份常量：
 * packages/core 不能 import src/renderer（构建图上反向），而 src/renderer 被
 * sandbox 隔离也不能 require 主进程包，所以只能各留一份并靠注释互相锚定。
 */
interface FormWindowSpec {
  htmlFile: string
  size: { width: number; height: number }
  minSize?: { width: number; height: number }
  frame: boolean
  transparent: boolean
  alwaysOnTop: boolean
  alwaysOnTopLevel?: 'floating' | 'screen-saver'
  skipTaskbar: boolean
  resizable: boolean
  /** 是否铺满主显示器全屏（壁纸形态） */
  fullscreen: boolean
  /** 是否让鼠标事件穿透到下层（壁纸形态必须开启） */
  ignoreMouseEvents: boolean
  /** 是否可聚焦。壁纸形态不可聚焦，避免点桌面时抢走焦点。 */
  focusable: boolean
}

const FORM_SPECS: Record<FormKind, FormWindowSpec> = {
  pet: {
    htmlFile: 'pet.html',
    size: { width: 160, height: 200 },
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    alwaysOnTopLevel: 'floating',
    skipTaskbar: true,
    resizable: false,
    fullscreen: false,
    ignoreMouseEvents: false,
    focusable: true,
  },
  chat: {
    htmlFile: 'chat.html',
    size: { width: 420, height: 560 },
    minSize: { width: 320, height: 360 },
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    alwaysOnTopLevel: 'floating',
    skipTaskbar: false,
    resizable: true,
    fullscreen: false,
    ignoreMouseEvents: false,
    focusable: true,
  },
  wallpaper: {
    htmlFile: 'wallpaper.html',
    size: { width: 0, height: 0 }, // 实际尺寸取主显示器工作区
    frame: false,
    transparent: true,
    alwaysOnTop: false,
    skipTaskbar: true,
    resizable: false,
    fullscreen: true,
    ignoreMouseEvents: true,
    focusable: false,
  },
}

const formWindows = new Map<FormKind, BrowserWindow>()

/** 渲染进程构建产物的目录。主进程打包后为 out/main，renderer 在 ../renderer。 */
function rendererBase(): string {
  return join(__dirname, '../renderer')
}

/**
 * 把一个形态窗口挂到目标显示器。壁纸形态要覆盖**整块屏幕**，
 * 包含任务栏区域，所以用 display.bounds 而非 workArea —— 否则任务栏那条会露出来。
 */
function applyWallpaperBounds(win: BrowserWindow): void {
  const display = screen.getPrimaryDisplay()
  win.setBounds(display.bounds)
}

/**
 * 创建（或复用）某形态的窗口。
 *
 * 幂等：已存在且未销毁则直接返回，不重复创建。
 * 默认不显示 —— 由 showForm / toggleForm 决定何时露面，
 * 避免应用启动瞬间所有形态窗口一起闪出来。
 */
export function createFormWindow(kind: FormKind): BrowserWindow {
  const existing = formWindows.get(kind)
  if (existing && !existing.isDestroyed()) return existing

  const spec = FORM_SPECS[kind]

  const win = new BrowserWindow({
    width: spec.size.width || undefined,
    height: spec.size.height || undefined,
    minWidth: spec.minSize?.width,
    minHeight: spec.minSize?.height,
    frame: spec.frame,
    transparent: spec.transparent,
    // 透明窗口必须给全透明底色，否则会渲染成黑色方块
    backgroundColor: spec.transparent ? '#00000000' : undefined,
    hasShadow: false,
    resizable: spec.resizable,
    skipTaskbar: spec.skipTaskbar,
    fullscreenable: false,
    focusable: spec.focusable,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // 壁纸与宠物是长时间常驻画面，禁用后台节流否则动画会卡住
      backgroundThrottling: false,
    },
  })

  if (spec.alwaysOnTop) {
    // level 影响压在其他窗口之上的强度，'floating' 足以盖住普通窗口但不盖全屏应用
    win.setAlwaysOnTop(true, spec.alwaysOnTopLevel)
  }

  if (kind === 'wallpaper') {
    applyWallpaperBounds(win)
    // 壁纸层必须让鼠标事件穿到下面的桌面图标与其他窗口，
    // 否则铺满全屏的窗口会把整个桌面"锁住"。
    win.setIgnoreMouseEvents(true, { forward: true })
    // 全屏壁纸不应出现在 Alt+Tab 与窗口列表里
    win.setSkipTaskbar(true)
  } else {
    // 宠物/对话框：恢复上次的位置（越界自动丢弃）
    restoreFormBounds(kind, win, spec)
  }

  win.setTitle(kind === 'wallpaper' ? ' ' : `Akemi Mio — ${kind}`)

  // 加载页面：dev 走 vite devserver，prod 走构建产物。
  // devserver 的 URL 形如 http://localhost:5173/，需拼接 htmlFile。
  if (process.env.ELECTRON_RENDERER_URL) {
    const base = process.env.ELECTRON_RENDERER_URL.replace(/index\.html$/, '')
    win.loadURL(`${base}${spec.htmlFile}`)
  } else {
    const filePath = join(rendererBase(), spec.htmlFile)
    if (!existsSync(filePath)) {
      // 明确报错而非静默空白：漏注册 vite input 时就是这个症状
      log('ERROR', 'form_html_missing', { kind, filePath })
    }
    win.loadFile(filePath)
  }

  // 壁纸形态跟随显示器变化重铺，否则插拔外接屏后会留黑边
  if (kind === 'wallpaper') {
    const onDisplayChange = () => {
      if (!win.isDestroyed()) applyWallpaperBounds(win)
    }
    screen.on('display-metrics-changed', onDisplayChange)
    screen.on('display-added', onDisplayChange)
    screen.on('display-removed', onDisplayChange)
    win.on('closed', () => {
      screen.removeListener('display-metrics-changed', onDisplayChange)
      screen.removeListener('display-added', onDisplayChange)
      screen.removeListener('display-removed', onDisplayChange)
    })
  } else {
    // 拖动结束后保存位置。
    // 'moved' 在拖动过程中会高频触发（每帧一次），因此用 500ms 防抖 ——
    // 否则拖一下宠物会写出上百次磁盘 IO。
    let moveTimer: ReturnType<typeof setTimeout> | null = null
    const persist = () => {
      if (moveTimer) clearTimeout(moveTimer)
      moveTimer = setTimeout(() => {
        moveTimer = null
        saveFormBounds(kind)
      }, 500)
    }
    win.on('moved', persist)
    win.on('resized', persist)
    win.on('close', () => {
      // 关闭前立刻落盘，不等防抖（此时窗口可能马上就没了）
      if (moveTimer) clearTimeout(moveTimer)
      saveFormBounds(kind)
    })
  }

  win.on('closed', () => {
    formWindows.delete(kind)
  })

  formWindows.set(kind, win)
  log('INFO', 'form_window_created', { kind, transparent: spec.transparent })
  return win
}

/** 取某形态窗口（可能为 null，表示尚未创建）。 */
export function getFormWindow(kind: FormKind): BrowserWindow | null {
  const win = formWindows.get(kind)
  return win && !win.isDestroyed() ? win : null
}

/** 显示某形态窗口（按需创建）。壁纸形态显示时压到最底层并重新铺满。 */
export function showForm(kind: FormKind, focus = true): BrowserWindow {
  const win = createFormWindow(kind)
  if (kind === 'wallpaper') {
    applyWallpaperBounds(win)
    win.showInactive() // 不抢焦点，否则用户正在输入的窗口会被打断
    win.setAlwaysOnTop(false)
  } else {
    win.show()
    if (focus) win.focus()
  }
  return win
}

/** 隐藏某形态窗口。 */
export function hideForm(kind: FormKind): void {
  const win = getFormWindow(kind)
  if (win) win.hide()
}

/** 某形态是否可见。 */
export function isFormVisible(kind: FormKind): boolean {
  const win = getFormWindow(kind)
  return !!win && win.isVisible()
}

/** 切换某形态显隐，返回切换后的可见状态。 */
export function toggleForm(kind: FormKind): boolean {
  if (isFormVisible(kind)) {
    hideForm(kind)
    return false
  }
  showForm(kind)
  return true
}

/**
 * 关闭全部形态窗口。
 * 应用退出/重载前调用，避免残留的置顶小窗变成"关不掉的幽灵"。
 */
export function closeAllFormWindows(): void {
  for (const [kind, win] of formWindows) {
    if (!win.isDestroyed()) {
      try {
        win.destroy()
      } catch (err) {
        log('WARN', 'form_window_destroy_failed', { kind, error: String(err) })
      }
    }
  }
  formWindows.clear()
}

/** 向所有形态窗口广播一条消息（发送方可按 from 自行忽略）。 */
export function broadcastToForms(from: FormKind, type: string, payload: unknown): void {
  for (const [kind, win] of formWindows) {
    if (kind === from) continue
    if (win.isDestroyed()) continue
    try {
      win.webContents.send('forms:broadcast', { from, type, payload })
    } catch (err) {
      log('WARN', 'form_broadcast_failed', { from, to: kind, type, error: String(err) })
    }
  }
}

// ════════════════════════════════════════════════════════════════
// 形态快捷键
//
// 键位选择依据 —— 先查清已被占用的组合，再挑不冲突的：
//   CommandOrControl+Space          → 主壳窗口显隐（WallpaperInteractiveService）
//   CommandOrControl+Shift+V        → 语音便签（VoiceNoteService）
// 因此这里统一用 CommandOrControl+Shift+<字母> 家族，只取 P / L / W：
//   P = Pet（宠物小人）  L = chat box（对话框）  W = Wallpaper（壁纸）
// 用 Shift+<字母> 而非裸字母，避免抢占任意应用里的常用单键（如 Ctrl+P 打印）。
// ════════════════════════════════════════════════════════════════

const FORM_SHORTCUTS: Record<FormKind, string> = {
  pet: 'CommandOrControl+Shift+P',
  chat: 'CommandOrControl+Shift+L',
  wallpaper: 'CommandOrControl+Shift+W',
}

let formShortcutsRegistered = false

/** 注册形态切换快捷键。可重复调用，幂等。 */
export function registerFormShortcuts(): void {
  if (formShortcutsRegistered) return

  let anyOk = false
  for (const kind of Object.keys(FORM_SHORTCUTS) as FormKind[]) {
    const accelerator = FORM_SHORTCUTS[kind]
    try {
      // globalShortcut.register 在组合已被其它程序占用时返回 false 而非抛错，
      // 因此必须检查返回值 —— 否则会误以为注册成功。
      const ok = globalShortcut.register(accelerator, () => {
        try {
          toggleForm(kind)
        } catch (err) {
          log('WARN', 'form_shortcut_toggle_failed', { kind, error: String(err) })
        }
      })
      if (ok) {
        anyOk = true
        log('INFO', 'form_shortcut_registered', { kind, accelerator })
      } else {
        log('WARN', 'form_shortcut_occupied', { kind, accelerator })
      }
    } catch (err) {
      log('WARN', 'form_shortcut_register_error', { kind, accelerator, error: String(err) })
    }
  }
  formShortcutsRegistered = anyOk
}

/** 注销形态快捷键。应用退出前调用。 */
export function unregisterFormShortcuts(): void {
  if (!formShortcutsRegistered) return
  for (const accelerator of Object.values(FORM_SHORTCUTS)) {
    try {
      globalShortcut.unregister(accelerator)
    } catch {
      /* 静默：注销失败不应阻断退出流程 */
    }
  }
  formShortcutsRegistered = false
}

/** 查询某形态的快捷键（用于设置界面展示）。 */
export function getFormShortcut(kind: FormKind): string {
  return FORM_SHORTCUTS[kind]
}

export function setupWallpaperListener(stateManager: StateManager, deps: WallpaperDeps): void {
  if (deps.isWallpaperMode()) {
    try {
      deps.onWallpaperEvent((event) => {
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
