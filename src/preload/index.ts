import { contextBridge, ipcRenderer } from 'electron'

const electronAPI = {
  closeWindow: (): void => ipcRenderer.send('window:close'),

  transcribe: (audio: ArrayBuffer): Promise<{ text: string; request_id?: string; error?: string }> =>
    ipcRenderer.invoke('asr:transcribe', audio),

  chat: (text: string, requestId?: string): Promise<{ reply?: string; error?: string }> => ipcRenderer.invoke('ai:chat', text, requestId),

  speak: (text: string): Promise<void> => ipcRenderer.invoke('tts:speak', text),

  stopSpeaking: (): Promise<void> => ipcRenderer.invoke('tts:stop'),

  stopConversation: (): Promise<{ success: boolean }> => ipcRenderer.invoke('conversation:stop'),

  getState: (): Promise<{ asr: string; error?: string }> => ipcRenderer.invoke('state:get'),

  getWakeWords: (): Promise<string[]> => ipcRenderer.invoke('config:getWakeWords'),

  onStateUpdate: (callback: (state: Record<string, unknown>) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: Record<string, unknown>) => callback(state)
    ipcRenderer.on('state:update', handler)
    return () => {
      ipcRenderer.removeListener('state:update', handler)
    }
  },

  onAIChunk: (callback: (text: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, text: string) => callback(text)
    ipcRenderer.on('ai:chunk', handler)
    return () => {
      ipcRenderer.removeListener('ai:chunk', handler)
    }
  },

  onTTSAudio: (callback: (filePath: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, filePath: string) => callback(filePath)
    ipcRenderer.on('tts:play_audio', handler)
    return () => {
      ipcRenderer.removeListener('tts:play_audio', handler)
    }
  },

  onTTSBuffer: (callback: (buffer: ArrayBuffer) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, buf: Uint8Array) => callback(buf.buffer as ArrayBuffer)
    ipcRenderer.on('tts:play_audio_buffer', handler)
    return () => {
      ipcRenderer.removeListener('tts:play_audio_buffer', handler)
    }
  },

  onToolStatus: (callback: (status: { type: string; tool: string; message: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: { type: string; tool: string; message: string }) => callback(status)
    ipcRenderer.on('tool:status', handler)
    return () => {
      ipcRenderer.removeListener('tool:status', handler)
    }
  },

  getMessageHistory: (limit?: number): Promise<{ id: string; source: string; role: string; content: string; createdAt: number }[]> =>
    ipcRenderer.invoke('messages:getHistory', limit),

  onMessageNew: (callback: (msg: { id: string; source: string; role: string; content: string; createdAt: number }) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      msg: { id: string; source: string; role: string; content: string; createdAt: number },
    ) => callback(msg)
    ipcRenderer.on('message:new', handler)
    return () => {
      ipcRenderer.removeListener('message:new', handler)
    }
  },

  // Auto-update
  checkUpdate: (): Promise<{ available: boolean; version?: string; error?: string }> => ipcRenderer.invoke('update:check'),

  downloadUpdate: (): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('update:download'),

  installUpdate: (): Promise<{ success: boolean }> => ipcRenderer.invoke('update:install'),

  onUpdateStatus: (callback: (status: Record<string, unknown>) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: Record<string, unknown>) => callback(status)
    ipcRenderer.on('update:status', handler)
    return () => {
      ipcRenderer.removeListener('update:status', handler)
    }
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
