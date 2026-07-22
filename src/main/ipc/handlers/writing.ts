import { ipcMain } from 'electron'
import { log } from '../../logger/Logger'
import { credentialsManager } from '../../credentials/CredentialsManager'
import { audioFeatureExtractor } from '../../audio/AudioFeatureExtractor'
import { atmosphereMapper } from '../../audio/AtmosphereMapper'
import { inspirationService } from '../../writing/InspirationService'
import { voiceContinuationService } from '../../writing/VoiceContinuationService'
import type { HandlerContext } from './context'

export function registerWritingHandlers(_ctx: HandlerContext): void {
  ipcMain.handle('writing:getStatus', async () => {
    const writingApi = credentialsManager.get('writing_api_url') || process.env.WRITING_API_URL || 'https://www.crlkcloud.cyou/writing/api'
    try {
      const res = await fetch(writingApi + '/stories')
      const stories: any[] = await res.json()
      const withScenes = await Promise.all(stories.slice(0, 20).map(async (s) => {
        try { const sr = await fetch(writingApi + '/scenes?storyId=' + s.id); const scenes = await sr.json(); return { id: s.id, title: s.title, genre: s.genre, sceneCount: Array.isArray(scenes) ? scenes.length : 0, createdAt: s.createdAt } }
        catch { return { id: s.id, title: s.title, genre: s.genre, sceneCount: 0, createdAt: s.createdAt } }
      }))
      return { stories: withScenes, totalStories: withScenes.length, totalScenes: withScenes.reduce((a: number, b: any) => a + b.sceneCount, 0) }
    } catch { return { stories: [], totalStories: 0, totalScenes: 0 } }
  })

  ipcMain.handle('audio:analyzeFeatures', async (_event, audioBuffer: ArrayBuffer) => {
    try {
      const samples = new Int16Array(audioBuffer)
      if (samples.length < 512) return { success: false, error: '音频过短，无法提取特征' }
      const features = audioFeatureExtractor.extract(samples)
      return { success: true, features, atmosphere: atmosphereMapper.map(features) }
    } catch (err) { log('ERROR', 'audio_analyze_features_failed', { error: String(err) }); return { success: false, error: String(err) } }
  })

  ipcMain.handle('writing:inspiration:process', async (_event, text: string) => {
    try { return await inspirationService.process(text) }
    catch (err) {
      log('ERROR', 'writing_inspiration_process_failed', { error: String(err) })
      return { rawText: text, entities: { characters: [], events: [], emotions: [], plotTurns: [] }, guidedPrompt: text, processingMs: 0, hasContent: false }
    }
  })

  ipcMain.handle('writing:inspiration:hotwords', async () => {
    try { return { hotwords: inspirationService.getWritingHotwords() } }
    catch (err) { log('ERROR', 'writing_inspiration_hotwords_failed', { error: String(err) }); return { hotwords: [] } }
  })

  ipcMain.handle('writing:continuation:execute', async (_event, params: { storyName: string; chapterNum: number; userVoiceText?: string; atmosphere?: any }) => {
    try {
      const result = await voiceContinuationService.execute(params.storyName, params.chapterNum, params.userVoiceText, params.atmosphere)
      return result
    } catch (err) {
      log('ERROR', 'continuation_execute_failed', { error: String(err), storyName: params.storyName })
      return { success: false, chapterTitle: '第' + params.chapterNum + '章', content: '', sceneId: null, userVoiceText: params.userVoiceText || '', atmosphere: params.atmosphere || null, error: String(err), processingMs: 0 }
    }
  })

  ipcMain.handle('writing:continuation:init', async (_event, params: { storyName: string; chapterNum: number }) => {
    try { return await voiceContinuationService.initializeContext(params.storyName, params.chapterNum) }
    catch (err) {
      log('ERROR', 'continuation_init_failed', { error: String(err), storyName: params.storyName })
      return { storyName: params.storyName, chapterNum: params.chapterNum, storyId: null, previousChapter: null, totalChapters: 0, readerExpectations: '' }
    }
  })
}
