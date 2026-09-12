import { ipcMain, BrowserWindow } from 'electron'
import { log } from '@akemi-mio/core/logger/Logger'
import { credentialsManager } from '@akemi-mio/core/credentials/CredentialsManager'
import { blogKanbanBridge } from '@akemi-mio/platform/wallpaper/BlogKanbanBridge'
import { behaviorActionCounter } from '@akemi-mio/evolution/behavior/BehaviorActionCounter'
import type { HandlerContext } from './context'

const DEFAULT_WALLPAPER_INTERACTIVE_CONFIG = {
  enabled: false,
  shortcut: 'CommandOrControl+Space',
}

function hasWallpaperInteractiveApi(
  svc: unknown,
): svc is { getConfig: () => { enabled: boolean; shortcut: string }; setConfig: (config: { enabled?: boolean }) => void } {
  return !!svc && typeof (svc as any).getConfig === 'function' && typeof (svc as any).setConfig === 'function'
}

function hasTaskPanelApi(svc: unknown): svc is {
  getState: () => any
  toggleVisibility: () => boolean
  setVisible: (visible: boolean) => void
  recordAction: (action: { tool: string; status: 'running' | 'success' | 'error'; summary: string }) => void
} {
  return (
    !!svc &&
    typeof (svc as any).getState === 'function' &&
    typeof (svc as any).toggleVisibility === 'function' &&
    typeof (svc as any).setVisible === 'function' &&
    typeof (svc as any).recordAction === 'function'
  )
}

