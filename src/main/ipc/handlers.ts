import { ipcMain, BrowserWindow } from 'electron'
import { log } from '../logger/Logger'
import { AgentService } from '../agent/AgentService'
import { StateManager } from '../core/StateManager'
import { TtsService } from '../tts/TtsService'

export function registerHandlers(agentService: AgentService, stateManager: StateManager, ttsService: TtsService): void {
  ipcMain.on('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  ipcMain.handle('ai:chat', async (_event, text: string, requestId?: string) => {
    try {
      return await agentService.processTextInput(text, requestId)
    } catch (err) {
      log('ERROR', 'ai_chat_failed', { error: String(err), requestId })
      throw err
    }
  })

  ipcMain.handle('asr:transcribe', async (_event, audioBuffer: ArrayBuffer) => {
    try {
      const asr = agentService.getAsrService()
      if (!asr) throw new Error('ASR service not initialized')
      return await asr.transcribe(audioBuffer)
    } catch (err) {
      log('ERROR', 'asr_transcribe_failed', { error: String(err) })
      throw err
    }
  })

  ipcMain.handle('tts:speak', async (_event, text: string) => {
    try {
      log('PERF', 'tts_speak', { char_count: text.length })
      await ttsService.speak(text)
    } catch (err) {
      log('ERROR', 'tts_speak_failed', { error: String(err) })
      throw err
    }
  })

  ipcMain.handle('tts:stop', async () => {
    try {
      ttsService.stop()
    } catch (err) {
      log('ERROR', 'tts_stop_failed', { error: String(err) })
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
}
