import { ipcMain } from 'electron'
import { log } from '../../logger/Logger'
import { eventBus } from '../../core/EventBus'
import { planManager as planManagerImport } from '../../evolution'
import { createAgentWindow, closeAgentWindow } from '../../core/Lifecycle'
import type { HandlerContext } from './context'

export function registerAgentHandlers({ agentService, stateManager }: HandlerContext): void {
  ipcMain.handle('ai:chat', async (_event, text: string, requestId?: string, sessionId?: string, noTts?: boolean) => {
    try {
      if (agentService.isPaused()) return { reply: '', error: 'PAUSED' }
      return await agentService.processTextInput(text, requestId, 'electron', undefined, sessionId, noTts)
    } catch (err) { log('ERROR', 'ai_chat_failed', { error: String(err), requestId }); throw err }
  })

  ipcMain.handle('agent:pause', async () => { agentService.pause(); return { success: true } })
  ipcMain.handle('agent:resume', async () => { agentService.resume(); return { success: true } })
  ipcMain.handle('agent:status', async () => ({ paused: agentService.isPaused(), busy: agentService.isBusy() }))

  ipcMain.handle('conversation:stop', async () => {
    try { await agentService.stopConversation(); return { success: true } }
    catch (err) { log('ERROR', 'conversation_stop_failed', { error: String(err) }); return { success: false } }
  })

  ipcMain.handle('state:get', async () => {
    try { return stateManager.get() }
    catch (err) { log('ERROR', 'state_get_failed', { error: String(err) }); return { error: String(err) } }
  })

  // Coding Agent UI
  ipcMain.handle('agent:getActivePlan', async () => { try { return planManagerImport.getActivePlan() ?? null } catch { return null } })
  ipcMain.handle('agent:listPlans', async () => { try { return planManagerImport.listPlans() } catch { return [] } })

  ipcMain.handle('agent:openWindow', async () => {
    try { createAgentWindow(); return { success: true } }
    catch (err) { log('ERROR', 'agent_open_window_failed', { error: String(err) }); return { success: false, error: String(err) } }
  })

  ipcMain.handle('agent:closeWindow', async () => {
    try { closeAgentWindow(); return { success: true } }
    catch { return { success: false } }
  })
}
