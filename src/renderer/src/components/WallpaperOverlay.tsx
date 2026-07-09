import { useState, useEffect, useCallback } from 'react'
import { useBehaviorAwareWallpaper } from '../hooks/useBehaviorAwareWallpaper'
import { useFocusScore } from '../hooks/useFocusScore'
import { BehaviorDash } from './BehaviorDash'
import { TaskSwitcher } from './TaskSwitcher'
import { WallpaperWidgetHost } from '../widgets/WallpaperWidgetHost'
import { wallpaperWidgetRegistry } from '../widgets/WallpaperWidgetRegistry'
import { registerAllWidgets } from '../widgets/plugins'
import type { MonitoringData, WallpaperWidgetContext } from '../widgets/types'

// =============================================================================
// WallpaperOverlay — 行为感知壁纸覆层（增强版）
// =============================================================================
//
// 根据用户活动状态自适应调整透明度和显示内容。
// 支持三种行为模式:
//
//   专注模式 focus:     隐藏所有装饰，极低透明度 → 最大程度减少干扰
//   多任务 multitasking: 显示浮动任务切换器，中等透明度
//   休息 break:         隐私淡入保护屏幕内容
//
// 行为:
//   - 透明覆盖层，通过 CSS 变量控制整体透明度
//   - 空闲时显示浅色信息面板（时间 + 待办事项 + 进化状态）
//   - 全屏/编码时大幅降低透明度，最大限度减少视觉干扰
//   - 过渡动画由 CSS transition 控制
//   - 右下角显示自进化系统状态（阶段、进度、资源占用）
//   - 提供锁定开关阻止进化系统修改壁纸
//   - Widget 插件系统：面板组件通过 IWallpaperWidget 接口注册，
//     由 WallpaperWidgetHost 统一渲染（模式来源: Memory IMemoryPlugin）
//
// =============================================================================

// ── 简易天气数据 ──
interface WeatherData {
  temp: string
  condition: string
  icon: string
}

// =============================================================================
// 子组件: 锁定开关
// =============================================================================

