import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

/**
 * 多形态窗口的行为测试。
 *
 * 为什么 mock electron 而不是只做源码断言：
 * 三形态的窗口行为（透明、置顶、穿透、跨屏恢复）此前只经过类型检查与构建验证，
 * 从未真正执行过。这里用假 BrowserWindow 把 Lifecycle 里真实的
 * createFormWindow / restoreFormBounds / saveFormBounds / broadcastToForms /
 * 事件镜像全部跑一遍，把"应该在真实窗口里才暴露的问题"提前到 CI 里暴露。
 */

// ════════════════════════════════════════════════════════════════
// electron 假实现
// ════════════════════════════════════════════════════════════════

const h = vi.hoisted(() => {
  type Handler = (...args: any[]) => void

  class FakeWebContents {
    sent: Array<{ channel: string; args: any[] }> = []
    /** 置 true 模拟"窗口正在销毁时 send 抛错"，用于验证广播不会连坐 */
    throwOnSend = false
    send(channel: string, ...args: any[]): void {
      if (this.throwOnSend) throw new Error('Object has been destroyed')
      this.sent.push({ channel, args })
    }
    channels(): string[] {
      return this.sent.map((s) => s.channel)
    }
  }

  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = []

    options: any
    destroyed = false
    visible = false
    minimized = false
    focused = false
    bounds = { x: 0, y: 0, width: 0, height: 0 }

    setBoundsCalls: any[] = []
    alwaysOnTopCalls: Array<[boolean, string | undefined]> = []
    ignoreMouseCalls: Array<[boolean, any]> = []
    skipTaskbarCalls: boolean[] = []
    showCalls = 0
    showInactiveCalls = 0
    hideCalls = 0
    title = ''
    loadedUrl: string | null = null
    loadedFile: string | null = null

    webContents = new FakeWebContents()
    private handlers = new Map<string, Handler[]>()

    constructor(options: any) {
      this.options = options
      this.bounds = {
        x: options?.x ?? 0,
        y: options?.y ?? 0,
        width: options?.width ?? 0,
        height: options?.height ?? 0,
      }
      FakeBrowserWindow.instances.push(this)
    }

    on(event: string, fn: Handler): this {
      const list = this.handlers.get(event) || []
      list.push(fn)
      this.handlers.set(event, list)
      return this
    }
    /** 测试侧手动触发窗口事件（真实环境由 Electron 触发） */
    fire(event: string, ...args: any[]): void {
      for (const fn of [...(this.handlers.get(event) || [])]) fn(...args)
    }

    isDestroyed(): boolean {
      return this.destroyed
    }
    destroy(): void {
      if (this.destroyed) return
      this.destroyed = true
      this.fire('closed')
    }
    setBounds(b: any): void {
      this.setBoundsCalls.push(b)
      this.bounds = { ...this.bounds, ...b }
    }
    getBounds(): { x: number; y: number; width: number; height: number } {
      return { ...this.bounds }
    }
    setAlwaysOnTop(v: boolean, level?: string): void {
      this.alwaysOnTopCalls.push([v, level])
    }
    setIgnoreMouseEvents(v: boolean, opts?: any): void {
      this.ignoreMouseCalls.push([v, opts])
    }
    setSkipTaskbar(v: boolean): void {
      this.skipTaskbarCalls.push(v)
    }
    setTitle(t: string): void {
      this.title = t
    }
    loadURL(u: string): void {
      this.loadedUrl = u
    }
    loadFile(f: string): void {
      this.loadedFile = f
    }
    show(): void {
      this.showCalls++
      this.visible = true
    }
    showInactive(): void {
      this.showInactiveCalls++
      this.visible = true
    }
    hide(): void {
      this.hideCalls++
      this.visible = false
    }
    isVisible(): boolean {
      return this.visible && !this.destroyed
    }
    focus(): void {
      this.focused = true
    }
    isMinimized(): boolean {
      return this.minimized
    }
    getNativeWindowHandle(): Buffer {
      return Buffer.alloc(8)
    }
  }

  const mkDisplay = (id: number, w: number, hgt: number, x: number, y: number, taskbar = 40) => ({
    id,
    size: { width: w, height: hgt },
    bounds: { x, y, width: w, height: hgt },
    workArea: { x, y, width: w, height: hgt - taskbar },
    workAreaSize: { width: w, height: hgt - taskbar },
    scaleFactor: 1,
  })

  const state = {
    displays: [mkDisplay(1, 1920, 1080, 0, 0)] as any[],
    screenHandlers: new Map<string, Handler[]>(),
    shortcuts: new Map<string, Handler>(),
    /** globalShortcut.register 的返回值，用于模拟"组合键被其它程序占用" */
    registerResult: true,
    mkDisplay,
  }

  return { FakeBrowserWindow, FakeWebContents, state }
})

