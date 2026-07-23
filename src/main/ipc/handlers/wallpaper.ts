import { ipcMain, BrowserWindow } from 'electron'
import { log } from '../../logger/Logger'
import { credentialsManager } from '../../credentials/CredentialsManager'
import { blogKanbanBridge } from '../../wallpaper/BlogKanbanBridge'
import type { HandlerContext } from './context'

export function registerWallpaperHandlers({ agentService, memoryContextRef, conversationContextRef, wallpaperInteractiveRef }: HandlerContext): void {
  const getNum = (key: string, fallback: number) => {
    const v = credentialsManager.get(key)
    if (v === null || v === undefined) return fallback
    const n = parseFloat(v)
    return isNaN(n) ? fallback : n
  }

  ipcMain.handle('wallpaper:getConfig', async () => ({
    enabled: credentialsManager.get('wp_enabled') !== 'false',
    idleOverlay: credentialsManager.get('wp_idle_overlay') !== 'false',
    adaptiveOpacity: credentialsManager.get('wp_adaptive_opacity') !== 'false',
    normalOpacity: getNum('wp_normal_opacity', 0.95),
    codeOpacity: getNum('wp_code_opacity', 0.25),
    fullscreenOpacity: getNum('wp_fullscreen_opacity', 0.15),
    idleOpacity: getNum('wp_idle_opacity', 0.55),
    evoLocked: credentialsManager.get('wp_evo_locked') === 'true',
  }))

  ipcMain.handle('wallpaper:setConfig', async (_event, config: Record<string, unknown>) => {
    try {
      for (const [key, value] of Object.entries(config)) {
        const credKey = 'wp_' + key.replace(/([A-Z])/g, '_$1').toLowerCase()
        credentialsManager.set(credKey, String(value))
      }
      return { success: true }
    } catch (err: any) { log('WARN', 'wallpaper_config_set_failed', { error: String(err) }); return { success: false } }
  })

  ipcMain.handle('wallpaper:getEvoLock', async () => ({ locked: credentialsManager.get('wp_evo_locked') === 'true' }))
  ipcMain.handle('wallpaper:setEvoLock', async (_event, locked: boolean) => { credentialsManager.set('wp_evo_locked', locked ? 'true' : 'false'); log('INFO', 'wallpaper_evo_lock_set', { locked }); return { success: true, locked } })
  ipcMain.handle('wallpaper:reloadStyles', async (_event, css: string) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) win.webContents.send('wallpaper:styles-updated', css)
    return { success: true }
  })

  // Interactive mode
  ipcMain.handle('wallpaper:interactive:getConfig', async () => {
    const svc = wallpaperInteractiveRef?.current
    if (!svc) return { enabled: false, shortcut: 'CommandOrControl+Space' }
    return svc.getConfig()
  })

  ipcMain.handle('wallpaper:interactive:setEnabled', async (_event, enabled: boolean) => {
    const svc = wallpaperInteractiveRef?.current
    if (!svc) return { success: false }
    svc.setConfig({ enabled })
    for (const win of BrowserWindow.getAllWindows()) {
      if (win && !win.isDestroyed()) win.webContents.send('wallpaper:interactive:toggle', { active: false })
    }
    log('INFO', 'wallpaper_interactive_config_set', { enabled })
    return { success: true }
  })

  // Memory context
  ipcMain.handle('wallpaper:memoryContextConfig:get', async () => {
    try { const svc = memoryContextRef?.current; return svc ? svc.getConfig() : { enabled: true, displayType: 'all', pollIntervalMs: 600000, maxCards: 5, mouseThrough: true } }
    catch { return { enabled: true, displayType: 'all', pollIntervalMs: 600000, maxCards: 5, mouseThrough: true } }
  })

  ipcMain.handle('wallpaper:memoryContextConfig:set', async (_event, patch: Record<string, unknown>) => {
    try {
      const svc = memoryContextRef?.current
      if (!svc) return { success: false, error: 'MemoryContextService not initialized' }
      svc.saveConfig(patch as any); svc.stop(); svc.start()
      return { success: true }
    } catch (err: any) { log('WARN', 'memory_context_config_set_failed', { error: String(err) }); return { success: false, error: String(err) } }
  })

  ipcMain.handle('wallpaper:memoryContext:refresh', async () => {
    try { const svc = memoryContextRef?.current; if (!svc) return { success: false, error: 'MemoryContextService not initialized' }; svc.refresh(); return { success: true } }
    catch (err: any) { log('WARN', 'memory_context_refresh_failed', { error: String(err) }); return { success: false, error: String(err) } }
  })

  // Conversation context
  ipcMain.handle('wallpaper:conversationContext:getConfig', async () => {
    try { const svc = conversationContextRef?.current; return svc ? svc.getConfig() : { enabled: true, position: 'right', maxTasks: 5, showSummary: true, showTasks: true, showProgress: true } }
    catch { return { enabled: true, position: 'right', maxTasks: 5, showSummary: true, showTasks: true, showProgress: true } }
  })

  ipcMain.handle('wallpaper:conversationContext:setConfig', async (_event, patch: Record<string, unknown>) => {
    try {
      const svc = conversationContextRef?.current
      if (!svc) return { success: false, error: 'ConversationContextService not initialized' }
      svc.saveConfig(patch as any); svc.stop(); svc.start()
      return { success: true }
    } catch (err: any) { log('WARN', 'conversation_context_config_set_failed', { error: String(err) }); return { success: false, error: String(err) } }
  })

  ipcMain.handle('wallpaper:openConversation', async (_event, conversationId: string) => {
    try {
      agentService.processTextInput('打开 ' + conversationId, 'wp_nav_' + Date.now(), 'electron', undefined, undefined, true).catch(() => {})
      log('INFO', 'conversation_navigated', { conversationId })
      return { success: true }
    } catch (err: any) { log('WARN', 'conversation_navigate_failed', { conversationId, error: String(err) }); return { success: false, error: String(err) } }
  })

  // ── 博客看板数据 ──
  ipcMain.handle('wallpaper:blogKanban:getStatus', async () => {
    // 惰性启动桥接器（首次请求时自动启动）
    if (!blogKanbanBridge.started) {
      blogKanbanBridge.start()
    }
    const payload = blogKanbanBridge.getCachedPayload()
    return payload ?? { sessions: [], totalActiveSessions: 0, hasActiveSessions: false, timestamp: Date.now() }
  })

  ipcMain.handle('wallpaper:blogKanban:refresh', async () => {
    if (!blogKanbanBridge.started) {
      blogKanbanBridge.start()
    } else {
      blogKanbanBridge.refresh()
    }
    return { success: true }
  })
}
