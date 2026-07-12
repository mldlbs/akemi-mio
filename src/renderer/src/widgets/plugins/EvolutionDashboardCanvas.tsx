/**
 * EvolutionDashboardCanvas — 自进化实时仪表盘 Canvas Widget
 *
 * 订阅 StateBroadcaster 推送的高频（1Hz）进化状态数据，
 * 使用 Canvas 2D API 渲染。
 *
 * 改进：事件驱动渲染（不再使用 requestAnimationFrame 死循环），
 * JSON 指纹去重避免无意义重绘，仅 IPC 数据变化时触发一次绘制。
 */

import React, { useRef, useEffect, useCallback } from 'react'
import type { IWallpaperWidgetDefinition, WallpaperWidgetContext } from '../types'

// =============================================================================
// 类型
// =============================================================================

interface DashboardLiveSnapshot {
  schedulerState: string
  currentStage: string
  progress: number
  summary: string
  errorCount: number
  fixedCount: number
  queueSize: number
  consecutiveFailures: number
  lastRunAt: number | null
  plan: {
    hasActive: boolean
    title: string
    completedSteps: number
    totalSteps: number
    percentComplete: number
    currentStep: string
  } | null
  timestamp: number
}

interface DashboardLivePayload {
  current: DashboardLiveSnapshot
  history: DashboardLiveSnapshot[]
  active: boolean
}

// =============================================================================
// 常量
// =============================================================================

const CANVAS_WIDTH = 340
const CANVAS_HEIGHT = 280

const CURVE_LEFT = 16
const CURVE_TOP = 160
const CURVE_WIDTH = 308
const CURVE_HEIGHT = 56

const HEATMAP_LEFT = 16
const HEATMAP_TOP = 228
const HEATMAP_WIDTH = 308
const HEATMAP_HEIGHT = 36

const STAGE_COLORS: Record<string, string> = {
  idle: '#888888',
  analyzing: '#60a5fa',
  collecting: '#60a5fa',
  fixing: '#f59e0b',
  verifying: '#22c55e',
  cooldown: '#f97316',
  error: '#ef4444',
}

const STAGE_LABELS: Record<string, string> = {
  idle: '待机',
  analyzing: '分析',
  collecting: '采集',
  fixing: '修复',
  verifying: '验证',
  cooldown: '冷却',
  error: '异常',
}

// =============================================================================
// 工具函数
// =============================================================================

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
}

