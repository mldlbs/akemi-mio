import { useState, useEffect, useCallback } from 'react'

// =============================================================================
// useBehaviorAwareWallpaper — 行为感知动态壁纸 Hook（增强版）
// =============================================================================
//
// 订阅主进程 UserBehaviorService 推送的增强行为状态（含 mode），
// 结合三种模式（focus / multitasking / break）驱动壁纸行为：
//
//   focus:      隐藏所有装饰，极低透明度 → 最大程度减少干扰
//   multitasking:显示浮动任务切换器，中等透明度
//   break:      隐私淡入 → 逐渐变暗保护屏幕内容
//
// 配置参见 WallpaperConfig。
//

// =============================================================================
// 类型
// =============================================================================

export interface BehaviorState {
  activityState: 'active' | 'idle' | 'away'
  fullscreen: boolean
  focused: boolean
  appCategory: 'code' | 'browser' | 'media' | 'communication' | 'other'
  windowTitle: string
  idleTimeMs: number
  /** 综合行为模式 */
  mode: 'focus' | 'multitasking' | 'break'
  /** 活动情境（coding / browsing / resting） */
  context: 'coding' | 'browsing' | 'resting'
  /** 自适应阈值 */
  thresholds: {
    idleThresholdMs: number
    focusThresholdMs: number
    multitaskingSwitchCount: number
    multitaskingWindowMs: number
    privacyFadeDelayMs: number
  }
  /** 模式持续时长 ms */
  modeDurationMs: number
  /** 模式置信度 0-1 */
  confidence: number
  /** 进入 break 后已过时长 ms */
  breakElapsedMs: number
  /** 最近应用切换 */
  recentSwitches: Array<{
    fromCategory: string
    toCategory: string
  }>
}

export type BehaviorMode = 'focus' | 'multitasking' | 'break'

/** 活动情境 — 综合用户当前窗口类别、空闲状态及行为模式得出 */
export type ActivityContext = 'coding' | 'browsing' | 'resting'

export interface WallpaperConfig {
  enabled: boolean
  idleOverlay: boolean
  adaptiveOpacity: boolean
  normalOpacity: number
  codeOpacity: number
  fullscreenOpacity: number
  idleOpacity: number
  transitionDuration: number
  evoLocked: boolean

  // ── 行为响应式增强配置 ──
  /** 专注模式透明度（override codeOpacity） */
  focusOpacity: number
  /** 多任务模式透明度 */
  multitaskingOpacity: number
  /** 隐私淡入最大透明度（break 模式最终值） */
  privacyMaxOpacity: number
  /** 隐私淡入开始延迟（使用状态机阈值） */
  privacyFadeDelayMs: number
  /** 隐私淡入持续时间 ms */
  privacyFadeDurationMs: number
  /** 是否启用行为模式切换 */
  modeSwitchingEnabled: boolean
  /** 专注时是否隐藏装饰 */
  hideDecorationOnFocus: boolean
  /** break 时是否启用隐私模糊 */
  privacyBlurEnabled: boolean
}

export interface WallpaperState {
  /** 当前壁纸 overlay 透明度 (0-1) */
  opacity: number
  /** 是否应显示 idle 覆层内容 */
  showIdleOverlay: boolean
  /** 当前行为模式 */
  mode: BehaviorMode
  /** 当前活动情境（coding / browsing / resting） */
  context: ActivityContext
  /** 当前行为摘要文本 */
  statusLabel: string
  /** 应用到 html 的 CSS 变量 */
  cssVars: Record<string, string>
  /** 原始行为状态 */
  behavior: BehaviorState | null
  /** 当前生效的配置 */
  config: WallpaperConfig
  /** 是否应隐藏所有装饰（专注模式） */
  hideDecoration: boolean
  /** 隐私淡入程度 0-1（break 模式渐入） */
  privacyFade: number
  /** 是否应显示任务切换器（多任务模式） */
  showTaskSwitcher: boolean
  /** 最近应用切换记录 */
  recentSwitches: Array<{
    fromCategory: string
    toCategory: string
  }>
  /** 行为模式中文标签 */
  modeLabel: string
  /** 情境中文标签 */
  contextLabel: string
  /** 是否显示快捷键指南（coding 情境） */
  showShortcutsGuide: boolean
  /** 是否显示 RSS/信息摘要（browsing 情境） */
  showRssSummary: boolean
  /** 是否显示自然动画背景（resting 情境） */
  showNatureAnimation: boolean
}

