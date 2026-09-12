/**
 * NarrativeWallpaperWidget — 语音叙事动态壁纸 Widget
 *
 * 在桌面壁纸层渲染 Canvas 场景，响应 ASR 语音识别的关键词触发场景切换和动画效果。
 *
 * 功能：
 *   1. 订阅 ASR 文本流（通过 IPC）
 *   2. 关键词匹配 → 场景切换（带过渡动画）
 *   3. 动作关键词 → 瞬时效果（宝箱高亮、魔法闪烁等）
 *   4. 连续叙事：场景状态机自然演进
 *   5. 鼠标穿透（pointer-events: none）
 *
 * 区：decoration（装饰区，与 NatureAnimationWidget 同级）
 * 可见性：只在 resting/break 模式且未隐藏装饰时显示
 */

import React, { useRef, useEffect, useCallback } from 'react'
import type { IWallpaperWidgetDefinition, WallpaperWidgetContext } from '../types'
import { useNarrativeWallpaper } from './narrative/useNarrativeWallpaper'
import { SceneRenderer } from './narrative/SceneRenderer'
import { getSceneVisual } from './narrative/types'
import type { SceneRuntimeState } from './narrative/types'

// =============================================================================
// 渲染帧控制
// =============================================================================

/** 默认场景下降低帧率以节省性能（每 N 帧渲染一次） */
const IDLE_FRAME_SKIP = 4

// =============================================================================
// Canvas 组件
// =============================================================================

function NarrativeCanvas({ state }: { state: SceneRuntimeState }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<SceneRenderer | null>(null)
  const rafRef = useRef<number>(0)
  const lastTimeRef = useRef<number>(0)
  const frameCountRef = useRef<number>(0)
  const lastSceneRef = useRef<string | null>(null)
  const dispatchedActionsRef = useRef<Set<string>>(new Set())

  // ── 初始化渲染器 ──
  useEffect(() => {
    rendererRef.current = new SceneRenderer()
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rendererRef.current?.reset()
      rendererRef.current = null
    }
  }, [])

  // ── 场景变化时触发过渡 ──
  useEffect(() => {
    const renderer = rendererRef.current
    if (!renderer) return
    if (!state.currentScene) return

    const sceneKey = state.currentScene
    if (lastSceneRef.current === sceneKey) return
    lastSceneRef.current = sceneKey

    const visual = getSceneVisual(state.currentScene)
    if (visual) {
      renderer.transitionTo(visual, 800)
      // 场景切换时清理已分发动作记录
      dispatchedActionsRef.current.clear()
    }
  }, [state.currentScene])

  // ── 动作效果触发（仅新动作） ──
  useEffect(() => {
    const renderer = rendererRef.current
    if (!renderer) return
    const dispatched = dispatchedActionsRef.current

    for (const action of state.activeActions) {
      if (!dispatched.has(action.id)) {
        dispatched.add(action.id)
        renderer.triggerEffect(action.type, action.intensity, action.durationMs)
      }
    }
  }, [state.activeActions])

  // ── 渲染循环 ──
  const renderFrame = useCallback(
    (timestamp: number) => {
      const renderer = rendererRef.current
      const canvas = canvasRef.current
      if (!renderer || !canvas) return

      const dt = lastTimeRef.current === 0 ? 0.016 : (timestamp - lastTimeRef.current) / 1000
      lastTimeRef.current = timestamp

      // 降低帧率：非过渡/非效果时跳帧
      frameCountRef.current++
      const isActive = renderer.isTransitioning() || state.activeActions.length > 0
      if (!isActive && frameCountRef.current % IDLE_FRAME_SKIP !== 0) {
        rafRef.current = requestAnimationFrame(renderFrame)
        return
      }

      // 更新并渲染
      renderer.update(Math.min(dt, 0.05)) // 限制 dt 防止跳帧
      const ctx = canvas.getContext('2d')
      if (ctx) {
        renderer.render(ctx)
      }

      rafRef.current = requestAnimationFrame(renderFrame)
    },
    [state.activeActions.length],
  )

  // ── 启动/停止渲染循环 ──
  useEffect(() => {
    const renderer = rendererRef.current
    const canvas = canvasRef.current
    if (!renderer || !canvas) return

    // 设置尺寸
    const resize = () => {
      if (canvas) {
        const dpr = window.devicePixelRatio || 1
        const rect = canvas.getBoundingClientRect()
        canvas.width = rect.width * dpr
        canvas.height = rect.height * dpr
        const ctx = canvas.getContext('2d')
        if (ctx) ctx.scale(dpr, dpr)
        renderer.setSize(rect.width, rect.height)
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
    <canvas
      ref={canvasRef}
      className="narrative-wallpaper-canvas"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        pointerEvents: 'none',
        zIndex: -1,
        opacity: state.currentScene ? 1 : 0,
        transition: 'opacity 0.6s ease',
      }}
    />
  )
}

// =============================================================================
// 主组件
// =============================================================================

function NarrativeWallpaperContent(ctx: WallpaperWidgetContext) {
  const { state } = useNarrativeWallpaper({
    enabled: true,
  })

  return <NarrativeCanvas state={state} />
}

// =============================================================================
// Widget 定义
// =============================================================================

export const narrativeWallpaperWidget: IWallpaperWidgetDefinition = {
  id: 'narrative-wallpaper',
  name: '语音叙事壁纸',
  priority: 1,
  zone: 'decoration',
  shouldShow: (ctx) => {
    if (ctx.hideDecoration) return false
    // 在 resting 或空闲模式显示
    return ctx.context === 'resting' || ctx.behavior?.activityState === 'idle' || ctx.behavior?.activityState === 'away'
  },
  Component: NarrativeWallpaperContent,
}
