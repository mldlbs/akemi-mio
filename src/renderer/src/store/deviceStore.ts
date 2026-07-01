import { create } from 'zustand'

interface DeviceState {
  active: boolean
  ttsPlaying: boolean
  error: string | undefined
  sessionHealth: string
  personaLevel: string
  settingsOpen: boolean
}

interface DeviceActions {
  setActive: (active: boolean) => void
  setTtsPlaying: (playing: boolean) => void
  setError: (error: string | undefined) => void
  setSessionHealth: (health: string) => void
  setPersonaLevel: (level: string) => void
  setSettingsOpen: (open: boolean) => void
}

type DeviceStore = DeviceState & DeviceActions

export const useDeviceStore = create<DeviceStore>((set) => ({
  active: false,
  ttsPlaying: false,
  error: undefined,
  sessionHealth: '100:HEALTHY:RUNNING',
  personaLevel: 'core',
  settingsOpen: false,

  setActive: (active) => set({ active }),
  setTtsPlaying: (ttsPlaying) => set({ ttsPlaying }),
  setError: (error) => set({ error }),
  setSessionHealth: (sessionHealth) => set({ sessionHealth }),
  setPersonaLevel: (personaLevel) => set({ personaLevel }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
}))
