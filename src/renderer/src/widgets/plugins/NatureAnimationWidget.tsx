/**
 * NatureAnimationWidget — 自然动画背景
 *
 * 在 resting 情境下显示漂浮粒子动画，营造放松氛围。
 *
 * 模式适配：作为 IWallpaperWidgetDefinition 插件，
 * 通过 shouldShow 控制可见性，通过 Component 渲染内容。
 */

import React, { useMemo } from 'react'
import type { IWallpaperWidgetDefinition, WallpaperWidgetContext } from '../types'

// =============================================================================
// 组件
// =============================================================================

function NatureAnimation({ context, mode, behavior }: WallpaperWidgetContext) {
  const particles = useMemo(() => {
    return Array.from({ length: 20 }, (_, i) => ({
      id: i,
      x: Math.random() * 100,
      y: Math.random() * 100,
      size: 2 + Math.random() * 6,
      speed: 0.5 + Math.random() * 1.5,
      delay: Math.random() * 8,
      opacity: 0.15 + Math.random() * 0.35,
    }))
  }, []) // 仅在组件挂载时生成一次

  return (
    <div className="wp-nature-animation" aria-hidden="true">
      {particles.map((p) => (
        <div
          key={p.id}
          className="wp-nature-particle"
          style={{
            left: `${p.x}%`,
            top: `${p.y}%`,
            width: `${p.size}px`,
            height: `${p.size}px`,
            opacity: p.opacity,
            animationDelay: `${p.delay}s`,
            animationDuration: `${8 / p.speed}s`,
          }}
        />
      ))}
    </div>
  )
}

// =============================================================================
// Widget 定义
// =============================================================================

export const natureAnimationWidget: IWallpaperWidgetDefinition = {
  id: 'nature-animation',
  name: '自然动画',
  priority: 0,
  zone: 'decoration',
  shouldShow: (ctx) => {
    if (ctx.hideDecoration) return false
    // resting 情境且在 break 模式或空闲时才显示
    return (
      ctx.context === 'resting' &&
      (ctx.mode === 'break' ||
        ctx.behavior?.activityState === 'idle' ||
        ctx.behavior?.activityState === 'away')
    )
  },
  Component: NatureAnimation,
}
