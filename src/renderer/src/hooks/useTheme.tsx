import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'

export type ThemeName = 'mio' | 'ocean' | 'sunset' | 'arctic' | 'garden' | 'tech' | 'minimal'

interface ThemeContextValue {
  theme: ThemeName
  setTheme: (t: ThemeName) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeName>('mio')

  useEffect(() => {
    if (!window.electronAPI) return
    window.electronAPI.getCredential('theme').then((stored) => {
      if (stored === null) return
      const t =
        stored === 'mio' ||
        stored === 'ocean' ||
        stored === 'sunset' ||
        stored === 'arctic' ||
        stored === 'garden' ||
        stored === 'tech' ||
        stored === 'minimal'
          ? stored
          : 'mio'
      setThemeState(t)
      document.documentElement.dataset.theme = t
    })
  }, [])

  const setTheme = useCallback((t: ThemeName) => {
    setThemeState(t)
    document.documentElement.dataset.theme = t
    window.electronAPI?.setCredential('theme', t).catch(() => {})
  }, [])

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