// =============================================================================
// 默认值
// =============================================================================

export const DEFAULT_WALLPAPER_CONFIG: WallpaperConfig = {
  enabled: true,
  idleOverlay: true,
  adaptiveOpacity: true,
  normalOpacity: 0.95,
  codeOpacity: 0.25,
  fullscreenOpacity: 0.15,
  idleOpacity: 0.55,
  transitionDuration: 600,
  evoLocked: false,

  // 行为响应式增强
  focusOpacity: 0.15,
  multitaskingOpacity: 0.5,
  privacyMaxOpacity: 0.92,
  privacyFadeDelayMs: 60_000,
  privacyFadeDurationMs: 30_000,
  modeSwitchingEnabled: true,
  hideDecorationOnFocus: true,
  privacyBlurEnabled: true,
}

// =============================================================================
// 模式中文映射
// =============================================================================

const MODE_LABELS: Record<BehaviorMode, string> = {
  focus: '专注模式',
  multitasking: '多任务模式',
  break: '休息模式',
}

const MODE_STATUS_LABELS: Record<BehaviorMode, Record<string, string>> = {
  focus: { default: '专注中 · 最低干扰', code: '编码中 · 深度专注' },
  multitasking: { default: '多任务中', browser: '多任务 · 浏览中' },
  break: { default: '休息中', idle: '空闲中', away: '离开中' },
}

// =============================================================================
// 情境中文映射
// =============================================================================

const CONTEXT_LABELS: Record<ActivityContext, string> = {
  coding: '编程',
  browsing: '浏览',
  resting: '休息',
}

const CONTEXT_HINT_LABELS: Record<ActivityContext, string> = {
  coding: '快捷键指南 · 常用片段',
  browsing: '待办事项 · 信息摘要',
  resting: '放松一下',
}

// =============================================================================
// Hook
// =============================================================================