export function registerWallpaperHandlers({
  agentService,
  evolutionRef,
  memoryContextRef,
  conversationContextRef,
  taskPanelRef,
  wallpaperInteractiveRef,
}: HandlerContext): void {
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
    } catch (err: any) {
      log('WARN', 'wallpaper_config_set_failed', { error: String(err) })
      return { success: false }
    }
  })

  ipcMain.handle('wallpaper:getEvoLock', async () => ({ locked: credentialsManager.get('wp_evo_locked') === 'true' }))
  ipcMain.handle('wallpaper:setEvoLock', async (_event, locked: boolean) => {
    credentialsManager.set('wp_evo_locked', locked ? 'true' : 'false')
    log('INFO', 'wallpaper_evo_lock_set', { locked })
    return { success: true, locked }
  })
  ipcMain.handle('wallpaper:reloadStyles', async (_event, css: string) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) win.webContents.send('wallpaper:styles-updated', css)
    return { success: true }
  })

  // Interactive mode
  ipcMain.handle('wallpaper:interactive:getConfig', async () => {
    const svc = wallpaperInteractiveRef?.current
    if (!hasWallpaperInteractiveApi(svc)) return DEFAULT_WALLPAPER_INTERACTIVE_CONFIG
    return svc.getConfig()
  })

  ipcMain.handle('wallpaper:interactive:setEnabled', async (_event, enabled: boolean) => {
    const svc = wallpaperInteractiveRef?.current
    if (!hasWallpaperInteractiveApi(svc)) return { success: false }
    svc.setConfig({ enabled })
    for (const win of BrowserWindow.getAllWindows()) {
      if (win && !win.isDestroyed()) win.webContents.send('wallpaper:interactive:toggle', { active: false })
    }
    log('INFO', 'wallpaper_interactive_config_set', { enabled })
    return { success: true }
  })

  // Task panel
  ipcMain.handle('taskPanel:getState', async () => {
    const svc = taskPanelRef?.current
    if (!hasTaskPanelApi(svc)) return { success: false, error: 'TaskPanelService not initialized' }
    return { success: true, state: svc.getState() }
  })

  ipcMain.handle('taskPanel:toggleVisibility', async () => {
    const svc = taskPanelRef?.current
    if (!hasTaskPanelApi(svc)) return { success: false, visible: false }
    return { success: true, visible: svc.toggleVisibility() }
  })

  ipcMain.handle('taskPanel:setVisibility', async (_event, visible: boolean) => {
    const svc = taskPanelRef?.current
    if (!hasTaskPanelApi(svc)) return { success: false, visible: false }
    svc.setVisible(visible)
    return { success: true, visible }
  })

  ipcMain.handle(
    'taskPanel:recordAction',
    async (_event, action: { tool: string; status: 'running' | 'success' | 'error'; summary: string }) => {
      const svc = taskPanelRef?.current
      if (!hasTaskPanelApi(svc)) return { success: false }
      svc.recordAction(action)
      return { success: true }
    },
  )

  ipcMain.handle('taskPanel:invokeQuickAction', async (_event, actionId: string, args: Record<string, string>) => {
    const svc = taskPanelRef?.current
    if (!hasTaskPanelApi(svc)) return { success: false, error: 'TaskPanelService not initialized' }

    const state = svc.getState()
    const action = state?.quickActions?.find((item: any) => item.id === actionId)
    if (!action) return { success: false, error: `Unknown task panel action: ${actionId}` }

    try {
      if (action.tool === 'evolution_trigger') {
        const evolution = evolutionRef?.current
        if (!evolution) return { success: false, error: 'evolution not ready' }
        await evolution.triggerNow()
        svc.recordAction({ tool: action.tool, status: 'success', summary: `${action.label} 已触发` })
        return { success: true, result: `${action.label} 已触发` }
      }

      if (action.tool === 'desktop_ask_agent') {
        const prompt = args.prompt || args.content || ''
        if (!prompt.trim()) return { success: false, error: 'prompt is required' }
        await agentService.processTextInput(prompt, `task_panel_${Date.now()}`, 'task-panel' as any)
        svc.recordAction({ tool: action.tool, status: 'success', summary: `${action.label} 已发送` })
        return { success: true, result: `${action.label} 已发送` }
      }

      const { desktopTools } = await import('@akemi-mio/capabilities/tool/definitions/DesktopTools')
      const tool = desktopTools.find((item) => item.name === action.tool)
      if (!tool) return { success: false, error: `No desktop handler for ${action.tool}` }

      const toolResult = await (tool.handler as (a: Record<string, string>) => any)(args || {})
      const text = toolResult?.content?.[0]?.text || ''
      const success = !toolResult?.isError
      svc.recordAction({
        tool: action.tool,
        status: success ? 'success' : 'error',
        summary: text || action.label,
      })
      return { success, result: success ? text : undefined, error: success ? undefined : text || `Failed to run ${action.tool}` }
    } catch (err: any) {
      log('WARN', 'task_panel_invoke_quick_action_failed', { actionId, error: String(err) })
      svc.recordAction({
        tool: action.tool,
        status: 'error',
        summary: `${action.label} 执行失败`,
      })
      return { success: false, error: err?.message || String(err) }
    }
  })

  // Memory context
  ipcMain.handle('wallpaper:memoryContextConfig:get', async () => {
    try {
      const svc = memoryContextRef?.current
      return svc ? svc.getConfig() : { enabled: true, displayType: 'all', pollIntervalMs: 600000, maxCards: 5, mouseThrough: true }
    } catch {
      return { enabled: true, displayType: 'all', pollIntervalMs: 600000, maxCards: 5, mouseThrough: true }
    }
  })

  ipcMain.handle('wallpaper:memoryContextConfig:set', async (_event, patch: Record<string, unknown>) => {
    try {
      const svc = memoryContextRef?.current
      if (!svc) return { success: false, error: 'MemoryContextService not initialized' }
      svc.saveConfig(patch as any)
      svc.stop()
      svc.start()
      return { success: true }
    } catch (err: any) {
      log('WARN', 'memory_context_config_set_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('wallpaper:memoryContext:refresh', async () => {
    try {
      const svc = memoryContextRef?.current
      if (!svc) return { success: false, error: 'MemoryContextService not initialized' }
      svc.refresh()
      return { success: true }
    } catch (err: any) {
      log('WARN', 'memory_context_refresh_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  // Conversation context
  ipcMain.handle('wallpaper:conversationContext:getConfig', async () => {
    try {
      const svc = conversationContextRef?.current
      return svc
        ? svc.getConfig()
        : { enabled: true, position: 'right', maxTasks: 5, showSummary: true, showTasks: true, showProgress: true }
    } catch {
      return { enabled: true, position: 'right', maxTasks: 5, showSummary: true, showTasks: true, showProgress: true }
    }
  })

  ipcMain.handle('wallpaper:conversationContext:setConfig', async (_event, patch: Record<string, unknown>) => {
    try {
      const svc = conversationContextRef?.current
      if (!svc) return { success: false, error: 'ConversationContextService not initialized' }
      svc.saveConfig(patch as any)
      svc.stop()
      svc.start()
      return { success: true }
    } catch (err: any) {
      log('WARN', 'conversation_context_config_set_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('wallpaper:openConversation', async (_event, conversationId: string) => {
    try {
      agentService
        .processTextInput('打开 ' + conversationId, 'wp_nav_' + Date.now(), 'electron', undefined, undefined, true)
        .catch(() => {})
      log('INFO', 'conversation_navigated', { conversationId })
      return { success: true }
    } catch (err: any) {
      log('WARN', 'conversation_navigate_failed', { conversationId, error: String(err) })
      return { success: false, error: String(err) }
    }
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

  // ── 行为频率计数：获取 Top-N 高频动作 ──
  ipcMain.handle('wallpaper:getTopActions', async (_event, n?: number) => {
    try {
      const actions = behaviorActionCounter.getTopActions(n ?? 2)
      return { success: true, actions, timestamp: Date.now() }
    } catch (err: any) {
      log('WARN', 'wallpaper_get_top_actions_failed', { error: String(err) })
      return { success: false, actions: [], timestamp: Date.now(), error: String(err) }
    }
  })

  // ── 行为频率计数：手动记录一个动作（从渲染进程触发） ──
  ipcMain.handle('wallpaper:recordAction', async (_event, actionId: string) => {
    try {
      behaviorActionCounter.recordAction(actionId)
      return { success: true }
    } catch (err: any) {
      log('WARN', 'wallpaper_record_action_failed', { actionId, error: String(err) })
      return { success: false, error: String(err) }
    }
  })
}
