/**
 * VoiceWallpaperWidget — 语音动态壁纸 Widget
 *
 * 在桌面壁纸层渲染实时语音可视化和情感驱动的粒子动画。
 * 通过 Canvas 2D 引擎显示 FFT 频谱波形，并根据 TTS 情感标签动态调节背景色调和粒子效果。
 *
 * 功能：
 *   1. 订阅 TTS 语音状态（通过 IPC tts:voice-state）
 *   2. 从 audioShared 读取实时 FFT 频谱数据
 *   3. 三种可视化风格：频谱柱状图 / 声波涟漪 / 粒子律动
 *   4. 情感驱动的色彩方案和粒子特效
 *   5. 用户可配置透明度、触发模式、风格
 *   6. 鼠标穿透（pointer-events: none）
 *
 * 区：decoration（装饰区，与 NarrativeWallpaperWidget 同级）
 * 可见性：仅在 TTS 播放时或 triggerMode='always' 时显示
 */

import React, { useRef, useEffect, useCallback, useState } from 'react'
import type { IWallpaperWidgetDefinition, WallpaperWidgetContext } from '../types'
import { useVoiceState } from './voice-wallpaper/useVoiceState'
import { VoiceVisualizer } from './voice-wallpaper/VoiceVisualizer'
import { DEFAULT_VOICE_WALLPAPER_CONFIG } from './voice-wallpaper/types'
import type { VoiceWallpaperConfig, VisualStyle, TriggerMode } from './voice-wallpaper/types'

// =============================================================================
// 渲染帧控制
// =============================================================================

/** 空闲时跳帧数 */
const IDLE_FRAME_SKIP = 4

// =============================================================================
// 配置面板
// =============================================================================

function ConfigPanel({
  config,
  onConfigChange,
}: {
  config: VoiceWallpaperConfig
  onConfigChange: (patch: Partial<VoiceWallpaperConfig>) => void
}) {
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        padding: '6px 12px',
        background: 'var(--corner-float-paper)',
        border: '1px solid var(--corner-float-border, oklch(0.58 0.014 92 / 0.13))',
        borderRadius: 8,
        fontSize: 12,
        color: 'var(--corner-float-ink)',
        zIndex: 9999,
        pointerEvents: 'auto',
        backdropFilter: 'none',
        boxShadow: 'var(--corner-float-shadow, 0 10px 26px oklch(0.24 0.018 92 / 0.055))',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* 风格选择 */}
      <select
        value={config.style}
        onChange={(e) => onConfigChange({ style: e.target.value as VisualStyle })}
        style={{
          background: 'var(--bg-glass)',
          color: 'var(--corner-float-ink)',
          border: '1px solid var(--border-hairline, oklch(0.56 0.014 92 / 0.14))',
          borderRadius: 4,
          padding: '2px 6px',
          fontSize: 11,
        }}
      >
        <option value="spectrum">频谱</option>
        <option value="ripple">涟漪</option>
        <option value="particle">粒子</option>
      </select>

      {/* 触发模式 */}
      <select
        value={config.triggerMode}
        onChange={(e) => onConfigChange({ triggerMode: e.target.value as TriggerMode })}
        style={{
          background: 'var(--bg-glass)',
          color: 'var(--corner-float-ink)',
          border: '1px solid var(--border-hairline, oklch(0.56 0.014 92 / 0.14))',
          borderRadius: 4,
          padding: '2px 6px',
          fontSize: 11,
        }}
      >
        <option value="tts_only">仅语音</option>
        <option value="always">持续</option>
      </select>

      {/* 透明度滑块 */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        透明度
        <input
          type="range"
          min="0.1"
          max="1"
          step="0.1"
          value={config.opacity}
          onChange={(e) => onConfigChange({ opacity: parseFloat(e.target.value) })}
          style={{ width: 60 }}
        />
      </label>

      {/* 开关 */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input type="checkbox" checked={config.enabled} onChange={(e) => onConfigChange({ enabled: e.target.checked })} />
        启用
      </label>
    </div>
  )
}

