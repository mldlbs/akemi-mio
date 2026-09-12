import { useEffect, type CSSProperties } from 'react'
import { useBehaviorAwareWallpaper } from '../hooks/useBehaviorAwareWallpaper'

/**
 * Keeps the behavior-aware wallpaper atmospheric.
 *
 * UI-bearing wallpaper widgets belong in the workbench drawer or the chat
 * surface, never in a persistent layer above the application.
 */
export function WallpaperOverlay() {
  const { opacity, config, mode, hideDecoration, privacyFade } = useBehaviorAwareWallpaper()

  useEffect(() => {
    const subscribe = window.electronAPI?.onWallpaperStylesUpdated
    if (!subscribe) return

    return subscribe((css, filename) => {
      const styleId = filename ? `wp-hot-reload-${filename.replace(/\.css$/, '')}` : 'wp-evo-hot-reload'
      let styleEl = document.getElementById(styleId) as HTMLStyleElement | null
      if (!styleEl) {
        styleEl = document.createElement('style')
        styleEl.id = styleId
        document.head.appendChild(styleEl)
      }
      styleEl.textContent = css
    })
  }, [])

  if (!config.enabled || privacyFade <= 0) return null

  const overlayClasses = [
    'wallpaper-overlay',
    mode === 'focus' ? 'wp-mode-focus' : '',
    mode === 'multitasking' ? 'wp-mode-multitasking' : '',
    hideDecoration ? 'wp-hide-decoration' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const overlayStyle: CSSProperties = {
    opacity,
    transition: `opacity var(--wallpaper-transition-duration, 0.6s) ease`,
    background: privacyFade > 0 ? `oklch(0 0 0 / ${privacyFade * 0.6})` : undefined,
  }

  return <div className={overlayClasses} style={overlayStyle} aria-hidden="true" />
}
