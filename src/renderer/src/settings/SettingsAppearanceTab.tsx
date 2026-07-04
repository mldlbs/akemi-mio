import { useTheme, type ThemeName } from '../hooks/useTheme'

const THEMES = [
  { id: 'mio' as ThemeName, label: 'Mio', icon: '🌸' },
  { id: 'ocean' as ThemeName, label: 'Ocean', icon: '🌊' },
  { id: 'sunset' as ThemeName, label: 'Sunset', icon: '🌅' },
  { id: 'arctic' as ThemeName, label: 'Arctic', icon: '❄️' },
  { id: 'garden' as ThemeName, label: 'Garden', icon: '🌿' },
  { id: 'tech' as ThemeName, label: 'Tech', icon: '⚡' },
  { id: 'minimal' as ThemeName, label: 'Minimal', icon: '◇' },
]

export function SettingsAppearanceTab() {
  const { theme, setTheme } = useTheme()

  return (
    <div className="settings-section">
      <span className="settings-section-title">主题</span>
      <div className="settings-theme-grid">
        {THEMES.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`settings-theme-btn${theme === t.id ? ' active' : ''}`}
            onClick={() => setTheme(t.id)}
          >
            <span className="settings-theme-icon">{t.icon}</span>
            <span className="settings-theme-label">{t.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