export function useBehaviorAwareWallpaper(
  customConfig?: Partial<WallpaperConfig>,
): WallpaperState {
  const [behavior, setBehavior] = useState<BehaviorState | null>(null)
  const [config, setConfig] = useState<WallpaperConfig>(() => ({
    ...DEFAULT_WALLPAPER_CONFIG,
    ...customConfig,
  }))

  // ── 从主进程订阅增强行为状态 ──
  useEffect(() => {
    const unsub = window.electronAPI.onBehaviorState((state) => {
      setBehavior({
        activityState: state.activityState as BehaviorState['activityState'],
        fullscreen: state.fullscreen,
        focused: state.focused,
        appCategory: state.appCategory as BehaviorState['appCategory'],
        windowTitle: state.windowTitle,
        idleTimeMs: state.idleTimeMs,
        mode: (state.mode as BehaviorMode) || 'focus',
        context: (state.context as ActivityContext) || 'resting',
        thresholds: state.thresholds || DEFAULT_WALLPAPER_CONFIG,
        modeDurationMs: state.modeDurationMs || 0,
        confidence: state.confidence || 0,
        breakElapsedMs: state.breakElapsedMs || 0,
        recentSwitches: state.recentSwitches || [],
      })
    })
    return unsub
  }, [])

  // ── 首次加载时获取配置 ──
  useEffect(() => {
    window.electronAPI.getWallpaperConfig().then((saved) => {
      if (saved) {
        setConfig((prev) => ({
          ...prev,
          ...saved,
          transitionDuration: DEFAULT_WALLPAPER_CONFIG.transitionDuration,
        }))
      }
    })
  }, [])

  // ── 计算透明度 ──
  const calcOpacity = useCallback(
    (b: BehaviorState | null, cfg: WallpaperConfig): number => {
      if (!b || !cfg.adaptiveOpacity || !cfg.enabled) return cfg.normalOpacity

      // 行为模式驱动的透明度
      if (cfg.modeSwitchingEnabled) {
        switch (b.mode) {
          case 'focus':
            // 专注模式 → 极低透明度
            return Math.min(cfg.focusOpacity, cfg.codeOpacity)
          case 'multitasking':
            // 多任务模式 → 中等透明度（仍能看到壁纸）
            return cfg.multitaskingOpacity
          case 'break':
            // break 模式 → 动态隐私淡入
            return calcBreakOpacity(b, cfg)
        }
      }

      // 兼容旧逻辑（无 mode 时回退）
      if (b.fullscreen && cfg.fullscreenOpacity < 1) {
        return cfg.fullscreenOpacity
      }
      if (b.appCategory === 'code' && cfg.codeOpacity < 1) {
        return cfg.codeOpacity
      }
      if (b.activityState === 'idle' || b.activityState === 'away') {
        return cfg.idleOpacity
      }
      return cfg.normalOpacity
    },
    [],
  )

  // ── Break 模式透明度（隐私淡入） ──
  const calcBreakOpacity = useCallback(
    (b: BehaviorState, cfg: WallpaperConfig): number => {
      // 基础 idle/away 透明度
      const baseOpacity = cfg.idleOpacity

      // 隐私淡入: breakElapsedMs > privacyFadeDelayMs 后开始变暗
      const delay = cfg.privacyFadeDelayMs
      const duration = cfg.privacyFadeDurationMs
      const elapsed = b.breakElapsedMs

      if (elapsed <= delay) {
        // 刚进入 break → 基本 idle 透明度
        return baseOpacity
      }

      // 渐入阶段: 从 baseOpacity → privacyMaxOpacity
      const fadeProgress = Math.min(1, (elapsed - delay) / duration)
      const breakOpacity = baseOpacity + (cfg.privacyMaxOpacity - baseOpacity) * fadeProgress

      // 最终 clip 后平滑过渡
      return Math.min(cfg.privacyMaxOpacity, breakOpacity)
    },
    [],
  )

  // ── 计算隐私淡入程度（用于 CSS 效果） ──
  const calcPrivacyFade = useCallback(
    (b: BehaviorState | null, cfg: WallpaperConfig): number => {
      if (!b || b.mode !== 'break') return 0
      if (!cfg.privacyBlurEnabled) return 0

      const elapsed = b.breakElapsedMs
      const delay = cfg.privacyFadeDelayMs
      if (elapsed <= delay) return 0

      const fadeProgress = Math.min(1, (elapsed - delay) / cfg.privacyFadeDurationMs)
      return fadeProgress
    },
    [],
  )

  // ── 计算是否隐藏所有装饰 ──
  const calcHideDecoration = useCallback(
    (b: BehaviorState | null, cfg: WallpaperConfig): boolean => {
      if (!b || !cfg.hideDecorationOnFocus) return false
      return b.mode === 'focus'
    },
    [],
  )

  // ── 计算是否显示任务切换器 ──
  const calcShowTaskSwitcher = useCallback(
    (b: BehaviorState | null, cfg: WallpaperConfig): boolean => {
      if (!b || !cfg.modeSwitchingEnabled) return false
      return b.mode === 'multitasking' && b.recentSwitches.length > 0
    },
    [],
  )

  // ── 计算是否显示快捷键指南（coding 情境） ──
  const calcShowShortcutsGuide = useCallback(
    (b: BehaviorState | null, cfg: WallpaperConfig): boolean => {
      if (!b || !cfg.enabled) return false
      // 专注模式且 window 标题含 code 关键词 → 编程情境
      return b.context === 'coding' && !cfg.hideDecorationOnFocus
    },
    [],
  )

  // ── 计算是否显示 RSS 摘要面板（browsing 情境） ──
  const calcShowRssSummary = useCallback(
    (b: BehaviorState | null, cfg: WallpaperConfig): boolean => {
      if (!b || !cfg.enabled) return false
      return b.context === 'browsing' && !cfg.hideDecorationOnFocus
    },
    [],
  )

  // ── 计算是否显示自然动画背景（resting 情境） ──
  const calcShowNatureAnimation = useCallback(
    (b: BehaviorState | null, cfg: WallpaperConfig): boolean => {
      if (!b || !cfg.enabled) return false
      // resting 情境且在 break 模式或空闲时才显示
      return b.context === 'resting' &&
        (b.mode === 'break' || b.activityState === 'idle' || b.activityState === 'away')
    },
    [],
  )

  // ── 计算是否需要显示 idle 覆层 ──
  const calcIdleOverlay = useCallback(
    (b: BehaviorState | null, cfg: WallpaperConfig): boolean => {
      if (!cfg.enabled || !cfg.idleOverlay) return false
      if (!b) return false
      // break 模式 + hide 装饰关闭时显示 idle 覆层
      if (b.mode === 'break') return true
      return b.activityState === 'idle' || b.activityState === 'away'
    },
    [],
  )

  // ── 根据状态变化设置 CSS 变量 ──
  useEffect(() => {
    if (!config.enabled) {
      document.documentElement.style.removeProperty('--wallpaper-overlay-opacity')
      document.documentElement.style.removeProperty('--wallpaper-transition-duration')
      document.documentElement.style.removeProperty('--wallpaper-privacy-fade')
      document.documentElement.style.removeProperty('--wallpaper-mode')
      document.documentElement.style.removeProperty('--wallpaper-context')
      return
    }

    const targetOpacity = calcOpacity(behavior, config)
    const transitionSec = config.transitionDuration / 1000

    document.documentElement.style.setProperty(
      '--wallpaper-overlay-opacity',
      String(targetOpacity),
    )
    document.documentElement.style.setProperty(
      '--wallpaper-transition-duration',
      `${transitionSec}s`,
    )

    // 隐私淡入程度
    const fade = calcPrivacyFade(behavior, config)
    document.documentElement.style.setProperty(
      '--wallpaper-privacy-fade',
      String(fade),
    )

    // 当前模式（供 CSS 使用）
    if (behavior) {
      document.documentElement.style.setProperty(
        '--wallpaper-mode',
        `"${behavior.mode}"`,
      )
      document.documentElement.style.setProperty(
        '--wallpaper-context',
        `"${behavior.context}"`,
      )
    }

    // idle 文字颜色
    if (behavior && (behavior.activityState === 'idle' || behavior.activityState === 'away')) {
      document.documentElement.style.setProperty(
        '--wallpaper-idle-text',
        'oklch(0.98 0.002 12)',
      )
    } else {
      document.documentElement.style.removeProperty('--wallpaper-idle-text')
    }
  }, [behavior, config, calcOpacity, calcPrivacyFade])

  // ── 生成状态摘要 ──
  const statusLabel = useCallback((): string => {
    if (!behavior) return '等待中…'

    const mode = behavior.mode

    // mode 特有标签
    if (mode === 'focus') {
      if (behavior.appCategory === 'code') return MODE_STATUS_LABELS.focus.code
      return MODE_STATUS_LABELS.focus.default
    }
    if (mode === 'multitasking') {
      if (behavior.appCategory === 'browser') return MODE_STATUS_LABELS.multitasking.browser
      return MODE_STATUS_LABELS.multitasking.default
    }
    if (mode === 'break') {
      if (behavior.activityState === 'away') return MODE_STATUS_LABELS.break.away
      if (behavior.activityState === 'idle') return MODE_STATUS_LABELS.break.idle
      return MODE_STATUS_LABELS.break.default
    }

    // 后备
    if (behavior.fullscreen) return '全屏模式 · 低干扰'
    if (behavior.appCategory === 'code') return '编码中 · 低干扰'
    if (behavior.activityState === 'away') return '离开中'
    if (behavior.activityState === 'idle') return '空闲中'
    return '活跃中'
  }, [behavior])

  // ── 模式中文标签 ──
  const modeLabel = behavior
    ? MODE_LABELS[behavior.mode] || MODE_LABELS.focus
    : MODE_LABELS.focus

  // ── 情境中文标签 ──
  const contextLabel = behavior
    ? CONTEXT_LABELS[behavior.context] || CONTEXT_LABELS.resting
    : CONTEXT_LABELS.resting

  // ── 计算状态 ──
  const computed = behavior
    ? {
        opacity: calcOpacity(behavior, config),
        showIdleOverlay: calcIdleOverlay(behavior, config),
        mode: behavior.mode,
        context: behavior.context,
        hideDecoration: calcHideDecoration(behavior, config),
        privacyFade: calcPrivacyFade(behavior, config),
        showTaskSwitcher: calcShowTaskSwitcher(behavior, config),
        recentSwitches: behavior.recentSwitches,
        showShortcutsGuide: calcShowShortcutsGuide(behavior, config),
        showRssSummary: calcShowRssSummary(behavior, config),
        showNatureAnimation: calcShowNatureAnimation(behavior, config),
      }
    : {
        opacity: config.normalOpacity,
        showIdleOverlay: false,
        mode: 'focus' as BehaviorMode,
        context: 'resting' as ActivityContext,
        hideDecoration: false,
        privacyFade: 0,
        showTaskSwitcher: false,
        recentSwitches: [],
        showShortcutsGuide: false,
        showRssSummary: false,
        showNatureAnimation: false,
      }

  return {
    ...computed,
    statusLabel: statusLabel(),
    cssVars: {},
    behavior,
    config,
    modeLabel,
    contextLabel,
  }
}
