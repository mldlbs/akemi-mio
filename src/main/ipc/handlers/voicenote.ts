/**
 * VoiceNote IPC — 语音便签壁纸 IPC 处理器
 *
 * 提供主进程与渲染进程之间的语音便签通信通道。
 * 通过 HandlerContext 中的 voiceNoteRef 访问 VoiceNoteService。
 */

import { ipcMain } from 'electron'
import { log } from '../../logger/Logger'
import type { HandlerContext } from './context'

export function registerVoiceNoteHandlers({ voiceNoteRef }: HandlerContext): void {
  // ── 切换录音状态 ──
  ipcMain.handle('voicenote:toggle', async () => {
    const svc = voiceNoteRef?.current
    if (!svc) return { success: false, state: null }
    const state = svc.toggle()
    log('INFO', 'voicenote_ipc_toggle', { enabled: state.enabled })
    return { success: true, state }
  })

  // ── 获取状态 ──
  ipcMain.handle('voicenote:getState', async () => {
    const svc = voiceNoteRef?.current
    if (!svc) return { success: false, state: null }
    return { success: true, state: svc.getState() }
  })

  // ── 设置文本 ──
  ipcMain.handle('voicenote:setText', async (_event, text: string) => {
    const svc = voiceNoteRef?.current
    if (!svc) return { success: false }
    svc.setText(text)
    return { success: true }
  })

  // ── 追加文本 ──
  ipcMain.handle('voicenote:appendText', async (_event, text: string) => {
    const svc = voiceNoteRef?.current
    if (!svc) return { success: false }
    svc.appendText(text)
    return { success: true }
  })

  // ── 清空文本 ──
  ipcMain.handle('voicenote:clear', async () => {
    const svc = voiceNoteRef?.current
    if (!svc) return { success: false }
    svc.clear()
    return { success: true }
  })

  // ── 复制到剪贴板 ──
  ipcMain.handle('voicenote:copy', async () => {
    const svc = voiceNoteRef?.current
    if (!svc) return { success: false }
    const ok = svc.copy()
    return { success: ok }
  })

  // ── 保存为笔记 ──
  ipcMain.handle('voicenote:save', async () => {
    const svc = voiceNoteRef?.current
    if (!svc) return { success: false, error: 'Service not initialized' }
    const result = await svc.save()
    return result
  })

  // ── 设置显示模式 ──
  ipcMain.handle('voicenote:setDisplayMode', async (_event, mode: 'fixed' | 'scroll') => {
    const svc = voiceNoteRef?.current
    if (!svc) return { success: false }
    svc.setDisplayMode(mode)
    return { success: true }
  })
}
