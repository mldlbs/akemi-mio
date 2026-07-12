import { useIPCEvent } from './useIPCEvent'
import { useDeviceStore } from '../store/deviceStore'

export function useDeviceStatus() {
  const store = useDeviceStore()

  useIPCEvent(window.electronAPI?.onStateUpdate, (s: Record<string, unknown>) => {
    if (s.error) store.setError(s.error as string)
    if (s.ttsPlaying !== undefined) store.setTtsPlaying(s.ttsPlaying as boolean)
    if (s.sessionHealth) store.setSessionHealth(s.sessionHealth as string)
  })

  useIPCEvent(window.electronAPI?.onPersonaUpdated, (data: { level: string }) => {
    store.setPersonaLevel(data.level)
  })

  return {
    active: store.active,
    setActive: store.setActive,
    ttsPlaying: store.ttsPlaying,
    error: store.error,
    setError: store.setError,
    sessionHealth: store.sessionHealth,
    personaLevel: store.personaLevel,
    settingsOpen: store.settingsOpen,
    setSettingsOpen: store.setSettingsOpen,
  } as const
}
