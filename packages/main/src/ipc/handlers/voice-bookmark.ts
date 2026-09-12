import { ipcMain } from 'electron'
import { log } from '@akemi-mio/core/logger/Logger'
import type { HandlerContext } from './context'

export function registerVoiceBookmarkHandlers({ voiceBookmarkRef }: HandlerContext): void {
  if (!voiceBookmarkRef) return

  ipcMain.handle('voice-bookmark:create', async (_event, summary: string, conversationContext: any[], options?: any) => {
    try {
      const svc = voiceBookmarkRef.current
      if (!svc) return { success: false, error: 'VoiceBookmarkService not initialized' }
      const bookmark = await svc.createBookmark(summary, conversationContext, options)
      if (!bookmark) return { success: false, error: '创建书签失败' }
      return {
        success: true,
        bookmark: {
          id: bookmark.id,
          summary: bookmark.summary,
          audioPath: bookmark.audioPath,
          createdAt: bookmark.bookmarkedAt,
          isFavorite: bookmark.isFavorite,
        },
      }
    } catch (err: any) {
      log('ERROR', 'voice_bookmark_create_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('voice-bookmark:get', async (_event, id: string) => {
    try {
      const svc = voiceBookmarkRef.current
      if (!svc) return { success: false, error: 'VoiceBookmarkService not initialized' }
      const bookmark = svc.getBookmark(id)
      if (!bookmark) return { success: false, error: '书签未找到' }
      return { success: true, bookmark }
    } catch (err: any) {
      log('ERROR', 'voice_bookmark_get_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('voice-bookmark:delete', async (_event, id: string) => {
    try {
      const svc = voiceBookmarkRef.current
      if (!svc) return { success: false, error: 'VoiceBookmarkService not initialized' }
      return { success: await svc.deleteBookmark(id), error: undefined }
    } catch (err: any) {
      log('ERROR', 'voice_bookmark_delete_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('voice-bookmark:getAudioPath', async (_event, id: string) => {
    try {
      const svc = voiceBookmarkRef.current
      if (!svc) return { success: false, error: 'VoiceBookmarkService not initialized' }
      const audioPath = svc.getAudioPath(id)
      if (!audioPath) return { success: false, error: '音频文件未找到' }
      return { success: true, audioPath }
    } catch (err: any) {
      log('ERROR', 'voice_bookmark_audiopath_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('voice-bookmark:toggleFavorite', async (_event, id: string) => {
    try {
      const svc = voiceBookmarkRef.current
      if (!svc) return { success: false, error: 'VoiceBookmarkService not initialized' }
      const toggled = svc.toggleFavorite(id)
      return { success: toggled, isFavorite: toggled ? svc.getBookmark(id)?.isFavorite : undefined }
    } catch (err: any) {
      log('ERROR', 'voice_bookmark_toggle_favorite_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('voice-bookmark:favorites', async () => {
    try {
      const svc = voiceBookmarkRef.current
      if (!svc) return { success: false, bookmarks: [], error: 'VoiceBookmarkService not initialized' }
      return { success: true, bookmarks: svc.getFavorites() }
    } catch (err: any) {
      log('ERROR', 'voice_bookmark_favorites_failed', { error: String(err) })
      return { success: false, bookmarks: [], error: String(err) }
    }
  })

  // Blog voice
  ipcMain.handle('blog:saveAudio', async (_event, audio: ArrayBuffer, type: string, options?: any) => {
    try {
      const { blogVoiceService } = await import('@akemi-mio/blog')
      await blogVoiceService.initialize()
      const entry = await blogVoiceService.saveAudio(audio, type as 'dictation' | 'annotation', {
        sessionId: options?.sessionId,
        paragraphIndex: options?.paragraphIndex,
        durationSec: options?.durationSec,
        transcribedText: options?.transcribedText,
        label: options?.label,
      })
      if (entry)
        return {
          success: true,
          entry: {
            id: entry.id,
            type: entry.type,
            durationSec: entry.durationSec,
            transcribedText: entry.transcribedText,
            createdAt: entry.createdAt,
          },
        }
      return { success: false, error: '保存失败' }
    } catch (err: any) {
      log('ERROR', 'blog_save_audio_failed', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('blog:listAudio', async (_event, type?: string, limit?: number) => {
    try {
      const { blogVoiceService } = await import('@akemi-mio/blog')
      await blogVoiceService.initialize()
      return blogVoiceService.listAudio(type as any, limit ?? 50)
    } catch (err: any) {
      log('ERROR', 'blog_list_audio_failed', { error: String(err) })
      return []
    }
  })

  ipcMain.handle('blog:getAudio', async (_event, entryId: string) => {
    try {
      const { blogVoiceService } = await import('@akemi-mio/blog')
      await blogVoiceService.initialize()
      const audioPath = blogVoiceService.getAudioPath(entryId)
      if (audioPath) return { success: true, audioPath }
      return { success: false, error: '音频条目未找到' }
    } catch (err: any) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('blog:deleteAudio', async (_event, entryId: string) => {
    try {
      const { blogVoiceService } = await import('@akemi-mio/blog')
      await blogVoiceService.initialize()
      return { success: await blogVoiceService.deleteAudio(entryId), error: undefined }
    } catch (err: any) {
      return { success: false, error: String(err) }
    }
  })
}
