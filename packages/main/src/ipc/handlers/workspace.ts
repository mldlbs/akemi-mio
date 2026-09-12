import { log } from '@akemi-mio/core/logger/Logger'
import { ipcMain, dialog } from 'electron'
import {
  getAuthorizedProjectRoots,
  getEffectiveProjectRoot,
  addAuthorizedProjectRoot,
  removeAuthorizedProjectRoot,
  setActiveProjectRoot,
} from '@akemi-mio/core/workspace/project-root'

/**
 * 工作区设置 IPC 处理（多个授权目录）
 */
export function registerWorkspaceHandlers(_ctx: import('../handlers/context').HandlerContext): void {
  ipcMain.handle('workspace:getProjectRoots', async () => {
    return {
      roots: getAuthorizedProjectRoots(),
      active: getEffectiveProjectRoot(),
    }
  })

  ipcMain.handle('workspace:addProjectRoot', async (_event: any, rawPath: string) => {
    const result = addAuthorizedProjectRoot(rawPath)
    if (!result.ok) {
      log('WARN', 'workspace_add_failed', { error: result.error })
      return { success: false, error: result.error }
    }
    return { success: true }
  })

  ipcMain.handle('workspace:removeProjectRoot', async (_event: any, target: string) => {
    try {
      removeAuthorizedProjectRoot(target)
      return { success: true }
    } catch (err: any) {
      log('WARN', 'workspace_remove_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('workspace:setActiveProjectRoot', async (_event: any, target: string) => {
    const result = setActiveProjectRoot(target)
    if (!result.ok) {
      log('WARN', 'workspace_set_active_failed', { error: result.error })
      return { success: false, error: result.error }
    }
    return { success: true }
  })

  ipcMain.handle('workspace:selectProjectRootDialog', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: '选择要授权的项目工作区目录',
    })
    return result.canceled ? null : result.filePaths[0]
  })
}
