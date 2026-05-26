import { contextBridge, ipcRenderer } from 'electron'

const electronAPI = {
  transcribe: (audio: Float32Array): Promise<{ text: string; duration: number }> =>
    ipcRenderer.invoke('asr:transcribe', audio),

  chat: (text: string): Promise<{ reply?: string; error?: string }> =>
    ipcRenderer.invoke('ai:chat', text),

  speak: (text: string): Promise<void> =>
    ipcRenderer.invoke('tts:speak', text),

  stopSpeaking: (): Promise<void> =>
    ipcRenderer.invoke('tts:stop'),

  getState: (): Promise<{ asr: string }> =>
    ipcRenderer.invoke('state:get'),

  onStateUpdate: (callback: (state: Record<string, unknown>) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: Record<string, unknown>) => callback(state)
    ipcRenderer.on('state:update', handler)
    return () => ipcRenderer.removeListener('state:update', handler)
  }
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
