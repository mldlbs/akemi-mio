import { useState, useEffect, useCallback } from 'react'
import { useTheme, type ThemeName } from '../hooks/useTheme'
import { DEFAULT_FOCUS_CONFIG, type FocusScoreConfig } from '../hooks/useFocusScore'

const THEMES = [
  { id: 'mio' as ThemeName, label: 'Mio', icon: '🌸' },
  { id: 'ocean' as ThemeName, label: 'Ocean', icon: '🌊' },
  { id: 'sunset' as ThemeName, label: 'Sunset', icon: '🌅' },
  { id: 'arctic' as ThemeName, label: 'Arctic', icon: '❄️' },
  { id: 'garden' as ThemeName, label: 'Garden', icon: '🌿' },
  { id: 'tech' as ThemeName, label: 'Tech', icon: '⚡' },
  { id: 'minimal' as ThemeName, label: 'Minimal', icon: '◇' },
]

interface WallpaperSettings {
  enabled: boolean
  idleOverlay: boolean
  adaptiveOpacity: boolean
  normalOpacity: number
  codeOpacity: number
  fullscreenOpacity: number
  idleOpacity: number
}

const DEFAULT_WP: WallpaperSettings = {
  enabled: true,
  idleOverlay: true,
  adaptiveOpacity: true,
  normalOpacity: 0.95,
  codeOpacity: 0.25,
  fullscreenOpacity: 0.15,
  idleOpacity: 0.55,
}

const LS_FOCUS_KEY = 'mio_focus_dash_config'

