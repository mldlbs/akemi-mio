/**
 * wallpaperInteractionStore — 壁纸交互模式 Zustand Store
 *
 * 管理壁纸 overlay 中 Agent 交互面板的状态：
 * - interactive: 是否处于交互模式（由 Ctrl+Space 切换）
 * - messages: 对话消息历史
 * - status: Agent 处理状态
 * - enabled: 功能是否启用
 *
 * 与 main/wallpaper/WallpaperInteractiveService 通过 IPC 通信。
 */

import { create } from 'zustand'

// =============================================================================
// 类型定义
// =============================================================================

export interface WallpaperChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
}

export type WallpaperInteractionStatus = 'idle' | 'processing'

// =============================================================================
// Store
// =============================================================================

interface WallpaperInteractionState {
  /** 是否处于交互模式 */
  interactive: boolean
  /** 对话消息历史 */
  messages: WallpaperChatMessage[]
  /** Agent 处理状态 */
  status: WallpaperInteractionStatus
  /** 功能是否启用 */
  enabled: boolean
  /** 快捷键字符串（展示用） */
  shortcut: string
}

interface WallpaperInteractionActions {
  /** 切换交互模式 */
  setInteractive: (active: boolean) => void
  /** 切换（取反） */
  toggleInteractive: () => void
  /** 添加消息到历史 */
  addMessage: (msg: WallpaperChatMessage) => void
  /** 清空消息历史 */
  clearMessages: () => void
  /** 设置处理状态 */
  setStatus: (status: WallpaperInteractionStatus) => void
  /** 设置功能启用状态 */
  setEnabled: (enabled: boolean) => void
  /** 从主进程加载配置 */
  loadConfig: () => Promise<void>
  /** 重置所有状态 */
  reset: () => void
}

type WallpaperInteractionStore = WallpaperInteractionState & WallpaperInteractionActions

const initialState: WallpaperInteractionState = {
  interactive: false,
  messages: [],
  status: 'idle',
  enabled: true,
  shortcut: 'CommandOrControl+Space',
}

export const useWallpaperInteractionStore = create<WallpaperInteractionStore>((set) => ({
  ...initialState,

  setInteractive: (active) => set({ interactive: active }),

  toggleInteractive: () => set((s) => ({ interactive: !s.interactive })),

  addMessage: (msg) =>
    set((s) => {
      const messages = [...s.messages, msg]
      // 保留最近 N 条消息，防止内存膨胀
      if (messages.length > 50) {
        return { messages: messages.slice(-50) }
      }
      return { messages }
    }),

  clearMessages: () => set({ messages: [] }),

  setStatus: (status) => set({ status }),

  setEnabled: (enabled) => set({ enabled }),

  loadConfig: async () => {
    try {
      const config = await window.electronAPI.getWallpaperInteractiveConfig()
      set({ enabled: config.enabled, shortcut: config.shortcut })
    } catch {
      // 降级使用默认值
    }
  },

  reset: () => set(initialState),
}))