vi.mock('electron', () => {
  const screen = {
    getAllDisplays: () => h.state.displays,
    getPrimaryDisplay: () => h.state.displays[0],
    getDisplayMatching: (b: any) =>
      h.state.displays.find(
        (d) => b.x >= d.bounds.x && b.x < d.bounds.x + d.bounds.width && b.y >= d.bounds.y && b.y < d.bounds.y + d.bounds.height,
      ) || h.state.displays[0],
    on: (ev: string, fn: (...a: any[]) => void) => {
      const list = h.state.screenHandlers.get(ev) || []
      list.push(fn)
      h.state.screenHandlers.set(ev, list)
    },
    removeListener: (ev: string, fn: (...a: any[]) => void) => {
      const list = h.state.screenHandlers.get(ev) || []
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    },
  }

  return {
    BrowserWindow: h.FakeBrowserWindow,
    screen,
    globalShortcut: {
      register: (acc: string, fn: (...a: any[]) => void) => {
        if (!h.state.registerResult) return false
        h.state.shortcuts.set(acc, fn)
        return true
      },
      unregister: (acc: string) => {
        h.state.shortcuts.delete(acc)
      },
      isRegistered: (acc: string) => h.state.shortcuts.has(acc),
      unregisterAll: () => h.state.shortcuts.clear(),
    },
    app: {
      getPath: () => '/tmp/akemi-mio-userdata',
      getAppPath: () => '/tmp/akemi-mio-app',
    },
    session: {
      defaultSession: { webRequest: { onHeadersReceived: () => {} } },
    },
  }
})

// 必须在 vi.mock 之后（vite 会提升 mock，但 import 顺序按源码写序执行）
import {
  createFormWindow,
  getFormWindow,
  showForm,
  hideForm,
  isFormVisible,
  toggleForm,
  closeAllFormWindows,
  broadcastToForms,
  saveFormBounds,
  registerFormShortcuts,
  unregisterFormShortcuts,
  getFormShortcut,
  attachAgentEventMirrorFor,
} from '@akemi-mio/core/core/Lifecycle'
import { FORM_REGISTRY, FORM_KINDS } from '../../../../src/renderer/src/forms/types'

type FakeWin = InstanceType<typeof h.FakeBrowserWindow>

// ════════════════════════════════════════════════════════════════
// 测试脚手架
// ════════════════════════════════════════════════════════════════

let tmpDir: string
let logLines: Array<Record<string, any>>
let logSpy: ReturnType<typeof vi.spyOn>

beforeAll(() => {
  logLines = []
  logSpy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    // Logger 输出单行 JSON；解析失败（非 Logger 输出）则忽略
    try {
      const parsed = JSON.parse(String(line))
      if (parsed && typeof parsed === 'object' && typeof parsed.event === 'string') {
        logLines.push(parsed)
      }
    } catch {
      /* 非 JSON 输出，忽略 */
    }
  })
})

afterAll(() => {
  logSpy.mockRestore()
})

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mio-forms-'))
  process.env.USER_DATA_DIR = tmpDir
  delete process.env.ELECTRON_RENDERER_URL
  h.FakeBrowserWindow.instances = []
  h.state.displays = [h.state.mkDisplay(1, 1920, 1080, 0, 0)]
  h.state.screenHandlers.clear()
  h.state.shortcuts.clear()
  h.state.registerResult = true
  logLines = []
})

