import { useState, useEffect, useCallback, useRef } from 'react'
import { ALL_SETTING_KEYS } from './credentialKeys'

export function useSettings(open: boolean) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [lastSaved, setLastSaved] = useState<number | null>(null)
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    if (!open) return
    Promise.all(
      ALL_SETTING_KEYS.map(async (key) => {
        const v = await window.electronAPI.getCredential(key)
        return [key, v ?? ''] as const
      }),
    ).then((entries) => {
      setValues(Object.fromEntries(entries))
    })
  }, [open])

  const setAndSave = useCallback((key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }))
    setSaving(true)

    const existing = debounceTimers.current.get(key)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(async () => {
      try {
        await window.electronAPI.setCredential(key, value)
        setLastSaved(Date.now())
      } catch {
        // silent
      } finally {
        debounceTimers.current.delete(key)
        if (debounceTimers.current.size === 0) setSaving(false)
      }
    }, 300)
    debounceTimers.current.set(key, timer)
  }, [])

  useEffect(() => {
    return () => {
      for (const t of debounceTimers.current.values()) clearTimeout(t)
    }
  }, [])

  return { values, setAndSave, saving, lastSaved } as const
}
