/**
 * VoiceNoteService — 语音便签壁纸服务
 *
 * 主进程服务，管理语音便签的状态、全局快捷键、剪贴板和托盘协调。
 *
 * 功能：
 *   1. 全局快捷键 Ctrl+Shift+V 切换录音状态
 *   2. 状态管理（启用/禁用、文本缓存、显示模式）
 *   3. 剪贴板复制（copy）
 *   4. 保存为笔记（save — 写入文件 + 剪贴板）
 *   5. 状态广播到渲染进程（voicenote:state-changed）
 *   6. 托盘菜单回调注册
 */

import { globalShortcut, BrowserWindow, clipboard } from 'electron'
import { log } from '../logger/Logger'
import { WORKSPACE_ROOT } from '../config/index'
import { join } from 'path'
import { promises as fsp } from 'fs'
import { credentialsManager } from '../credentials/CredentialsManager'

// =============================================================================
// 类型定义
// =============================================================================

export interface VoiceNoteState {
  /** 是否启用（录音中） */
  enabled: boolean
  /** 当前文本内容 */
  text: string
  /** 显示模式：fixed（固定替换）/ scroll（滚动追加） */
  displayMode: 'fixed' | 'scroll'
  /** 是否正在保存 */
  saving: boolean
  /** 最后保存时间戳 */
  lastSavedAt: number | null
}

// =============================================================================
// 默认状态
// =============================================================================

const DEFAULT_STATE: VoiceNoteState = {
  enabled: false,
  text: '',
  displayMode: 'fixed',
  saving: false,
  lastSavedAt: null,
}

// =============================================================================
// 服务类
// =============================================================================

export class VoiceNoteService {
  private state: VoiceNoteState = { ...DEFAULT_STATE }
  private winRef: (() => BrowserWindow | null) | null = null
  private toggleCb: (() => void) | null = null

  /** 设置主窗口引用（用于发送 IPC 事件到渲染进程） */
  setWindowRef(ref: () => BrowserWindow | null): void {
    this.winRef = ref
  }

  /** 注册托盘切换回调 */
  setToggleCallback(cb: () => void): void {
    this.toggleCb = cb
  }

  /** 启动服务：注册全局快捷键 */
  start(): void {
    // 注册全局快捷键 Ctrl+Shift+V 切换语音便签
    const registered = globalShortcut.register('CommandOrControl+Shift+V', () => {
      this.toggle()
    })
    if (registered) {
      log('INFO', 'voicenote_global_shortcut_registered', { shortcut: 'CmdOrCtrl+Shift+V' })
    } else {
      log('WARN', 'voicenote_global_shortcut_registration_failed', { shortcut: 'CmdOrCtrl+Shift+V' })
    }
  }

  /** 停止服务：注销全局快捷键 */
  destroy(): void {
    globalShortcut.unregister('CommandOrControl+Shift+V')
  }

  // ── 状态管理 ──

  /** 切换录音状态 */
  toggle(): VoiceNoteState {
    this.state.enabled = !this.state.enabled
    if (!this.state.enabled) {
      this.state.text = ''
      this.state.saving = false
    }
    log('INFO', 'voicenote_toggle', { enabled: this.state.enabled })
    this.broadcastState()
    return this.getState()
  }

  /** 设置文本内容 */
  setText(text: string): void {
    this.state.text = text
    this.broadcastState()
  }

  /** 追加文本（scroll 模式） */
  appendText(text: string): void {
    if (this.state.text) {
      this.state.text += '\n' + text
    } else {
      this.state.text = text
    }
    this.broadcastState()
  }

  /** 清空文本 */
  clear(): void {
    this.state.text = ''
    this.state.saving = false
    log('INFO', 'voicenote_clear')
    this.broadcastState()
  }

  /** 复制文本到剪贴板 */
  copy(): boolean {
    if (!this.state.text) return false
    clipboard.writeText(this.state.text)
    log('INFO', 'voicenote_copy', { length: this.state.text.length })
    return true
  }

  /** 设置显示模式 */
  setDisplayMode(mode: 'fixed' | 'scroll'): void {
    this.state.displayMode = mode
    // 切换到 fixed 时清空历史
    if (mode === 'fixed') {
      this.state.text = ''
    }
    log('INFO', 'voicenote_display_mode', { mode })
    this.broadcastState()
  }

  /**
   * 保存为笔记
   * 1. 复制到剪贴板
   * 2. 写入 notes 目录
   * 3. 清空当前文本
   */
  async save(): Promise<{ success: boolean; path?: string; error?: string }> {
    if (!this.state.text) {
      return { success: false, error: 'No text to save' }
    }

    this.state.saving = true
    this.broadcastState()

    try {
      // 复制到剪贴板
      this.copy()

      // 写入笔记文件
      const notesDir = join(WORKSPACE_ROOT, 'notes')
      await fsp.mkdir(notesDir, { recursive: true })

      const timestamp = Date.now()
      const dateStr = new Date(timestamp).toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const filePath = join(notesDir, `voicenote_${dateStr}.md`)

      await fsp.writeFile(
        filePath,
        `# 语音便签\n\n> ${new Date(timestamp).toLocaleString('zh-CN')}\n\n${this.state.text}\n`,
        'utf-8',
      )

      this.state.text = ''
      this.state.saving = false
      this.state.lastSavedAt = timestamp

      log('INFO', 'voicenote_saved', { path: filePath })
      this.broadcastState()

      return { success: true, path: filePath }
    } catch (err) {
      this.state.saving = false
      this.broadcastState()
      const msg = String(err)
      log('ERROR', 'voicenote_save_failed', { error: msg })
      return { success: false, error: msg }
    }
  }

  /** 获取当前状态 */
  getState(): VoiceNoteState {
    return { ...this.state }
  }

  // ── 内部方法 ──

  /** 广播状态到渲染进程 */
  private broadcastState(): void {
    const win = this.winRef?.()
    if (win && !win.isDestroyed()) {
      win.webContents.send('voicenote:state-changed', this.getState())
    }
  }
}
