import { useState } from 'react'
import { useIPCEvent } from './useIPCEvent'

export function useDeviceStatus() {
  const [active, setActive] = useState(false)
  const [ttsPlaying, setTtsPlaying] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [sessionHealth, setSessionHealth] = useState('100:HEALTHY:RUNNING')
  const [personaLevel, setPersonaLevel] = useState<string>('core')
  const [settingsOpen, setSettingsOpen] = useState(false)

  useIPCEvent(window.electronAPI.onStateUpdate, (s: Record<string, unknown>) => {
    if (s.error) setError(s.error as string)
    if (s.ttsPlaying !== undefined) setTtsPlaying(s.ttsPlaying as boolean)
    if (s.sessionHealth) setSessionHealth(s.sessionHealth as string)
  })

  useIPCEvent(window.electronAPI.onPersonaUpdated, (data: { level: string }) => {
    setPersonaLevel(data.level)
  })

  return { active, setActive, ttsPlaying, error, setError, sessionHealth, personaLevel, settingsOpen, setSettingsOpen } as const
}
