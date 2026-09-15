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

  // 把发往本窗口的 agent 事件镜像给形态窗口。
  // 挂在这里而不是 AppRuntime 的启动流程里，是因为主窗口**可能被重建**
  // （window-all-closed 后 activate 会再 createWindow 一次）；
  // 若挂在外部，重建后的新窗口不会被镜像，宠物会静默失去真实对话流。
  attachAgentEventMirrorFor(mainWindow)

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    if (devToolsEnabled()) mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    mainWindow.webContents.once('did-finish-load', () => {
      if (devToolsEnabled()) mainWindow?.webContents.openDevTools()
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

/**
 * 是否打开 DevTools 窗口。
 *
 * 曾经在 loadFile 分支（也就是**打包版**走的那条）里无条件 openDevTools()，
 * 结果每个正式版用户一启动就会多弹一个 DevTools 窗口。现在只在 dev 直跑时开，
 * 打包版要调试必须显式设 MIO_OPEN_DEVTOOLS=1。
 */
function devToolsEnabled(): boolean {
  return !app.isPackaged || process.env.MIO_OPEN_DEVTOOLS === '1'
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
  /**
   * 所在显示器的 Electron display.id。
   *
   * 注意其**不保证跨会话稳定**：Electron 文档明确说明 display id 在重启后
   * 不保证一致（驱动/热插拔都会变）。因此它只作为首选线索，
   * 真正的判定依据是下面的几何指纹 —— 见 findDisplayFor。
   */
  displayId?: number
  /** 显示器指纹：用分辨率+工作区原点描述，跨重启稳定。 */
  displayKey?: string
}

/**
 * 生成显示器指纹。
 *
 * 为什么不用 display.id：Electron 明确说它跨会话不保证稳定。
 * 分辨率 + 工作区原点是一个在"用户重启电脑"这个尺度上相当稳定的组合，
 * 且能区分常见的双屏布局（1920x1080@0,0 与 2560x1440@1920,0）。
 * 代价是同型号同布局的显示器无法区分 —— 但那种情况下两者本就等价，
 * 落到哪一块对用户没有差别。
 */
function displayKeyOf(display: Electron.Display): string {
  const a = display.workArea
  return `${display.size.width}x${display.size.height}@${a.x},${a.y}`
}

/**
 * 找到某坐标所属的显示器。
 * 先按 displayId 匹配（同会话内最准），失败再按几何指纹匹配（跨重启可用）。
 */
function findDisplayFor(b: StoredBounds): Electron.Display | null {
  const all = screen.getAllDisplays()
  if (b.displayId !== undefined) {
    const byId = all.find((d) => d.id === b.displayId)
    if (byId) return byId
  }
  if (b.displayKey) {
    const byKey = all.find((d) => displayKeyOf(d) === b.displayKey)
    if (byKey) return byKey
  }
  return null
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

  // 记录所在显示器：多屏用户把宠物放到副屏，重启后应该回到副屏。
  let displayId: number | undefined
  let displayKey: string | undefined
  try {
    const display = screen.getDisplayMatching(b)
    displayId = display.id
    displayKey = displayKeyOf(display)
  } catch (err) {
    log('WARN', 'form_display_lookup_failed', { kind, error: String(err) })
  }

  state[kind] = { x: b.x, y: b.y, width: b.width, height: b.height, displayId, displayKey }
  writeFormsState(state)
}

/**
 * 恢复位置到窗口上。
 *
 * 三种情形，按信号强度从强到弱判定：
 * 1. 坐标在当前任一显示器上仍然可见 → 原样还原（最强信号）。
 * 2. 坐标越界，但归属的那块显示器还在（如分辨率调小了）→ 夹回该屏可见区。
 * 3. 显示器已消失（拔了外接屏）→ 丢弃坐标，退回默认位置。
 *    这一步不能省：把窗口恢复到不存在的屏幕坐标上，
 *    表现为「应用启动了但看不见」，用户完全无从自救。
 *
 * 为什么把"坐标可见"排在"显示器身份匹配"之前：
 * 坐标可见本身就是比显示器身份更直接的判据。老版本状态文件没有 displayKey、
 * 或上次 screen.getDisplayMatching 抛错时，记录里就只有坐标 ——
 * 若此时苛求显示器身份，会把一个完全可用的位置白白丢掉，
 * 用户表现为"我明明没动过它，重启后位置却变了"。
 */
function restoreFormBounds(kind: FormKind, win: BrowserWindow, spec: FormWindowSpec): void {
  if (kind === 'wallpaper') return
  const stored = readFormsState()[kind]
  if (!stored) return

  const width = spec.size.width
  const height = spec.size.height

  // 情形 1：坐标仍落在某块当前显示器的可见区域内 → 直接用
  if (isBoundsVisible(stored, width, height)) {
    win.setBounds({ x: stored.x, y: stored.y, width, height })
    return
  }

  // 情形 2：坐标越界但显示器还在 → 夹回该屏（分辨率/工作区变化时的兜底）
  const display = findDisplayFor(stored)
  if (display) {
    const a = display.workArea
    const x = Math.min(Math.max(stored.x, a.x), a.x + Math.max(0, a.width - width))
    const y = Math.min(Math.max(stored.y, a.y), a.y + Math.max(0, a.height - height))
    win.setBounds({ x, y, width, height })
    log('INFO', 'form_bounds_clamped', { kind, from: stored, to: { x, y } })
    return
  }

  // 情形 3：无处可落 → 用默认位置（主屏居中附近）
  if (stored.displayId !== undefined || stored.displayKey !== undefined) {
    log('INFO', 'form_display_gone', { kind, displayId: stored.displayId, displayKey: stored.displayKey })
  }
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
  // 先恢复帧率/节流再显示：hideForm 把它们降过，不还原的话重新打开的
  // 形态会以 1fps 渲染（表现为动效卡成幻灯片）。
  try {
    win.webContents.setFrameRate(60)
    win.webContents.setBackgroundThrottling(false)
  } catch (err) {
    log('WARN', 'form_show_throttle_reset_failed', { kind, error: String(err) })
  }
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

/**
 * 隐藏某形态窗口。
 *
 * 关键：**隐藏时必须一并停掉渲染**，不能只 `hide()`。
 *
 * 对声明了 `transparent: true` 的窗口，`hide()` 只改变可见性标志，
 * Chromium 不会自动把该 WebContents 降级为 "hidden" —— 页面继续以
 * 全帧率出帧。实测（壁纸 2560x1440，含 142 个无限动画）：
 *
 *   壁纸可见      GPU 进程 138%
 *   壁纸已隐藏    GPU 进程 138%   ← 窗口确实不可见（IsWindowVisible=false），
 *                                   但一个核照样烧着，用户完全无感
 *
 * 壁纸是常驻功能，一旦被打开过就永久吃一个核，笔记本续航直接受影响。
 * 所以这里显式停掉渲染；`showForm` 侧恢复。这是按需重启而非销毁，
 * 重新显示时页面状态不会丢。
 *
 * 对非透明窗口（pet / chat）不加这个调用也无妨，但统一处理更简单、
 * 且能防住将来某个形态改成透明时又踩同一个坑。
 */
export function hideForm(kind: FormKind): void {
  const win = getFormWindow(kind)
  if (!win || win.isDestroyed()) return
  win.hide()
  // 必须在 hide() 之后：反过来的话，hide() 本身可能触发一次重绘
  try {
    win.webContents.setBackgroundThrottling(true)
    win.webContents.setFrameRate(1)
  } catch (err) {
    log('WARN', 'form_hide_throttle_failed', { kind, error: String(err) })
  }
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

/**
 * 向所有形态窗口广播一条消息。
 *
 * from 允许为 'shell'（主壳）：真实对话状态只存在于主壳的渲染进程里，
 * 必须经它广播，宠物才能知道"用户刚发问、还没出第一个字"。
 * 主壳不是形态窗口，因此不会出现在 formWindows 里，也就不会收到自己的回声。
 */
export function broadcastToForms(from: FormKind | 'shell', type: string, payload: unknown): void {
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

// ════════════════════════════════════════════════════════════════
// Agent 事件镜像到形态窗口
//
// 问题：AgentService / ChatExecutor 只把 `ai:chunk`、`tool:status` 等事件发给
// mainWindow（它们的字段就叫 mainWindow），形态窗口完全收不到，
// 于是宠物小人只能靠形态间广播自娱自乐，无法反映真实对话状态。
//
// 为什么不改 AgentService 去遍历所有窗口：
// 那会把"形态"这个概念泄漏进 intelligence 包（它不该知道桌面宠物的存在），
// 且要在多个发送点各改一遍。改为在窗口创建时**给主窗口挂一个镜像**：
// 主窗口收到的 agent 事件同步转发给形态窗口。发送方零改动。
//
// 只镜像白名单内的事件 —— 形状不匹配会让形态侧解析出 undefined，
// 而 `tts:*` 这类含音频二进制的事件更不该无谓地复制一份。
// ════════════════════════════════════════════════════════════════

/** 需要镜像到形态窗口的 agent 事件频道。 */
const MIRRORED_CHANNELS = ['ai:chunk', 'tool:status', 'agent:state'] as const

/**
 * 给指定（主）窗口挂上 agent 事件镜像。
 *
 * 幂等由 webContents 上的标记保证，而**不用模块级布尔量** ——
 * 主窗口可能被销毁重建，模块级标志会让新窗口漏挂镜像（静默失效）。
 */
export function attachAgentEventMirrorFor(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return
  patchMainWindowSend(win.webContents)
}

/**
 * 包装主窗口 webContents.send，把白名单频道额外投递给形态窗口。
 *
 * 说明：之所以包装 send 而不是监听 ipc-message，是因为后者拿不到参数载荷；
 * 之所以不改 AgentService，是为了把"形态"这层概念挡在 intelligence 包之外。
 * 原 send 行为完全保留（先调原方法），只做增量转发。
 */
function patchMainWindowSend(wc: Electron.WebContents): void {
  const original = wc.send.bind(wc) as (channel: string, ...args: unknown[]) => void
  if ((wc as unknown as { __formMirrorPatched?: boolean }).__formMirrorPatched) return

  const patched = (channel: string, ...args: unknown[]) => {
    // 先保证原行为不受影响
    original(channel, ...args)
    if (!(MIRRORED_CHANNELS as readonly string[]).includes(channel)) return
    // 增量：转发给形态窗口。
    // 用 setImmediate 让镜像不占用主窗口的同步路径，避免拖慢聊天渲染。
    setImmediate(() => {
      for (const [kind, win] of formWindows) {
        if (win.isDestroyed()) continue
        try {
          win.webContents.send(`forms:mirror:${channel}`, ...args)
        } catch {
          /* 单个窗口失败不影响其余；通常是正在销毁 */
        }
      }
    })
  }

  ;(wc as unknown as { send: typeof patched }).send = patched
  ;(wc as unknown as { __formMirrorPatched?: boolean }).__formMirrorPatched = true
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
