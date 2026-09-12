import { ipcMain } from 'electron'
import { log } from '@akemi-mio/core/logger/Logger'
import { getRecentMessages, getSessions, getMessagesBySession } from '@akemi-mio/core/db/messages'
import { checkForUpdates, downloadUpdate, quitAndInstall } from '@akemi-mio/updater/UpdaterService'
import type { HandlerContext } from './context'

export function registerMessagesHandlers(_ctx: HandlerContext): void {
  ipcMain.handle('messages:getHistory', async (_event, limit?: number) => {
    try {
      return await getRecentMessages(limit ?? 200)
    } catch (err) {
      log('ERROR', 'get_history_failed', { error: String(err) })
      return []
    }
  })

  ipcMain.handle('messages:getSessions', async () => {
    try {
      return await getSessions()
    } catch (err) {
      log('ERROR', 'get_sessions_failed', { error: String(err) })
      return []
    }
  })

  ipcMain.handle('messages:getBySession', async (_event, sessionId: string) => {
    try {
      return await getMessagesBySession(sessionId)
    } catch (err) {
      log('ERROR', 'get_by_session_failed', { error: String(err), sessionId })
      return []
    }
  })

  ipcMain.handle('update:check', async () => {
    try {
      return await checkForUpdates()
    } catch (err) {
      log('ERROR', 'update_check_ipc_failed', { error: String(err) })
      return { available: false, error: String(err) }
    }
  })

  ipcMain.handle('update:download', async () => {
    try {
      downloadUpdate()
      return { success: true }
    } catch (err) {
      log('ERROR', 'update_download_ipc_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('update:install', async () => {
    quitAndInstall()
    return { success: true }
  })
}
