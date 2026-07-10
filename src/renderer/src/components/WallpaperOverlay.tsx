import { useState, useEffect } from 'react'
import { useBehaviorAwareWallpaper } from '../hooks/useBehaviorAwareWallpaper'
import { useFocusScore } from '../hooks/useFocusScore'
import { BehaviorDash } from './BehaviorDash'
import { TaskSwitcher } from './TaskSwitcher'
import { WallpaperWidgetHost } from '../widgets/WallpaperWidgetHost'
import { wallpaperWidgetRegistry } from '../widgets/WallpaperWidgetRegistry'
import { registerAllWidgets } from '../widgets/plugins'
import type { WallpaperWidgetContext } from '../widgets/types'

// =============================================================================
// WallpaperOverlay — 行为感知壁纸覆层（精简版）
// =============================================================================
//
// 根据用户活动状态自适应调整透明度和显示内容。
// 支持三种行为模式:
//   专注模式 focus:     隐藏所有装饰，极低透明度
//   多任务 multitasking: 显示浮动任务切换器，中等透明度
//   休息 break:         隐私淡入保护屏幕内容
//
// 监控面板已移入 SystemDock 组件。
//
// =============================================================================

// ── 简易天气数据 ──
interface WeatherData {
  temp: string
  condition: string
  icon: string
}

// =============================================================================
// 主组件
// =============================================================================

export function WallpaperOverlay() {
  const {
    opacity,
    showIdleOverlay,
    statusLabel,
    config,
    behavior,
    mode,
    context,
    hideDecoration,
    privacyFade,
    showTaskSwitcher,
    recentSwitches,
    modeLabel,
    contextLabel,
  } = useBehaviorAwareWallpaper()

  const focus = useFocusScore(behavior)
  const [currentTime, setCurrentTime] = useState(new Date())
  const [weather, setWeather] = useState<WeatherData | null>(null)

  // ── Widget 插件初始化 ──
  useEffect(() => {
    registerAllWidgets()
    return () => {
      wallpaperWidgetRegistry.clear()
    }
  }, [])

  // ── 时钟 ──
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 30_000)
    return () => clearInterval(timer)
  }, [])

  // ── 从凭据存储读取天气数据 ──
  useEffect(() => {
    const loadWeather = async () => {
      try {
        const temp = await window.electronAPI.getCredential('wallpaper_weather_temp')
        const condition = await window.electronAPI.getCredential('wallpaper_weather_condition')
        const icon = await window.electronAPI.getCredential('wallpaper_weather_icon')
        if (temp && condition) {
          setWeather({ temp, condition, icon: icon || '🌤️' })
        }
      } catch {}
    }
    loadWeather()
  }, [])

  // ── 订阅 CSS 热重载 ──
  useEffect(() => {
    const unsub = window.electronAPI.onWallpaperStylesUpdated((css, filename) => {
      const styleId = filename ? `wp-hot-reload-${filename.replace(/\.css$/, '')}` : 'wp-evo-hot-reload'
      let styleEl = document.getElementById(styleId) as HTMLStyleElement
      if (!styleEl) {
        styleEl = document.createElement('style')
        styleEl.id = styleId
        document.head.appendChild(styleEl)
      }
      styleEl.textContent = css
    })
    return unsub
  }, [])

  if (!config.enabled) return null

  // ── 格式化时间 ──
  const timeStr = currentTime.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })
  const dateStr = currentTime.toLocaleDateString('zh-CN', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })

  // ── 构建 Widget 上下文 ──
  const widgetCtx: WallpaperWidgetContext = {
    mode,
    context,
    config,
    behavior,
    monitoring: null,
    evoLocked: false,
    hideDecoration,
    opacity,
    privacyFade,
    modeLabel,
    contextLabel,
  }

  // ── Overlay CSS class ──
  const overlayClasses = [
    'wallpaper-overlay',
    mode === 'focus' ? 'wp-mode-focus' : '',
    mode === 'multitasking' ? 'wp-mode-multitasking' : '',
    mode === 'break' && privacyFade > 0 ? 'wp-mode-break-privacy' : '',
    hideDecoration ? 'wp-hide-decoration' : '',
  ]
    .filter(Boolean)
    .join(' ')

  // ── Overlay style（含隐私淡入） ──
  const overlayStyle: React.CSSProperties = {
    opacity,
    transition: `opacity var(--wallpaper-transition-duration, 0.6s) ease`,
  }

  if (privacyFade > 0) {
    overlayStyle.background = `oklch(0 0 0 / ${privacyFade * 0.6})`
  }

  return (
    <div className={overlayClasses} style={overlayStyle}>
      {/* ── 隐私模糊层（break 模式） ── */}
      {privacyFade > 0 && config.privacyBlurEnabled && (
        <div
          className="wp-privacy-blur"
          style={{
            opacity: privacyFade,
            backdropFilter: `blur(${privacyFade * 16}px)`,
            WebkitBackdropFilter: `blur(${privacyFade * 16}px)`,
          }}
        />
      )}

      {/* ── Badge 区（模式徽章 + 情境标签） ── */}
      {behavior && <WallpaperWidgetHost zone="badge" ctx={widgetCtx} />}

      {/* ── Decoration 区（自然动画等装饰性元素） ── */}
      {!hideDecoration && <WallpaperWidgetHost zone="decoration" ctx={widgetCtx} />}

      {/* ── Overlay 区（快捷键指南等上下文面板） ── */}
      {!hideDecoration && <WallpaperWidgetHost zone="overlay" ctx={widgetCtx} />}

      {/* ── 空闲信息面板（专注模式隐藏） ── */}
      {showIdleOverlay && !hideDecoration && (
        <div className="wallpaper-idle-panel">
          {/* 时间 */}
          <div className="wallpaper-time">{timeStr}</div>
          <div className="wallpaper-date">{dateStr}</div>

          {/* 天气 */}
          {weather && (
            <div className="wallpaper-weather">
              <span className="wallpaper-weather-icon">{weather.icon}</span>
              <span className="wallpaper-weather-temp">{weather.temp}</span>
              <span className="wallpaper-weather-condition">{weather.condition}</span>
            </div>
          )}

          {/* 行为专注仪表盘 */}
          {focus.config.enabled && <BehaviorDash focus={focus} />}
        </div>
      )}

      {/* ── 多任务任务切换器 ── */}
      {showTaskSwitcher && <TaskSwitcher switches={recentSwitches} visible={true} />}

      {/* ── 状态标签 ── */}
      <div className="wallpaper-status-label">{statusLabel}</div>
    </div>
  )
}
