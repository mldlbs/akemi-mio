import { BrowserWindow, ipcMain } from 'electron'
import { log } from '@akemi-mio/core/logger/Logger'
import {
  broadcastToForms,
  createFormWindow,
  hideForm,
  isFormVisible,
  showForm,
  toggleForm,
  type FormKind,
} from '@akemi-mio/core/core/Lifecycle'

/** 形态标识白名单校验 —— 渲染进程传来的值不可信，必须过滤。 */
function isFormKind(value: unknown): value is FormKind {
  return value === 'pet' || value === 'chat' || value === 'wallpaper'
}

/**
 * 广播来源校验：三形态 + 主壳。
 *
 * 必须是白名单而非"非 undefined 即可"：from 字段决定了接收方
 * 是否把事件当作自己的回声丢弃，伪造来源会直接导致语义错乱。
 */
function isBroadcastSource(value: unknown): value is FormKind | 'shell' {
  return value === 'shell' || isFormKind(value)
}

export function registerFormHandlers(): void {
  ipcMain.handle('forms:toggle', async (_event, kind: unknown): Promise<boolean> => {
    if (!isFormKind(kind)) return false
    try {
      return toggleForm(kind)
    } catch (err) {
      log('WARN', 'form_toggle_failed', { kind, error: String(err) })
      return false
    }
  })

  ipcMain.handle('forms:setVisible', async (_event, kind: unknown, visible: unknown): Promise<void> => {
    if (!isFormKind(kind)) return
    const want = visible === true
    try {
      if (want) showForm(kind)
      else hideForm(kind)
    } catch (err) {
      log('WARN', 'form_set_visible_failed', { kind, visible: want, error: String(err) })
    }
  })

  ipcMain.handle('forms:isVisible', async (_event, kind: unknown): Promise<boolean> => {
    if (!isFormKind(kind)) return false
    return isFormVisible(kind)
  })

  /** 查询当前窗口承载的形态 —— 渲染进程启动时用它确认自己是谁。 */
  ipcMain.handle('forms:whoami', async (event): Promise<FormKind | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    // 从窗口加载的 URL 反推形态，比维护一份 窗口→形态 映射表更不易漂移
    const url = win.webContents.getURL()
    if (url.includes('pet.html')) return 'pet'
    if (url.includes('chat.html')) return 'chat'
    if (url.includes('wallpaper.html')) return 'wallpaper'
    return null
  })

  /** 跨形态广播：由主进程中继，而非渲染进程之间直连（后者会被 contextIsolation 挡住）。 */
  ipcMain.handle('forms:broadcast', async (_event, message: unknown): Promise<void> => {
    const msg = message as { from?: unknown; type?: unknown; payload?: unknown } | null
    if (!msg || !isBroadcastSource(msg.from) || typeof msg.type !== 'string') return
    broadcastToForms(msg.from, msg.type, msg.payload)
  })

  /** 鼠标穿透开关（宠物形态用）。 */
  ipcMain.handle('forms:setIgnoreMouseEvents', async (event, ignore: unknown): Promise<void> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    const on = ignore === true
    // forward: true 让窗口仍能收到 mousemove，从而支持"穿透状态下悬停恢复"的交互
    win.setIgnoreMouseEvents(on, { forward: true })
  })

  /** 无边框窗口的整窗拖拽。 */
  ipcMain.handle('forms:startDrag', async (event): Promise<void> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    // 拖拽由渲染侧的 -webkit-app-region: drag 负责，这里只做兜底日志。
    // 保留该通道是为了将来支持"按住某元素拖动窗口"的精细控制。
    log('DEBUG', 'form_drag_requested', {})
  })

  /** 按需创建某形态窗口（不显示）。供启动时预热，减少首次切换延迟。 */
  ipcMain.handle('forms:preload', async (_event, kind: unknown): Promise<boolean> => {
    if (!isFormKind(kind)) return false
    try {
      createFormWindow(kind)
      return true
    } catch (err) {
      log('WARN', 'form_preload_failed', { kind, error: String(err) })
      return false
    }
  })
}