function LockToggle({
  locked,
  onToggle,
}: {
  locked: boolean
  onToggle: (locked: boolean) => void
}) {
  return (
    <button
      className={`wp-lock-btn ${locked ? 'wp-lock-btn--locked' : ''}`}
      onClick={() => onToggle(!locked)}
      title={locked ? '壁纸已锁定，禁止进化修改' : '壁纸未锁定，允许进化优化'}
    >
      {locked ? '🔒' : '🔓'}
    </button>
  )
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
  const [monitoring, setMonitoring] = useState<MonitoringData | null>(null)
  const [evoLocked, setEvoLocked] = useState(config.evoLocked)
  const [showMonPanel, setShowMonPanel] = useState(true)

  // ── Widget 插件初始化（模式来源: Memory UnifiedMemoryQuery.registerPlugin） ──
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

  // ── 订阅监控指标推送 ──
  useEffect(() => {
    const unsub = window.electronAPI.onMonitoringMetrics((data) => {
      setMonitoring(data)
      setEvoLocked(data.evoLocked)
    })
    return unsub
  }, [])

  // ── 订阅 CSS 热重载 ──
  useEffect(() => {
    const unsub = window.electronAPI.onWallpaperStylesUpdated((css, filename) => {
      const styleId = filename
        ? `wp-hot-reload-${filename.replace(/\.css$/, '')}`
        : 'wp-evo-hot-reload'
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

  // ── 锁定切换 ──
  const handleLockToggle = useCallback(async (locked: boolean) => {
    try {
      const result = await window.electronAPI.setEvoLock(locked)
      if (result.success) {
        setEvoLocked(result.locked)
      }
    } catch {}
  }, [])

  // ── 监控面板折叠切换 ──
  const toggleMonPanel = useCallback(() => {
    setShowMonPanel((prev) => !prev)
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

  // ── 构建 Widget 上下文（模式来源: Memory IMemoryPlugin.retrieve 中的 query context） ──
  const widgetCtx: WallpaperWidgetContext = {
    mode,
    context,
    config,
    behavior,
    monitoring,
    evoLocked,
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

  // 隐私淡入：break 模式下增加深色背景层
  if (privacyFade > 0) {
    overlayStyle.background = `oklch(0 0 0 / ${privacyFade * 0.6})`
  }

  return (
    <div className={overlayClasses} style={overlayStyle}>
      {/* ── 隐私模糊层（break 模式 + 隐私淡入启用） ── */}
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
      {behavior && (
        <WallpaperWidgetHost zone="badge" ctx={widgetCtx} />
      )}

      {/* ── Decoration 区（自然动画等装饰性元素） ── */}
      {!hideDecoration && (
        <WallpaperWidgetHost zone="decoration" ctx={widgetCtx} />
      )}

      {/* ── Overlay 区（快捷键指南、信息摘要等上下文面板） ── */}
      {!hideDecoration && (
        <WallpaperWidgetHost zone="overlay" ctx={widgetCtx} />
      )}

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

          {/* 计划进度（空闲时也显示） */}
          {monitoring?.plan?.hasActivePlan && (
            <WallpaperWidgetHost zone="monitor" ctx={widgetCtx} />
          )}
        </div>
      )}

      {/* ── 多任务任务切换器（多任务模式显示） ── */}
      {showTaskSwitcher && (
        <TaskSwitcher switches={recentSwitches} visible={true} />
      )}

      {/* ── 右下角监控面板（专注模式隐藏） ── */}
      {monitoring && showMonPanel && !hideDecoration && (
        <div className="wp-mon-panel">
          {/* 折叠按钮 */}
          <button className="wp-mon-toggle" onClick={toggleMonPanel} title="折叠监控面板">
            <span className="wp-mon-toggle-icon">▼</span>
          </button>

          {/* 锁定开关 */}
          <LockToggle locked={evoLocked} onToggle={handleLockToggle} />

          {/* 监控区 Widget（进化状态、计划进度、系统资源等） */}
          <WallpaperWidgetHost zone="monitor" ctx={widgetCtx} />

          {/* 最近文件变更（本地 UI 逻辑，保持内联） */}
          {monitoring.recentChanges.length > 0 && (
            <div className="wp-changes-panel">
              <div className="wp-changes-title">最近变更</div>
              {monitoring.recentChanges.slice(0, 3).map((change, i) => (
                <div key={i} className="wp-change-item">
                  <span className={`wp-change-type wp-change-type--${change.type}`}>
                    {change.type === 'new' ? '+' : change.type === 'deleted' ? '-' : '~'}
                  </span>
                  <span className="wp-change-file" title={change.filePath}>
                    {change.filePath.split('/').pop() || change.filePath}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── 折叠状态：仅显示锁定状态和活动指示器（专注模式隐藏） ── */}
      {monitoring && !showMonPanel && !hideDecoration && (
        <div className="wp-mon-collapsed">
          <button className="wp-mon-toggle wp-mon-toggle--collapsed" onClick={toggleMonPanel} title="展开监控面板">
            <span className="wp-mon-toggle-icon">▲</span>
          </button>
          <LockToggle locked={evoLocked} onToggle={handleLockToggle} />
          {monitoring.evolution && monitoring.evolution.stage !== 'idle' && (
            <span
              className="wp-mon-dot"
              style={{
                background:
                  monitoring.evolution.stage === 'collecting' || monitoring.evolution.stage === 'analyzing'
                    ? '#60a5fa'
                    : monitoring.evolution.stage === 'fixing'
                    ? '#f59e0b'
                    : monitoring.evolution.stage === 'verifying'
                    ? '#22c55e'
                    : monitoring.evolution.stage === 'cooldown'
                    ? '#f97316'
                    : monitoring.evolution.stage === 'error'
                    ? '#ef4444'
                    : '#888',
              }}
              title={monitoring.evolution.stage}
            />
          )}
        </div>
      )}

      {/* ── 状态标签 ── */}
      <div className="wallpaper-status-label">
        {evoLocked && '🔒 '}{statusLabel}
      </div>

      {/* ── 行为专注仪表盘（专注模式隐藏） ── */}
      {focus.config.enabled && !hideDecoration && <BehaviorDash focus={focus} />}
    </div>
  )
}
