import { ipcMain, BrowserWindow } from 'electron'
import { log } from '../../logger/Logger'
import { unlinkSync } from 'fs'
import { typographyVerificationService } from '../../typing/TypographyVerificationService'
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
      if (report.audioFile) {
        const wins = BrowserWindow.getAllWindows()
        for (const win of wins) win.webContents.send('tts:play_audio', report.audioFile)
        setTimeout(() => { try { unlinkSync(report.audioFile) } catch {} }, 10000)
      }
      return { success: true, report }
    } catch (err) { log('ERROR', 'typing_verify_failed', { error: String(err) }); return { success: false, error: String(err) } }
  })

  ipcMain.handle('typing:readAloud', async (_event, text: string) => {
    try {
      const result = await typographyVerificationService.readAloud(text)
      if (result.success && result.audioFile) {
        const wins = BrowserWindow.getAllWindows()
        for (const win of wins) win.webContents.send('tts:play_audio', result.audioFile)
        setTimeout(() => { try { unlinkSync(result.audioFile) } catch {} }, 10000)
      }
      return result
    } catch (err) { log('ERROR', 'typing_read_aloud_failed', { error: String(err) }); return { success: false, error: String(err) } }
  })
}
