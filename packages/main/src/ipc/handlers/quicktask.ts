import { ipcMain } from 'electron'
import { log } from '@akemi-mio/core/logger/Logger'
import { quickTaskService } from '@akemi-mio/evolution/behavior/QuickTaskService'
import type { QuickTaskStep } from '@akemi-mio/evolution/behavior/QuickTaskTypes'
import type { HandlerContext } from './context'

export function registerQuickTaskHandlers(_ctx: HandlerContext): void {
  ipcMain.handle('quickTask:getAll', async () => {
    try {
      return { success: true, tasks: quickTaskService.getAllTasks() }
    } catch (err: any) {
      log('ERROR', 'quick_task_get_all_failed', { error: String(err) })
      return { success: false, error: String(err), tasks: [] }
    }
  })
  ipcMain.handle('quickTask:recommendNow', async () => {
    try {
      return { success: true, tasks: quickTaskService.recommendNow() }
    } catch (err: any) {
      log('ERROR', 'quick_task_recommend_now_failed', { error: String(err) })
      return { success: false, error: String(err), tasks: [] }
    }
  })
  ipcMain.handle('quickTask:execute', async (_event, taskId: string) => {
    try {
      const task = quickTaskService.feedback(taskId, 'executed')
      return task ? { success: true, task } : { success: false, error: '任务未找到' }
    } catch (err: any) {
      log('ERROR', 'quick_task_execute_failed', { taskId, error: String(err) })
      return { success: false, error: String(err) }
    }
  })
  ipcMain.handle('quickTask:dismiss', async (_event, taskId: string) => {
    try {
      const task = quickTaskService.feedback(taskId, 'dismissed')
      return task ? { success: true, task } : { success: false, error: '任务未找到' }
    } catch (err: any) {
      log('ERROR', 'quick_task_dismiss_failed', { taskId, error: String(err) })
      return { success: false, error: String(err) }
    }
  })
  ipcMain.handle('quickTask:snooze', async (_event, taskId: string) => {
    try {
      const task = quickTaskService.feedback(taskId, 'snoozed')
      return task ? { success: true, task } : { success: false, error: '任务未找到' }
    } catch (err: any) {
      log('ERROR', 'quick_task_snooze_failed', { taskId, error: String(err) })
      return { success: false, error: String(err) }
    }
  })
  ipcMain.handle('quickTask:edit', async (_event, taskId: string, steps: QuickTaskStep[]) => {
    try {
      const task = quickTaskService.editTask(taskId, steps)
      return task ? { success: true, task } : { success: false, error: '任务未找到' }
    } catch (err: any) {
      log('ERROR', 'quick_task_edit_failed', { taskId, error: String(err) })
      return { success: false, error: String(err) }
    }
  })
  ipcMain.handle('quickTask:getSnapshot', async () => {
    try {
      return { success: true, snapshot: quickTaskService.getSnapshot() }
    } catch (err: any) {
      log('ERROR', 'quick_task_get_snapshot_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })
  ipcMain.handle('quickTask:setSensitivity', async (_event, threshold: number) => {
    try {
      quickTaskService.setSensitivityThreshold(threshold)
      return { success: true }
    } catch (err: any) {
      log('ERROR', 'quick_task_set_sensitivity_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })
  ipcMain.handle('quickTask:analyze', async () => {
    try {
      return { success: true, tasks: quickTaskService.analyze() }
    } catch (err: any) {
      log('ERROR', 'quick_task_analyze_failed', { error: String(err) })
      return { success: false, error: String(err), tasks: [] }
    }
  })
  ipcMain.handle('quickTask:start', async () => {
    try {
      quickTaskService.startAutoRecommend()
      return { success: true }
    } catch (err: any) {
      log('ERROR', 'quick_task_start_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })
  ipcMain.handle('quickTask:stop', async () => {
    try {
      quickTaskService.stopAutoRecommend()
      return { success: true }
    } catch (err: any) {
      log('ERROR', 'quick_task_stop_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })
}
