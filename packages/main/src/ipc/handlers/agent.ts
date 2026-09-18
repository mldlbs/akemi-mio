import { ipcMain } from 'electron'
import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import { planManager as planManagerImport } from '@akemi-mio/evolution'
import { createAgentWindow, closeAgentWindow } from '@akemi-mio/core/core/Lifecycle'
import type { HandlerContext } from './context'

export function registerAgentHandlers({ agentService, stateManager }: HandlerContext): void {
  ipcMain.handle('ai:chat', async (_event, text: string, requestId?: string, sessionId?: string, noTts?: boolean) => {
    try {
      if (agentService.isPaused()) return { reply: '', error: 'PAUSED' }
      return await agentService.processTextInput(text, requestId, 'electron', undefined, sessionId, noTts)
    } catch (err) {
      log('ERROR', 'ai_chat_failed', { error: String(err), requestId })
      throw err
    }
  })

  // agent:resume / agent:status 保留 —— scripts/cdp-trigger-round3.mjs 用它们
  // 从异常状态里把 agent 拉回来。agent:pause 已删除：窗口关闭刻意不再 pause
  // （见 window.ts），全仓没有任何地方调它，留着只会误导人去调。
  ipcMain.handle('agent:resume', async () => {
    agentService.resume()
    return { success: true }
  })
  ipcMain.handle('agent:status', async () => ({ paused: agentService.isPaused(), busy: agentService.isBusy() }))

  ipcMain.handle('conversation:stop', async () => {
    try {
      await agentService.stopConversation()
      return { success: true }
    } catch (err) {
      log('ERROR', 'conversation_stop_failed', { error: String(err) })
      return { success: false }
    }
  })

  ipcMain.handle('state:get', async () => {
    try {
      return stateManager.get()
    } catch (err) {
      log('ERROR', 'state_get_failed', { error: String(err) })
      return { error: String(err) }
    }
  })

  // Coding Agent UI
  ipcMain.handle('agent:getActivePlan', async () => {
    try {
      return planManagerImport.getActivePlan() ?? null
    } catch {
      return null
    }
  })
  ipcMain.handle('agent:listPlans', async () => {
    try {
      return planManagerImport.listPlans()
    } catch {
      return []
    }
  })

  ipcMain.handle('agent:openWindow', async () => {
    try {
      createAgentWindow()
      return { success: true }
    } catch (err) {
      log('ERROR', 'agent_open_window_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('agent:closeWindow', async () => {
    try {
      closeAgentWindow()
      return { success: true }
    } catch {
      return { success: false }
    }
  })
}
