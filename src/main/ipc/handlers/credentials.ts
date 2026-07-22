import { ipcMain } from 'electron'
import { log } from '../../logger/Logger'
import { credentialsManager } from '../../credentials/CredentialsManager'
import { WAKE_WORDS } from '../../config'
import type { HandlerContext } from './context'

export function registerCredentialsHandlers({ agentService, ttsService }: HandlerContext): void {
  ipcMain.handle('credentials:list', async () => credentialsManager.list())
  ipcMain.handle('credentials:getAll', async () => credentialsManager.getAll())
  ipcMain.handle('credentials:get', async (_event, name: string) => credentialsManager.get(name))

  ipcMain.handle('credentials:set', async (_event, name: string, value: string) => {
    credentialsManager.set(name, value)
    if (name.startsWith('llm_')) {
      try { agentService.getLlmService().refreshFromCredentials((k) => credentialsManager.get(k)); log('INFO', 'llm_config_refreshed_from_ui', { changed: name }) }
      catch (err) { log('WARN', 'llm_config_refresh_failed', { error: String(err) }) }
    }
    if (name === 'tts_mode') {
      const pref = value === 'cloud' ? 'cloud' : value === 'local' ? 'local' : 'auto'
      ttsService.setEnginePreference(pref as any)
      log('INFO', 'tts_mode_credential_synced', { value, preference: pref })
    }
    return true
  })

  ipcMain.handle('credentials:delete', async (_event, name: string) => { credentialsManager.delete(name); return true })
  ipcMain.handle('config:getWakeWords', async () => WAKE_WORDS)
}
