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
      agentService.pause()
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
