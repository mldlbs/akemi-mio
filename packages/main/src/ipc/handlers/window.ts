import { BrowserWindow, ipcMain } from 'electron'
import { log } from '@akemi-mio/core/logger/Logger'
import { existsSync } from 'fs'
import type { HandlerContext } from './context'

const sandboxWindows = new Map<string, BrowserWindow>()

function openSandboxWindow(name: string, htmlPath: string): void {
  const existing = sandboxWindows.get(name)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return
  }
  if (!existsSync(htmlPath)) {
    log('WARN', 'sandbox_html_not_found', { name, htmlPath })
    return
  }
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    title: '星尘流韵 — Astral Flow',
    webPreferences: { contextIsolation: true, nodeIntegration: false, webSecurity: true },
  })
  win.loadFile(htmlPath)
  sandboxWindows.set(name, win)
  win.on('closed', () => sandboxWindows.delete(name))
}

export function registerWindowHandlers({ agentService, eventBus }: HandlerContext & { eventBus: any }): void {
  ipcMain.handle('window:close', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { success: false }
    try {
      // 不要在这里调 agentService.pause()：pause() 会设持久标志 `_paused = true`，
      // 而唯一的清除路径是 `agent:resume` —— 它没有任何消费方（preload 都没暴露），
      // 于是「点一次关闭按钮」会让 agent 永久停在 PAUSED，之后每次 ai:chat 都被拒，
      // 且用户无从恢复。关窗口要的是「停止当前输出」，stopConversation() 已经做了，
      // 而且做得更彻底：它还清 runContext、把未终结的执行目标标成 abandoned。
      await agentService.stopConversation().catch(() => {})
      eventBus.emit('agent.session.flush' as any, {})
      agentService.saveRecoverySnapshot?.('window_close' as any)
    } catch (err) {
      log('WARN', 'window_close_save_failed', { error: String(err) })
    }
    win.hide()
    return { success: true }
  })

  ipcMain.handle('window:minimize', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { success: false }
    win.minimize()
    return { success: true }
  })

  ipcMain.handle('window:maximize', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { success: false, isMaximized: false }
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return { success: true, isMaximized: win.isMaximized() }
  })

  ipcMain.handle('window:isMaximized', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { isMaximized: false }
    return { isMaximized: win.isMaximized() }
  })

  ipcMain.handle('window:fullscreen', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { success: false, isFullScreen: false }
    win.setFullScreen(!win.isFullScreen())
    return { success: true, isFullScreen: win.isFullScreen() }
  })
}