afterEach(() => {
  unregisterFormShortcuts()
  closeAllFormWindows()
  delete process.env.USER_DATA_DIR
  delete process.env.ELECTRON_RENDERER_URL
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响断言 */
  }
})

const stateFile = () => join(tmpDir, 'forms-window-state.json')
const readState = (): Record<string, any> =>
  existsSync(stateFile()) ? JSON.parse(readFileSync(stateFile(), 'utf-8')) : {}
const writeState = (s: Record<string, any>) => writeFileSync(stateFile(), JSON.stringify(s), 'utf-8')

const logEvents = (name: string) => logLines.filter((l) => l.event === name)

const primaryKey = '1920x1080@0,0'

// ════════════════════════════════════════════════════════════════
// 1. 窗口创建参数
// ════════════════════════════════════════════════════════════════

describe('形态窗口创建参数', () => {
  it('pet：透明无边框、置顶 floating、跳过任务栏、不可缩放', () => {
    const win = createFormWindow('pet') as unknown as FakeWin
    const o = win.options
    expect(o.transparent).toBe(true)
    expect(o.frame).toBe(false)
    expect(o.resizable).toBe(false)
    expect(o.skipTaskbar).toBe(true)
    expect(o.focusable).toBe(true)
    expect(o.show).toBe(false) // 不能在创建瞬间闪出来
    expect(o.hasShadow).toBe(false)
    expect(o.backgroundColor).toBe('#00000000') // 透明窗必须给全透明底色，否则是黑方块
    expect(o.width).toBe(160)
    expect(o.height).toBe(200)
    expect(win.alwaysOnTopCalls).toEqual([[true, 'floating']])
  })

  it('chat：可缩放且带最小尺寸，出现在任务栏', () => {
    const win = createFormWindow('chat') as unknown as FakeWin
    const o = win.options
    expect(o.transparent).toBe(true)
    expect(o.resizable).toBe(true)
    expect(o.minWidth).toBe(320)
    expect(o.minHeight).toBe(360)
    expect(o.skipTaskbar).toBe(false)
    expect(o.width).toBe(420)
    expect(o.height).toBe(560)
    expect(win.alwaysOnTopCalls).toEqual([[true, 'floating']])
  })

  it('wallpaper：铺满主屏 bounds（含任务栏）、鼠标穿透、不可聚焦', () => {
    const win = createFormWindow('wallpaper') as unknown as FakeWin
    const o = win.options
    expect(o.transparent).toBe(true)
    expect(o.focusable).toBe(false)
    expect(o.resizable).toBe(false)
    // 用 bounds 而非 workArea，否则任务栏那条会露出来
    expect(win.setBoundsCalls[0]).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
    expect(win.ignoreMouseCalls).toEqual([[true, { forward: true }]])
    expect(win.skipTaskbarCalls).toEqual([true])
    // 壁纸不置顶
    expect(win.alwaysOnTopCalls).toEqual([])
  })

  it('三形态都禁用后台节流（否则常驻动画会卡住）', () => {
    for (const kind of FORM_KINDS) {
      const win = createFormWindow(kind) as unknown as FakeWin
      expect(win.options.webPreferences.backgroundThrottling).toBe(false)
      expect(win.options.webPreferences.contextIsolation).toBe(true)
      expect(win.options.webPreferences.nodeIntegration).toBe(false)
    }
  })

  it('创建是幂等的：重复调用不新建窗口', () => {
    const a = createFormWindow('pet')
    const b = createFormWindow('pet')
    expect(b).toBe(a)
    expect(h.FakeBrowserWindow.instances).toHaveLength(1)
  })

  it('窗口销毁后会重建（不会返回已销毁的僵尸实例）', () => {
    const a = createFormWindow('pet') as unknown as FakeWin
    a.destroy()
    const b = createFormWindow('pet') as unknown as FakeWin
    expect(b).not.toBe(a)
    expect(b.destroyed).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════
// 2. 入口文件三方同步（htmlFile）
// ════════════════════════════════════════════════════════════════

describe('入口文件三方同步', () => {
  it('loadFile 的路径后缀与 FORM_REGISTRY.htmlFile 逐字一致', () => {
    for (const kind of FORM_KINDS) {
      const win = createFormWindow(kind) as unknown as FakeWin
      expect(win.loadedFile).toBeTruthy()
      expect(win.loadedFile!.replace(/\\/g, '/').endsWith(`/${FORM_REGISTRY[kind].htmlFile}`)).toBe(true)
    }
  })

  it('dev 模式下按 ELECTRON_RENDERER_URL 拼接 htmlFile', () => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173/index.html'
    for (const kind of FORM_KINDS) {
      const win = createFormWindow(kind) as unknown as FakeWin
      expect(win.loadedUrl).toBe(`http://localhost:5173/${FORM_REGISTRY[kind].htmlFile}`)
    }
  })

  it('electron.vite.config.ts 为三形态注册了 rollup input（漏注册 = 运行期空白窗口）', () => {
    const srcPath = resolve(__dirname, '../../../../electron.vite.config.ts')
    const src = readFileSync(srcPath, 'utf-8')
    for (const kind of FORM_KINDS) {
      const file = FORM_REGISTRY[kind].htmlFile
      expect(src).toMatch(new RegExp(`${kind}: resolve\\(__dirname, 'src/renderer/${file}'\\)`))
    }
  })
})

// ════════════════════════════════════════════════════════════════
// 3. 位置持久化：保存
// ════════════════════════════════════════════════════════════════

describe('位置持久化 — 保存', () => {
  it('保存坐标 + 所在显示器 id 与指纹', () => {
    const win = createFormWindow('pet') as unknown as FakeWin
    win.show()
    win.setBounds({ x: 1500, y: 800, width: 160, height: 200 })
    saveFormBounds('pet')

    const saved = readState().pet
    expect(saved.x).toBe(1500)
    expect(saved.y).toBe(800)
    expect(saved.width).toBe(160)
    expect(saved.displayId).toBe(1)
    expect(saved.displayKey).toBe(primaryKey)
  })

  it('副屏上的窗口记录副屏（多屏用户重启后应回到副屏）', () => {
    h.state.displays = [
      h.state.mkDisplay(1, 1920, 1080, 0, 0),
      h.state.mkDisplay(2, 2560, 1440, 1920, 0),
    ]
    const win = createFormWindow('chat') as unknown as FakeWin
    win.show()
    win.setBounds({ x: 3000, y: 500, width: 420, height: 560 })
    saveFormBounds('chat')

    const saved = readState().chat
    expect(saved.displayId).toBe(2)
    expect(saved.displayKey).toBe('2560x1440@1920,0')
  })

  it('壁纸不持久化位置（铺满整屏，位置无意义）', () => {
    const win = createFormWindow('wallpaper') as unknown as FakeWin
    win.show()
    saveFormBounds('wallpaper')
    expect(readState()).toEqual({})
  })

  it('窗口不可见时不写入（避免把隐藏态的坐标固化）', () => {
    const win = createFormWindow('pet') as unknown as FakeWin
    win.setBounds({ x: 10, y: 10, width: 160, height: 200 })
    expect(win.isVisible()).toBe(false)
    saveFormBounds('pet')
    expect(readState()).toEqual({})
  })

  it('最小化时不写入', () => {
    const win = createFormWindow('pet') as unknown as FakeWin
    win.show()
    win.minimized = true
    saveFormBounds('pet')
    expect(readState()).toEqual({})
  })

  it('拖动用 500ms 防抖，不会每帧写盘', () => {
    vi.useFakeTimers()
    try {
      const win = createFormWindow('pet') as unknown as FakeWin
      win.show()
      win.setBounds({ x: 100, y: 100, width: 160, height: 200 })
      for (let i = 0; i < 50; i++) win.fire('moved') // 模拟拖动过程中的高频事件
      expect(existsSync(stateFile())).toBe(false)
      vi.advanceTimersByTime(499)
      expect(existsSync(stateFile())).toBe(false)
      vi.advanceTimersByTime(1)
      expect(existsSync(stateFile())).toBe(true)
      expect(readState().pet.x).toBe(100)
    } finally {
      vi.useRealTimers()
    }
  })

  it('关闭时立即落盘，不等防抖', () => {
    vi.useFakeTimers()
    try {
      const win = createFormWindow('pet') as unknown as FakeWin
      win.show()
      win.setBounds({ x: 222, y: 333, width: 160, height: 200 })
      win.fire('moved')
      win.fire('close')
      expect(existsSync(stateFile())).toBe(true)
      expect(readState().pet.x).toBe(222)
    } finally {
      vi.useRealTimers()
    }
  })

  it('BOM 不会让状态文件解析失败', () => {
    writeFileSync(stateFile(), '\uFEFF{"pet":{"x":1,"y":2}}', 'utf-8')
    const win = createFormWindow('pet') as unknown as FakeWin
    // 能走到 setBounds 说明解析成功
    expect(win.setBoundsCalls.length).toBeGreaterThan(0)
  })

  it('状态文件损坏时降级为"无历史位置"，不抛错', () => {
    writeFileSync(stateFile(), '{ this is not json', 'utf-8')
    expect(() => createFormWindow('pet')).not.toThrow()
    expect(logEvents('forms_state_read_failed').length).toBeGreaterThan(0)
  })
})

// ════════════════════════════════════════════════════════════════
// 4. 位置持久化：恢复的三条路径
// ════════════════════════════════════════════════════════════════

describe('位置持久化 — 恢复', () => {
  it('情形 1：显示器仍在且坐标可见 → 原样还原', () => {
    writeState({ pet: { x: 1500, y: 800, width: 160, height: 200, displayId: 1, displayKey: primaryKey } })
    const win = createFormWindow('pet') as unknown as FakeWin
    expect(win.setBoundsCalls).toEqual([{ x: 1500, y: 800, width: 160, height: 200 }])
    expect(logEvents('form_bounds_clamped')).toHaveLength(0)
  })

  it('情形 1b：副屏坐标在副屏仍在时还原到副屏', () => {
    h.state.displays = [
      h.state.mkDisplay(1, 1920, 1080, 0, 0),
      h.state.mkDisplay(2, 2560, 1440, 1920, 0),
    ]
    writeState({ chat: { x: 3000, y: 500, width: 420, height: 560, displayId: 2, displayKey: '2560x1440@1920,0' } })
    const win = createFormWindow('chat') as unknown as FakeWin
    expect(win.setBoundsCalls).toEqual([{ x: 3000, y: 500, width: 420, height: 560 }])
  })

  it('情形 2：显示器仍在但坐标越界（分辨率变小）→ 夹回可见区域', () => {
    writeState({ pet: { x: 1900, y: 1000, width: 160, height: 200, displayId: 1, displayKey: primaryKey } })
    const win = createFormWindow('pet') as unknown as FakeWin
    // workArea 为 1920x1040；x 上界 1920-160=1760，y 上界 1040-200=840
    expect(win.setBoundsCalls).toEqual([{ x: 1760, y: 840, width: 160, height: 200 }])
    expect(logEvents('form_bounds_clamped')).toHaveLength(1)
  })

  it('情形 3：显示器已拔掉 → 丢弃坐标，用默认位置（否则窗口会落在屏幕外）', () => {
    writeState({ pet: { x: 3000, y: 500, width: 160, height: 200, displayId: 2, displayKey: '2560x1440@1920,0' } })
    const win = createFormWindow('pet') as unknown as FakeWin
    // 当前只有主屏，副屏已消失 —— 绝不能把窗口恢复到不存在的屏幕上
    expect(win.setBoundsCalls).toEqual([])
    expect(logEvents('form_display_gone')).toHaveLength(1)
  })

  it('只记录坐标但无显示器信息时，按"当前有屏可见"处理', () => {
    writeState({ pet: { x: 200, y: 200 } })
    const win = createFormWindow('pet') as unknown as FakeWin
    expect(win.setBoundsCalls).toEqual([{ x: 200, y: 200, width: 160, height: 200 }])
  })

  it('壁纸不参与位置恢复', () => {
    writeState({ wallpaper: { x: 123, y: 456, displayId: 1, displayKey: primaryKey } })
    const win = createFormWindow('wallpaper') as unknown as FakeWin
    // 只有 applyWallpaperBounds 那一次铺满
    expect(win.setBoundsCalls).toEqual([{ x: 0, y: 0, width: 1920, height: 1080 }])
  })
})

// ════════════════════════════════════════════════════════════════
// 5. 显隐与生命周期
// ════════════════════════════════════════════════════════════════

describe('显隐与生命周期', () => {
  it('showForm 普通形态：show + focus', () => {
    const win = showForm('pet') as unknown as FakeWin
    expect(win.showCalls).toBe(1)
    expect(win.showInactiveCalls).toBe(0)
    expect(win.focused).toBe(true)
    expect(isFormVisible('pet')).toBe(true)
  })

  it('showForm 壁纸：不抢焦点且取消置顶', () => {
    const win = showForm('wallpaper') as unknown as FakeWin
    expect(win.showInactiveCalls).toBe(1)
    expect(win.showCalls).toBe(0)
    expect(win.alwaysOnTopCalls).toEqual([[false, undefined]])
    // 每次显示都重新铺满，避免插拔外接屏后留黑边
    expect(win.setBoundsCalls.length).toBeGreaterThanOrEqual(2)
  })

  it('showForm(kind, false) 不抢焦点', () => {
    const win = showForm('chat', false) as unknown as FakeWin
    expect(win.showCalls).toBe(1)
    expect(win.focused).toBe(false)
  })

  it('toggleForm 来回切换并返回切换后状态', () => {
    expect(toggleForm('pet')).toBe(true)
    expect(isFormVisible('pet')).toBe(true)
    expect(toggleForm('pet')).toBe(false)
    expect(isFormVisible('pet')).toBe(false)
  })

  it('未创建的形态 isVisible 为 false，不抛错', () => {
    expect(isFormVisible('chat')).toBe(false)
    expect(() => hideForm('chat')).not.toThrow()
  })

  it('closeAllFormWindows 销毁全部并清空注册表', () => {
    const pet = createFormWindow('pet') as unknown as FakeWin
    const chat = createFormWindow('chat') as unknown as FakeWin
    closeAllFormWindows()
    expect(pet.destroyed).toBe(true)
    expect(chat.destroyed).toBe(true)
    expect(getFormWindow('pet')).toBeNull()
    expect(getFormWindow('chat')).toBeNull()
  })

  it('已销毁的窗口不会被 getFormWindow 返回', () => {
    const win = createFormWindow('pet') as unknown as FakeWin
    win.destroy()
    expect(getFormWindow('pet')).toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════
// 6. 广播
// ════════════════════════════════════════════════════════════════

describe('跨形态广播', () => {
  it('广播投递给除发送方外的所有形态窗口', () => {
    const pet = createFormWindow('pet') as unknown as FakeWin
    const chat = createFormWindow('chat') as unknown as FakeWin
    broadcastToForms('shell', 'agent:state', { state: 'thinking' })

    expect(pet.webContents.sent).toEqual([
      { channel: 'forms:broadcast', args: [{ from: 'shell', type: 'agent:state', payload: { state: 'thinking' } }] },
    ])
    expect(chat.webContents.sent).toEqual(pet.webContents.sent)
  })

  it('发送方不会收到自己的回声', () => {
    const pet = createFormWindow('pet') as unknown as FakeWin
    createFormWindow('chat')
    broadcastToForms('pet', 'mood', { mood: 'happy' })
    expect(pet.webContents.sent).toEqual([])
  })

  it('单个窗口 send 抛错不影响其余窗口，也不向上冒泡', () => {
    const pet = createFormWindow('pet') as unknown as FakeWin
    const chat = createFormWindow('chat') as unknown as FakeWin
    pet.webContents.throwOnSend = true
    expect(() => broadcastToForms('shell', 'x', 1)).not.toThrow()
    expect(chat.webContents.sent).toHaveLength(1)
    expect(logEvents('form_broadcast_failed').length).toBe(1)
  })

  it('已销毁的窗口被跳过', () => {
    const pet = createFormWindow('pet') as unknown as FakeWin
    createFormWindow('chat')
    pet.destroy()
    broadcastToForms('shell', 'x', 1)
    expect(pet.webContents.sent).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════
// 7. 快捷键
// ════════════════════════════════════════════════════════════════

describe('形态快捷键', () => {
  it('注册三个不冲突的组合键', () => {
    registerFormShortcuts()
    const keys = [...h.state.shortcuts.keys()]
    expect(keys).toEqual([
      'CommandOrControl+Shift+P',
      'CommandOrControl+Shift+L',
      'CommandOrControl+Shift+W',
    ])
    // 必须避开已被占用的组合，否则会抢走主壳/语音便签的快捷键
    expect(keys).not.toContain('CommandOrControl+Space')
    expect(keys).not.toContain('CommandOrControl+Shift+V')
  })

  it('按下快捷键会切换对应形态', () => {
    registerFormShortcuts()
    h.state.shortcuts.get('CommandOrControl+Shift+P')!()
    expect(isFormVisible('pet')).toBe(true)
    h.state.shortcuts.get('CommandOrControl+Shift+P')!()
    expect(isFormVisible('pet')).toBe(false)
  })

  it('注册是幂等的（不会重复注册同一组合）', () => {
    registerFormShortcuts()
    registerFormShortcuts()
    expect(h.state.shortcuts.size).toBe(3)
  })

  it('全部被占用时允许下次重试（不留"以为注册成功"的假状态）', () => {
    h.state.registerResult = false
    registerFormShortcuts()
    expect(logEvents('form_shortcut_occupied')).toHaveLength(3)
    h.state.registerResult = true
    registerFormShortcuts() // 若被布尔量锁死，这里会静默跳过
    expect(h.state.shortcuts.size).toBe(3)
  })

  it('unregister 后释放全部组合', () => {
    registerFormShortcuts()
    unregisterFormShortcuts()
    expect(h.state.shortcuts.size).toBe(0)
  })

  it('getFormShortcut 返回设置界面要展示的键位', () => {
    expect(getFormShortcut('pet')).toBe('CommandOrControl+Shift+P')
    expect(getFormShortcut('chat')).toBe('CommandOrControl+Shift+L')
    expect(getFormShortcut('wallpaper')).toBe('CommandOrControl+Shift+W')
  })
})

// ════════════════════════════════════════════════════════════════
// 8. 壁纸跟随显示器变化
// ════════════════════════════════════════════════════════════════

describe('壁纸跟随显示器变化', () => {
  const fireScreen = (ev: string) => {
    for (const fn of [...(h.state.screenHandlers.get(ev) || [])]) fn({}, h.state.displays[0])
  }

  it('display-metrics-changed / added / removed 都会重新铺满', () => {
    const win = createFormWindow('wallpaper') as unknown as FakeWin
    const before = win.setBoundsCalls.length
    fireScreen('display-metrics-changed')
    fireScreen('display-added')
    fireScreen('display-removed')
    expect(win.setBoundsCalls.length).toBe(before + 3)
  })

  it('分辨率变化后铺的是新尺寸', () => {
    createFormWindow('wallpaper')
    h.state.displays = [h.state.mkDisplay(1, 3840, 2160, 0, 0)]
    const win = showForm('wallpaper') as unknown as FakeWin
    expect(win.setBoundsCalls[win.setBoundsCalls.length - 1]).toEqual({
      x: 0,
      y: 0,
      width: 3840,
      height: 2160,
    })
  })

  it('窗口关闭后注销监听，不再响应显示器事件', () => {
    const win = createFormWindow('wallpaper') as unknown as FakeWin
    win.destroy()
    const before = win.setBoundsCalls.length
    fireScreen('display-metrics-changed')
    expect(win.setBoundsCalls.length).toBe(before)
  })
})

// ════════════════════════════════════════════════════════════════
// 9. Agent 事件镜像
// ════════════════════════════════════════════════════════════════

describe('Agent 事件镜像到形态窗口', () => {
  /** 镜像用 setImmediate 异步转发，等一个宏任务 */
  const flush = () => new Promise((r) => setImmediate(r))

  it('白名单频道转发给形态窗口，且原发送行为保留', async () => {
    const pet = createFormWindow('pet') as unknown as FakeWin
    const main = new h.FakeBrowserWindow({}) as unknown as FakeWin
    attachAgentEventMirrorFor(main as any)

    main.webContents.send('ai:chunk', { text: '你好' })
    await flush()

    // 主窗口自己仍然收到
    expect(main.webContents.sent).toEqual([{ channel: 'ai:chunk', args: [{ text: '你好' }] }])
    // 形态窗口收到镜像
    expect(pet.webContents.sent).toEqual([
      { channel: 'forms:mirror:ai:chunk', args: [{ text: '你好' }] },
    ])
  })

  it('非白名单频道不转发（避免复制 tts 等含二进制的事件）', async () => {
    const pet = createFormWindow('pet') as unknown as FakeWin
    const main = new h.FakeBrowserWindow({}) as unknown as FakeWin
    attachAgentEventMirrorFor(main as any)

    main.webContents.send('tts:audio', Buffer.alloc(4))
    main.webContents.send('state:update', { asr: 'ready' })
    await flush()

    expect(pet.webContents.sent).toEqual([])
  })

  it('重复挂镜像不会重复转发（同一 webContents 幂等）', async () => {
    const pet = createFormWindow('pet') as unknown as FakeWin
    const main = new h.FakeBrowserWindow({}) as unknown as FakeWin
    attachAgentEventMirrorFor(main as any)
    attachAgentEventMirrorFor(main as any)

    main.webContents.send('tool:status', { name: 'search' })
    await flush()

    expect(pet.webContents.sent).toHaveLength(1)
  })

  it('新窗口也要能挂上镜像（主窗口重建后不能静默失效）', async () => {
    const pet = createFormWindow('pet') as unknown as FakeWin
    const main1 = new h.FakeBrowserWindow({}) as unknown as FakeWin
    const main2 = new h.FakeBrowserWindow({}) as unknown as FakeWin
    attachAgentEventMirrorFor(main1 as any)
    attachAgentEventMirrorFor(main2 as any)

    main2.webContents.send('agent:state', { state: 'thinking' })
    await flush()

    // 若用模块级布尔量做幂等，main2 会漏挂，宠物就永远收不到真实对话状态
    expect(pet.webContents.sent.map((s) => s.channel)).toEqual(['forms:mirror:agent:state'])
  })

  it('形态窗口销毁后转发不抛错', async () => {
    const pet = createFormWindow('pet') as unknown as FakeWin
    const main = new h.FakeBrowserWindow({}) as unknown as FakeWin
    attachAgentEventMirrorFor(main as any)
    pet.webContents.throwOnSend = true

    expect(() => main.webContents.send('ai:chunk', { text: 'x' })).not.toThrow()
    await flush()
    expect(main.webContents.sent).toHaveLength(1)
  })

  it('attach 到已销毁/null 窗口是安全的空操作', () => {
    const dead = new h.FakeBrowserWindow({}) as unknown as FakeWin
    dead.destroy()
    expect(() => attachAgentEventMirrorFor(dead as any)).not.toThrow()
    expect(() => attachAgentEventMirrorFor(null)).not.toThrow()
  })
})

// ════════════════════════════════════════════════════════════════
// 10. 契约一致性
// ════════════════════════════════════════════════════════════════

describe('主进程与渲染进程契约一致', () => {
  it('主进程创建的尺寸与 FORM_REGISTRY 声明一致', () => {
    for (const kind of FORM_KINDS) {
      const win = createFormWindow(kind) as unknown as FakeWin
      const declared = FORM_REGISTRY[kind].size
      if (kind === 'wallpaper') {
        // 壁纸尺寸由显示器决定，spec 里为 0
        expect(declared.width).toBe(0)
      } else {
        expect(win.options.width).toBe(declared.width)
        expect(win.options.height).toBe(declared.height)
      }
    }
  })

  it('窗口标题对壁纸留空（避免出现在窗口列表里）', () => {
    const pet = createFormWindow('pet') as unknown as FakeWin
    const wp = createFormWindow('wallpaper') as unknown as FakeWin
    expect(pet.title).toBe('Akemi Mio — pet')
    expect(wp.title.trim()).toBe('')
  })
})
