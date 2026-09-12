import { ipcMain } from 'electron'
import { log } from '@akemi-mio/core/logger/Logger'
import type { HandlerContext } from './context'

export function registerLearningHandlers(_ctx: HandlerContext): void {
  ipcMain.handle('learning:query', async (_event, transcribedText: string) => {
    try {
      const { learningAsrBridge } = await import('@akemi-mio/intelligence-learning/LearningAsrBridge')
      return learningAsrBridge.matchQuery(transcribedText)
    } catch (err) {
      log('ERROR', 'learning_query_failed', { error: String(err) })
      return { matched: false, items: [], categories: [], explanation: String(err), query: transcribedText }
    }
  })

  ipcMain.handle('learning:summary', async () => {
    try {
      const { learningAsrBridge } = await import('@akemi-mio/intelligence-learning/LearningAsrBridge')
      return { summary: learningAsrBridge.getLearningSummary() }
    } catch (err) {
      log('ERROR', 'learning_summary_failed', { error: String(err) })
      return { summary: '' }
    }
  })

  ipcMain.handle('oral:code', async (_event, description: string) => {
    try {
      const { oralCodeService } = await import('@akemi-mio/intelligence-learning/OralCodeService')
      return oralCodeService.process({ description })
    } catch (err) {
      log('ERROR', 'oral_code_failed', { error: String(err) })
      return { success: false, pattern: 'unknown', code: '', explanation: String(err), label: '错误', verification: 'failed' }
    }
  })

  ipcMain.handle('oral:patterns', async () => {
    try {
      const { oralCodeService } = await import('@akemi-mio/intelligence-learning/OralCodeService')
      return { patterns: oralCodeService.getSupportedPatterns() }
    } catch (err) {
      log('ERROR', 'oral_patterns_failed', { error: String(err) })
      return { patterns: [] }
    }
  })
}