// =============================================================================
// Canvas 组件
// =============================================================================

function VoiceCanvas({
  config,
  showConfig,
  onConfigChange,
}: {
  config: VoiceWallpaperConfig
  showConfig: boolean
  onConfigChange: (patch: Partial<VoiceWallpaperConfig>) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visualizerRef = useRef<VoiceVisualizer | null>(null)
  const rafRef = useRef<number>(0)
  const lastTimeRef = useRef<number>(0)
  const frameCountRef = useRef<number>(0)
  const { state } = useVoiceState({ config })

  // ── 初始化渲染器 ──
  useEffect(() => {
    visualizerRef.current = new VoiceVisualizer()
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      visualizerRef.current?.reset()
      visualizerRef.current = null
    }
  }, [])

  // ── 渲染循环 ──
  const renderFrame = useCallback(
    (timestamp: number) => {
      const visualizer = visualizerRef.current
      const canvas = canvasRef.current
      if (!visualizer || !canvas) return

      const dt = lastTimeRef.current === 0 ? 0.016 : (timestamp - lastTimeRef.current) / 1000
      lastTimeRef.current = timestamp

      // 空闲时降低帧率
      frameCountRef.current++
      const isActive = state.isPlaying
      if (!isActive && frameCountRef.current % IDLE_FRAME_SKIP !== 0) {
        rafRef.current = requestAnimationFrame(renderFrame)
        return
      }

      // 更新并渲染
      visualizer.update(config, state)
      const ctx = canvas.getContext('2d')
      if (ctx) {
        visualizer.render(ctx, config, state)
      }

      rafRef.current = requestAnimationFrame(renderFrame)
    },
    [config, state],
  )

  // ── 启动/停止渲染循环 ──
  useEffect(() => {
    const visualizer = visualizerRef.current
    const canvas = canvasRef.current
    if (!visualizer || !canvas) return

    // 设置尺寸
    const resize = () => {
      if (canvas) {
        const dpr = window.devicePixelRatio || 1
        const rect = canvas.getBoundingClientRect()
        canvas.width = rect.width * dpr
        canvas.height = rect.height * dpr
        const ctx = canvas.getContext('2d')
        if (ctx) ctx.scale(dpr, dpr)
        visualizer.setSize(rect.width, rect.height)
      }
    }
    resize()
    window.addEventListener('resize', resize)

    // 启动循环
    lastTimeRef.current = 0
    rafRef.current = requestAnimationFrame(renderFrame)

    return () => {
      window.removeEventListener('resize', resize)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [renderFrame])

  return (
    <>
      <canvas
        ref={canvasRef}
        className="voice-wallpaper-canvas"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          pointerEvents: 'none',
          zIndex: 0,
          opacity: config.enabled ? 1 : 0,
          transition: 'opacity 0.4s ease',
        }}
      />
      {showConfig && <ConfigPanel config={config} onConfigChange={onConfigChange} />}
    </>
  )
}

// =============================================================================
// 主组件
// =============================================================================

function VoiceWallpaperContent(ctx: WallpaperWidgetContext) {
  const [config, setConfig] = useState<VoiceWallpaperConfig>(DEFAULT_VOICE_WALLPAPER_CONFIG)

  const handleConfigChange = useCallback((patch: Partial<VoiceWallpaperConfig>) => {
    setConfig((prev) => ({ ...prev, ...patch }))
  }, [])

  return (
    <VoiceCanvas
      config={config}
      showConfig={ctx.behavior?.activityState === 'idle' || ctx.context === 'resting'}
      onConfigChange={handleConfigChange}
    />
  )
}

// =============================================================================
// Widget 定义
// =============================================================================

export const voiceWallpaperWidget: IWallpaperWidgetDefinition = {
  id: 'voice-wallpaper',
  name: '语音动态壁纸',
  priority: 2,
  zone: 'decoration',
  shouldShow: () => {
    // 始终尝试显示（Canvas 内部根据 triggerMode 控制可见性）
    return true
  },
  Component: VoiceWallpaperContent,
}