function loadFocusConfig(): FocusScoreConfig {
  try {
    const stored = localStorage.getItem(LS_FOCUS_KEY)
    if (stored) {
      return { ...DEFAULT_FOCUS_CONFIG, ...JSON.parse(stored) }
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_FOCUS_CONFIG }
}

function saveFocusConfig(config: FocusScoreConfig) {
  localStorage.setItem(LS_FOCUS_KEY, JSON.stringify(config))
}

export function SettingsAppearanceTab() {
  const { theme, setTheme } = useTheme()
  const [wp, setWp] = useState<WallpaperSettings>(DEFAULT_WP)
  const [loaded, setLoaded] = useState(false)
  const [focusConfig, setFocusConfig] = useState<FocusScoreConfig>(() => loadFocusConfig())
  const [evoDashboardEnabled, setEvoDashboardEnabled] = useState(true)
  const [evoDashboardOpacity, setEvoDashboardOpacity] = useState(0.85)

  // ── 加载壁纸配置 ──
  useEffect(() => {
    window.electronAPI.getWallpaperConfig().then((saved) => {
      if (saved) {
        setWp((prev) => ({ ...prev, ...saved }))
      }
      setLoaded(true)
    })
    // 加载实时仪表盘配置
    window.electronAPI.getEvolutionDashboardLiveConfig().then((cfg) => {
      setEvoDashboardEnabled(cfg.enabled)
      setEvoDashboardOpacity(cfg.opacity)
    }).catch(() => {})
  }, [])

  // ── 保存单项配置 ──
  const updateWp = useCallback(
    (patch: Partial<WallpaperSettings>) => {
      const next = { ...wp, ...patch }
      setWp(next)
      window.electronAPI.setWallpaperConfig(patch)
    },
    [wp],
  )

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

      {/* ── 行为感知壁纸 ── */}
      {loaded && (
        <>
          <hr className="wp-divider" />

          <span className="settings-section-title">行为感知壁纸</span>

          {/* 总开关 */}
          <div className="wallpaper-settings-toggle">
            <span className="wallpaper-settings-toggle-label">启用壁纸覆层</span>
            <input
              type="checkbox"
              className="wp-toggle-switch"
              checked={wp.enabled}
              onChange={(e) => updateWp({ enabled: e.target.checked })}
            />
          </div>

          {wp.enabled && (
            <div className="wallpaper-settings-section">
              {/* 自适应透明度 */}
              <div className="wallpaper-settings-toggle">
                <span className="wallpaper-settings-toggle-label">自适应透明度</span>
                <input
                  type="checkbox"
                  className="wp-toggle-switch"
                  checked={wp.adaptiveOpacity}
                  onChange={(e) => updateWp({ adaptiveOpacity: e.target.checked })}
                />
              </div>

              {wp.adaptiveOpacity && (
                <>
                  <div className="wallpaper-settings-slider-row">
                    <label>编码透明度</label>
                    <input
                      type="range"
                      min="0.05"
                      max="1.0"
                      step="0.05"
                      value={wp.codeOpacity}
                      onChange={(e) => updateWp({ codeOpacity: parseFloat(e.target.value) })}
                    />
                    <span className="wallpaper-settings-slider-value">
                      {Math.round(wp.codeOpacity * 100)}%
                    </span>
                  </div>

                  <div className="wallpaper-settings-slider-row">
                    <label>全屏透明度</label>
                    <input
                      type="range"
                      min="0.05"
                      max="1.0"
                      step="0.05"
                      value={wp.fullscreenOpacity}
                      onChange={(e) => updateWp({ fullscreenOpacity: parseFloat(e.target.value) })}
                    />
                    <span className="wallpaper-settings-slider-value">
                      {Math.round(wp.fullscreenOpacity * 100)}%
                    </span>
                  </div>

                  <div className="wallpaper-settings-slider-row">
                    <label>空闲透明度</label>
                    <input
                      type="range"
                      min="0.05"
                      max="1.0"
                      step="0.05"
                      value={wp.idleOpacity}
                      onChange={(e) => updateWp({ idleOpacity: parseFloat(e.target.value) })}
                    />
                    <span className="wallpaper-settings-slider-value">
                      {Math.round(wp.idleOpacity * 100)}%
                    </span>
                  </div>

                  <div className="wallpaper-settings-slider-row">
                    <label>正常透明度</label>
                    <input
                      type="range"
                      min="0.2"
                      max="1.0"
                      step="0.05"
                      value={wp.normalOpacity}
                      onChange={(e) => updateWp({ normalOpacity: parseFloat(e.target.value) })}
                    />
                    <span className="wallpaper-settings-slider-value">
                      {Math.round(wp.normalOpacity * 100)}%
                    </span>
                  </div>
                </>
              )}

              {/* 空闲覆层 */}
              <div className="wallpaper-settings-toggle">
                <span className="wallpaper-settings-toggle-label">空闲时显示信息</span>
                <input
                  type="checkbox"
                  className="wp-toggle-switch"
                  checked={wp.idleOverlay}
                  onChange={(e) => updateWp({ idleOverlay: e.target.checked })}
                />
              </div>
            </div>
          )}

          <hr className="wp-divider" />

          {/* ── 专注仪表盘 ── */}
          <span className="settings-section-title">专注仪表盘</span>

          <div className="wallpaper-settings-toggle">
            <span className="wallpaper-settings-toggle-label">启用专注仪表盘</span>
            <input
              type="checkbox"
              className="wp-toggle-switch"
              checked={focusConfig.enabled}
              onChange={(e) => {
                const next = { ...focusConfig, enabled: e.target.checked }
                setFocusConfig(next)
                saveFocusConfig(next)
              }}
            />
          </div>

          <hr className="wp-divider" />

          {/* ── 自进化实时仪表盘 ── */}
          <span className="settings-section-title">自进化实时仪表盘</span>

          <div className="wallpaper-settings-toggle">
            <span className="wallpaper-settings-toggle-label">启用实时仪表盘</span>
            <input
              type="checkbox"
              className="wp-toggle-switch"
              checked={evoDashboardEnabled}
              onChange={(e) => {
                const v = e.target.checked
                setEvoDashboardEnabled(v)
                window.electronAPI.setEvolutionDashboardLiveConfig({ enabled: v })
              }}
            />
          </div>

          {evoDashboardEnabled && (
            <div className="wallpaper-settings-section">
              <div className="wallpaper-settings-slider-row">
                <label>仪表盘透明度</label>
                <input
                  type="range"
                  min="0.1"
                  max="1.0"
                  step="0.05"
                  value={evoDashboardOpacity}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value)
                    setEvoDashboardOpacity(v)
                    window.electronAPI.setEvolutionDashboardLiveConfig({ opacity: v })
                  }}
                />
                <span className="wallpaper-settings-slider-value">
                  {Math.round(evoDashboardOpacity * 100)}%
                </span>
              </div>
              <div className="wallpaper-settings-toggle" style={{ marginTop: 8 }}>
                <span className="wallpaper-settings-toggle-label" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  鼠标穿透默认启用（仅展示，不干扰操作）
                </span>
              </div>
            </div>
          )}

          <hr className="wp-divider" />

          {/* ── 专注仪表盘 ── */}
          <span className="settings-section-title">专注仪表盘</span>

          <div className="wallpaper-settings-toggle">
            <span className="wallpaper-settings-toggle-label">启用专注仪表盘</span>
            <input
              type="checkbox"
              className="wp-toggle-switch"
              checked={focusConfig.enabled}
              onChange={(e) => {
                const next = { ...focusConfig, enabled: e.target.checked }
                setFocusConfig(next)
                saveFocusConfig(next)
              }}
            />
          </div>

          {focusConfig.enabled && (
            <div className="wallpaper-settings-section">
              <div className="wallpaper-settings-slider-row">
                <label>高分阈值</label>
                <input
                  type="range"
                  min="50"
                  max="95"
                  step="5"
                  value={focusConfig.highThreshold}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10)
                    const next = { ...focusConfig, highThreshold: v, mediumThreshold: Math.min(focusConfig.mediumThreshold, v - 5) }
                    setFocusConfig(next)
                    saveFocusConfig(next)
                  }}
                />
                <span className="wallpaper-settings-slider-value">{focusConfig.highThreshold}</span>
              </div>

              <div className="wallpaper-settings-slider-row">
                <label>中分阈值</label>
                <input
                  type="range"
                  min="20"
                  max={focusConfig.highThreshold - 5}
                  step="5"
                  value={focusConfig.mediumThreshold}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10)
                    const next = { ...focusConfig, mediumThreshold: v }
                    setFocusConfig(next)
                    saveFocusConfig(next)
                  }}
                />
                <span className="wallpaper-settings-slider-value">{focusConfig.mediumThreshold}</span>
              </div>

              <div className="wallpaper-settings-slider-row">
                <label>休息提醒（分钟）</label>
                <input
                  type="range"
                  min="5"
                  max="30"
                  step="5"
                  value={focusConfig.restReminderAfterMs / 60_000}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10)
                    const next = { ...focusConfig, restReminderAfterMs: v * 60_000 }
                    setFocusConfig(next)
                    saveFocusConfig(next)
                  }}
                />
                <span className="wallpaper-settings-slider-value">
                  {focusConfig.restReminderAfterMs / 60_000}分钟
                </span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