function formatTimeAgo(ts: number | null): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`
  return `${Math.floor(diff / 86400000)}d`
}

// =============================================================================
// 组件
// =============================================================================

function EvolutionDashboardCanvas({ evoDashboardOpacity }: WallpaperWidgetContext) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const lastJsonRef = useRef<string>('')

  // 单次绘制函数，不触发 React 重渲染
  const paint = useCallback(
    (data: DashboardLivePayload) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      if (!data || !data.active) {
        ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)
        return
      }

      const { current: snap, history } = data
      const dpr = window.devicePixelRatio || 1
      if (canvas.width !== CANVAS_WIDTH * dpr) canvas.width = CANVAS_WIDTH * dpr
      if (canvas.height !== CANVAS_HEIGHT * dpr) canvas.height = CANVAS_HEIGHT * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)

      const baseAlpha = clamp(evoDashboardOpacity ?? 0.85, 0.1, 1)

      ctx.save()
      ctx.globalAlpha = baseAlpha

      // ── 背景 ──
      ctx.fillStyle = `oklch(0 0 0 / 0.35)`
      ctx.beginPath()
      ctx.roundRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT, 14)
      ctx.fill()

      // ── 标题行 ──
      ctx.fillStyle = `oklch(0.85 0.005 12 / ${baseAlpha})`
      ctx.font = '600 13px system-ui, -apple-system, sans-serif'
      ctx.fillText('⚡ 自进化实时仪表盘', 16, 22)

      const stage = snap.currentStage
      const stageLabel = STAGE_LABELS[stage] || stage
      const stageColor = STAGE_COLORS[stage] || '#888'
      ctx.fillStyle = stageColor
      ctx.beginPath()
      ctx.roundRect(240, 8, 84, 18, 9)
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.font = '500 10px system-ui, -apple-system, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(stageLabel, 282, 21)
      ctx.textAlign = 'start'

      // ── 进度条 ──
      const barX = 16,
        barY = 36,
        barW = CANVAS_WIDTH - 32,
        barH = 8
      ctx.fillStyle = `oklch(1 0 0 / 0.1)`
      ctx.beginPath()
      ctx.roundRect(barX, barY, barW, barH, 4)
      ctx.fill()
      const progress = clamp(snap.progress, 0, 100)
      if (progress > 0) {
        const fillW = (progress / 100) * barW
        const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0)
        grad.addColorStop(0, stageColor)
        grad.addColorStop(1, stage === 'error' ? '#ef4444' : '#60a5fa')
        ctx.fillStyle = grad
        ctx.beginPath()
        ctx.roundRect(barX, barY, Math.max(4, fillW), barH, 4)
        ctx.fill()
      }
      ctx.fillStyle = `oklch(0.9 0.005 12 / ${baseAlpha})`
      ctx.font = '500 10px system-ui, -apple-system, sans-serif'
      ctx.textAlign = 'right'
      ctx.fillText(`${progress}%`, CANVAS_WIDTH - 16, barY - 4)
      ctx.textAlign = 'start'

      // ── 统计行 ──
      ctx.font = '11px system-ui, -apple-system, sans-serif'
      let statX = 16
      const statY = 58
      if (snap.fixedCount > 0) {
        ctx.fillStyle = '#22c55e'
        ctx.fillText(`✓ ${snap.fixedCount}`, statX, statY)
        statX += ctx.measureText(`✓ ${snap.fixedCount}`).width + 12
      }
      if (snap.errorCount > 0) {
        ctx.fillStyle = '#ef4444'
        ctx.fillText(`✗ ${snap.errorCount}`, statX, statY)
        statX += ctx.measureText(`✗ ${snap.errorCount}`).width + 12
      }
      if (snap.queueSize > 0) {
        ctx.fillStyle = '#f59e0b'
        ctx.fillText(`⟳ ${snap.queueSize}`, statX, statY)
        statX += ctx.measureText(`⟳ ${snap.queueSize}`).width + 12
      }
      if (snap.consecutiveFailures > 0) {
        ctx.fillStyle = '#ef4444'
        ctx.fillText(`⚠ ${snap.consecutiveFailures}`, statX, statY)
      }
      ctx.fillStyle = `oklch(0.6 0.005 12 / ${baseAlpha})`
      ctx.font = '9px system-ui, -apple-system, sans-serif'
      ctx.textAlign = 'right'
      ctx.fillText(`上次运行: ${formatTimeAgo(snap.lastRunAt)}`, CANVAS_WIDTH - 16, statY)
      ctx.textAlign = 'start'

      // ── 计划 / 摘要 ──
      if (snap.plan && snap.plan.hasActive) {
        const planY = 76
        ctx.fillStyle = `oklch(0.85 0.005 12 / ${baseAlpha})`
        ctx.font = '10px system-ui, -apple-system, sans-serif'
        const planTitle = snap.plan.title.length > 22 ? snap.plan.title.slice(0, 20) + '…' : snap.plan.title
        ctx.fillText(`📋 ${planTitle}`, 16, planY)
        const planBarX = 16,
          planBarW2 = CANVAS_WIDTH - 32 - 50,
          planBarH2 = 4
        ctx.fillStyle = `oklch(1 0 0 / 0.08)`
        ctx.beginPath()
        ctx.roundRect(planBarX, planY + 4, planBarW2, planBarH2, 2)
        ctx.fill()
        const planPct = snap.plan.percentComplete
        ctx.fillStyle = '#22c55e'
        ctx.beginPath()
        ctx.roundRect(planBarX, planY + 4, Math.max(2, (planPct / 100) * planBarW2), planBarH2, 2)
        ctx.fill()
        ctx.fillStyle = `oklch(0.6 0.005 12 / ${baseAlpha})`
        ctx.font = '9px system-ui, -apple-system, sans-serif'
        ctx.textAlign = 'right'
        ctx.fillText(`${planPct}%`, CANVAS_WIDTH - 16, planY + 6)
        ctx.textAlign = 'start'
        if (snap.plan.currentStep) {
          ctx.fillStyle = `oklch(0.7 0.005 12 / ${baseAlpha})`
          ctx.font = '9px system-ui, -apple-system, sans-serif'
          const stepText = snap.plan.currentStep.length > 35 ? snap.plan.currentStep.slice(0, 33) + '…' : snap.plan.currentStep
          ctx.fillText(`→ ${stepText}`, 16, planY + 16)
        }
        if (snap.summary) {
          const summaryY = snap.plan.currentStep ? 118 : 108
          ctx.fillStyle = `oklch(0.65 0.005 12 / ${baseAlpha})`
          ctx.font = '10px system-ui, -apple-system, sans-serif'
          const summaryText = snap.summary.length > 42 ? snap.summary.slice(0, 40) + '…' : snap.summary
          ctx.fillText(summaryText, 16, summaryY)
        }
      } else if (snap.summary) {
        ctx.fillStyle = `oklch(0.65 0.005 12 / ${baseAlpha})`
        ctx.font = '10px system-ui, -apple-system, sans-serif'
        const summaryText = snap.summary.length > 50 ? snap.summary.slice(0, 48) + '…' : snap.summary
        ctx.fillText(summaryText, 16, 88)
      }

      // ── 实时曲线 ──
      const curveData = history.slice(0, 60).reverse()
      if (curveData.length >= 2) {
        ctx.fillStyle = `oklch(0.65 0.005 12 / ${baseAlpha})`
        ctx.font = '9px system-ui, -apple-system, sans-serif'
        ctx.fillText('修复趋势', CURVE_LEFT, CURVE_TOP - 8)
        const maxFix = Math.max(1, ...curveData.map((d) => d.fixedCount))
        ctx.beginPath()
        ctx.strokeStyle = '#22c55e'
        ctx.lineWidth = 1.5
        for (let i = 0; i < curveData.length; i++) {
          const x = CURVE_LEFT + (i / (curveData.length - 1)) * CURVE_WIDTH
          const y = CURVE_TOP + CURVE_HEIGHT - (curveData[i].fixedCount / maxFix) * CURVE_HEIGHT
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
        }
        ctx.stroke()
        ctx.lineTo(CURVE_LEFT + CURVE_WIDTH, CURVE_TOP + CURVE_HEIGHT)
        ctx.lineTo(CURVE_LEFT, CURVE_TOP + CURVE_HEIGHT)
        ctx.closePath()
        ctx.fillStyle = 'oklch(0.576 0.245 166 / 0.15)'
        ctx.fill()

        const maxErr = Math.max(1, ...curveData.map((d) => d.errorCount))
        if (maxErr > 0) {
          ctx.beginPath()
          ctx.strokeStyle = '#ef4444'
          ctx.lineWidth = 1.5
          for (let i = 0; i < curveData.length; i++) {
            const x = CURVE_LEFT + (i / (curveData.length - 1)) * CURVE_WIDTH
            const y = CURVE_TOP + CURVE_HEIGHT - (curveData[i].errorCount / maxErr) * CURVE_HEIGHT
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
          }
          ctx.stroke()
          ctx.lineTo(CURVE_LEFT + CURVE_WIDTH, CURVE_TOP + CURVE_HEIGHT)
          ctx.lineTo(CURVE_LEFT, CURVE_TOP + CURVE_HEIGHT)
          ctx.closePath()
          ctx.fillStyle = 'oklch(0.637 0.237 25 / 0.1)'
          ctx.fill()
        }
        ctx.fillStyle = `oklch(0.5 0.005 12 / ${baseAlpha})`
        ctx.font = '8px system-ui, -apple-system, sans-serif'
        ctx.fillText(String(maxFix), CURVE_LEFT - 4, CURVE_TOP - 1)
        ctx.strokeStyle = `oklch(1 0 0 / 0.06)`
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(CURVE_LEFT, CURVE_TOP + CURVE_HEIGHT + 1)
        ctx.lineTo(CURVE_LEFT + CURVE_WIDTH, CURVE_TOP + CURVE_HEIGHT + 1)
        ctx.stroke()
        if (curveData.length > 0) {
          ctx.fillStyle = `oklch(0.45 0.005 12 / ${baseAlpha})`
          ctx.font = '7px system-ui, -apple-system, sans-serif'
          ctx.textAlign = 'right'
          ctx.fillText(formatTime(curveData[curveData.length - 1].timestamp), CURVE_LEFT + CURVE_WIDTH, CURVE_TOP + CURVE_HEIGHT + 12)
          ctx.fillText(formatTime(curveData[0].timestamp), CURVE_LEFT + CURVE_WIDTH, CURVE_TOP - 10)
          ctx.textAlign = 'start'
        }
      } else {
        ctx.fillStyle = `oklch(0.5 0.005 12 / ${baseAlpha})`
        ctx.font = '9px system-ui, -apple-system, sans-serif'
        ctx.fillText('等待趋势数据…', CURVE_LEFT, CURVE_TOP + CURVE_HEIGHT / 2 + 3)
      }

      // ── 热力图 ──
      const heatData = history.slice(0, 60).reverse()
      if (heatData.length >= 2) {
        ctx.fillStyle = `oklch(0.65 0.005 12 / ${baseAlpha})`
        ctx.font = '9px system-ui, -apple-system, sans-serif'
        ctx.fillText('活动热力', HEATMAP_LEFT, HEATMAP_TOP - 8)
        const numBars = Math.min(heatData.length, 60)
        const barW3 = HEATMAP_WIDTH / numBars
        for (let i = 0; i < numBars; i++) {
          const d = heatData[i]
          const x = HEATMAP_LEFT + i * barW3
          let intensity = 0.05
          if (d.currentStage !== 'idle') intensity += 0.2
          if (d.fixedCount > 0) intensity += Math.min(0.4, d.fixedCount * 0.05)
          if (d.errorCount > 0) intensity += Math.min(0.3, d.errorCount * 0.1)
          if (d.consecutiveFailures > 0) intensity += Math.min(0.2, d.consecutiveFailures * 0.05)
          intensity = clamp(intensity, 0.05, 0.85)
          ctx.fillStyle = STAGE_COLORS[d.currentStage] || '#888'
          ctx.globalAlpha = intensity
          const cornerR = Math.min(2, barW3 / 2)
          ctx.beginPath()
          ctx.roundRect(x, HEATMAP_TOP, Math.max(2, barW3 - 1), HEATMAP_HEIGHT, cornerR)
          ctx.fill()
        }
        ctx.globalAlpha = baseAlpha
      } else {
        ctx.fillStyle = `oklch(0.5 0.005 12 / ${baseAlpha})`
        ctx.font = '9px system-ui, -apple-system, sans-serif'
        ctx.fillText('等待热力数据…', HEATMAP_LEFT, HEATMAP_TOP + HEATMAP_HEIGHT / 2 + 3)
      }

      ctx.fillStyle = `oklch(0.45 0.005 12 / ${baseAlpha * 0.7})`
      ctx.font = '8px system-ui, -apple-system, sans-serif'
      ctx.textAlign = 'right'
      ctx.fillText(formatTime(snap.timestamp), CANVAS_WIDTH - 16, CANVAS_HEIGHT - 8)
      ctx.textAlign = 'start'
      ctx.restore()
    },
    [evoDashboardOpacity],
  )

  // IPC 订阅 — 收到数据后对比指纹，变化时直接绘制（不触发 React state 更新）
  useEffect(() => {
    const api = (window as any).electronAPI
    if (!api?.onEvolutionDashboardLive) return
    const cleanup = api.onEvolutionDashboardLive((data: DashboardLivePayload) => {
      const json = JSON.stringify(data)
      if (json === lastJsonRef.current) return
      lastJsonRef.current = json
      paint(data)
    })
    return () => {
      if (typeof cleanup === 'function') cleanup()
    }
  }, [paint])

  const containerStyle: React.CSSProperties = {
    position: 'absolute',
    bottom: '16px',
    left: '16px',
    pointerEvents: 'none',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  }

  return (
    <div style={containerStyle}>
      <canvas
        ref={canvasRef}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        style={{
          width: CANVAS_WIDTH,
          height: CANVAS_HEIGHT,
          borderRadius: '14px',
          display: 'block',
        }}
      />
    </div>
  )
}

export const evolutionDashboardCanvasWidget: IWallpaperWidgetDefinition = {
  id: 'evolution-dashboard-canvas',
  name: '自进化实时仪表盘',
  priority: 5,
  zone: 'overlay',
  shouldShow: (ctx) => {
    if (ctx.mode === 'focus') return false
    if (ctx.hideDecoration) return false
    return ctx.evoDashboardEnabled !== false
  },
  Component: EvolutionDashboardCanvas,
}
