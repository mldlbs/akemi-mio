import { ipcMain, BrowserWindow } from 'electron'
import { log } from '@akemi-mio/core/logger/Logger'
import { unlinkSync } from 'fs'
import { typographyVerificationService } from '@akemi-mio/audio/typing/TypographyVerificationService'
import type { HandlerContext } from './context'

export function registerTypingHandlers({ agentService }: HandlerContext): void {
  ipcMain.handle('typing:verify', async (_event, formattedText: string) => {
    try {
      const asr = agentService.getAsrService()
      typographyVerificationService.setTranscribeFn(async (pcmInt16: Int16Array) => {
        const result = await asr.transcribe(pcmInt16.buffer as ArrayBuffer)
        return result.text
      })
      const report = await typographyVerificationService.verify(formattedText)
      const audioFile = report.audioFile
      if (audioFile) {
        const wins = BrowserWindow.getAllWindows()
        for (const win of wins) win.webContents.send('tts:play_audio', audioFile)
        setTimeout(() => {
          try {
            unlinkSync(audioFile)
          } catch {}
        }, 10000)
      }
      return { success: true, report }
    } catch (err) {
      log('ERROR', 'typing_verify_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('typing:readAloud', async (_event, text: string) => {
    try {
      const result = await typographyVerificationService.readAloud(text)
      const audioFile2 = result.success ? result.audioFile : undefined
      if (audioFile2) {
        const wins = BrowserWindow.getAllWindows()
        for (const win of wins) win.webContents.send('tts:play_audio', audioFile2)
        setTimeout(() => {
          try {
            unlinkSync(audioFile2)
          } catch {}
        }, 10000)
      }
      return result
    } catch (err) {
      log('ERROR', 'typing_read_aloud_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })
}
