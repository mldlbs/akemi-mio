import { ipcMain } from 'electron'
import { log } from '../../logger/Logger'
import { workflowStore } from '../../workflow/WorkflowStoreV2'
import { getWorkflowScheduler } from '../../workflow/WorkflowScheduler'
import type { HandlerContext } from './context'

export function registerWorkflowHandlers(_ctx: HandlerContext): void {
  ipcMain.handle('workflow:listDefinitions', async () => { try { return workflowStore.listDefinitions() } catch { return [] } })
  ipcMain.handle('workflow:getDefinition', async (_event, id: string) => { try { return workflowStore.getDefinition(id) } catch { return null } })
  ipcMain.handle('workflow:listRuns', async (_event, limit?: number) => { try { return workflowStore.listRuns(limit) } catch { return [] } })
  ipcMain.handle('workflow:getRun', async (_event, runId: string) => { try { return workflowStore.getRun(runId) } catch { return null } })
  ipcMain.handle('workflow:saveDefinition', async (_event, def: any) => { try { workflowStore.saveDefinition(def); return { success: true } } catch { return { success: false } } })
  ipcMain.handle('workflow:deleteDefinition', async (_event, id: string) => { try { return { success: workflowStore.deleteDefinition(id) } } catch { return { success: false } } })

  ipcMain.handle('workflow:startWorkflow', async (_event, id: string, userInput?: string) => {
    try {
      log('INFO', 'workflow_startWorkflow_called', { id, userInput })
      const def = workflowStore.getDefinition(id)
      if (!def) return { success: false, error: '工作流不存在' }
      if (def.enabled === false) return { success: false, error: '工作流已停用，请先启用' }
      const scheduler = getWorkflowScheduler()
      const run = scheduler.startRun(def, userInput)
      return { success: true, runId: run.runId }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  ipcMain.handle('workflow:stopRun', async (_event, runId: string) => {
    try { const ok = getWorkflowScheduler().stopRun(runId); return { success: ok, error: ok ? undefined : '运行未找到或已结束' } }
    catch (err: any) { return { success: false, error: err.message } }
  })

  ipcMain.handle('workflow:enableDefinition', async (_event, id: string) => {
    try {
      const existing = workflowStore.getDefinition(id)
      if (!existing) return { success: false, error: '工作流不存在' }
      if (existing.enabled !== false) return { success: false, error: '已经是启用状态' }
      workflowStore.saveDefinition({ ...existing, enabled: true, updatedAt: Date.now() })
      return { success: true }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  ipcMain.handle('workflow:disableDefinition', async (_event, id: string) => {
    try {
      const existing = workflowStore.getDefinition(id)
      if (!existing) return { success: false, error: '工作流不存在' }
      if (existing.enabled === false) return { success: false, error: '已经是停用状态' }
      workflowStore.saveDefinition({ ...existing, enabled: false, updatedAt: Date.now() })
      return { success: true }
    } catch (err: any) { return { success: false, error: err.message } }
  })

  ipcMain.handle('workflow:duplicateDefinition', async (_event, id: string) => {
    try { return { success: !!workflowStore.duplicateDefinition(id), error: workflowStore.duplicateDefinition(id) ? undefined : '工作流不存在' } }
    catch (err: any) { return { success: false, error: err.message } }
  })

  ipcMain.handle('workflow:deleteRun', async (_event, runId: string) => {
    try { const ok = workflowStore.deleteRun(runId); return { success: ok, error: ok ? undefined : '运行记录不存在' } }
    catch (err: any) { return { success: false, error: err.message } }
  })

  ipcMain.handle('workflow:approveGate', async (_event, runId: string, stepId: string, decision: string, modifiedInput?: string) => {
    try { const ok = getWorkflowScheduler().approveGate(runId, stepId, decision, modifiedInput); return { success: ok, error: ok ? undefined : '审批请求不存在' } }
    catch (err: any) { return { success: false, error: err.message } }
  })
}
