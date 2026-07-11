/**
 * EvolutionDashboardCanvas — 自进化实时仪表盘 Canvas Widget
 *
 * 订阅 StateBroadcaster 推送的高频（1Hz）进化状态数据，
 * 使用 Canvas 2D API 实时渲染：
 *   - 进度条：当前进化阶段进度
 *   - 实时曲线：修复/错误趋势 sparkline
 *   - 热力图：模块活动热力图
 *   - 状态摘要：当前步骤、统计信息
 *
 * 鼠标穿透继承自父级 .wallpaper-overlay（pointer-events: none）。
 * 支持透明度、可见性切换。
 *
 * 数据流:
 *   IPC 'evolution:dashboard:live' → useState → useRef canvas → requestAnimationFrame
 */

import React, { useRef, useEffect, useState, useCallback } from 'react'
import type { IWallpaperWidgetDefinition, WallpaperWidgetContext } from '../types'
import { useBatchSetter } from '../../hooks/useBatchSetter'

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

/** Canvas 尺寸 */
const CANVAS_WIDTH = 340
const CANVAS_HEIGHT = 280

/** 曲线图区域 */
const CURVE_LEFT = 16
const CURVE_TOP = 160
const CURVE_WIDTH = 308
const CURVE_HEIGHT = 56

/** 热力图区域 */
const HEATMAP_LEFT = 16
const HEATMAP_TOP = 228
const HEATMAP_WIDTH = 308
const HEATMAP_HEIGHT = 36

/** 阶段颜色映射 */
const STAGE_COLORS: Record<string, string> = {
  idle: '#888888',
  analyzing: '#60a5fa',
  collecting: '#60a5fa',
  fixing: '#f59e0b',
  verifying: '#22c55e',
  cooldown: '#f97316',
  error: '#ef4444',
}

/** 阶段中文映射 */
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

function EvolutionDashboardCanvas({ config, evoDashboardOpacity }: WallpaperWidgetContext) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animFrameRef = useRef<number>(0)
  const payloadRef = useRef<DashboardLivePayload | null>(null)

  // ── 订阅高频率状态推送（rAF 批量合并） ──
  const [payload, setRawPayload] = useState<DashboardLivePayload | null>(null)
  const setBatchedPayload = useBatchSetter<DashboardLivePayload>((data) => {
    setRawPayload(data)
    payloadRef.current = data
  })

  useEffect(() => {
    const unsub = (window as any).electronAPI?.onEvolutionDashboardLive?.((data: DashboardLivePayload) => {
      setBatchedPayload(data)
    })
    return () => {
      if (typeof unsub === 'function') unsub()
    }
  }, [setPayload])

  // ── Canvas 渲染循环 ──
  const render = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const data = payloadRef.current
    if (!data || !data.active) {
      // 无数据时清除
      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)
      return
    }

    const { current: snap, history } = data
    const dpr = window.devicePixelRatio || 1
    canvas.width = CANVAS_WIDTH * dpr
    canvas.height = CANVAS_HEIGHT * dpr
    ctx.scale(dpr, dpr)

    // 清空
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)

    // 合成透明度
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

    // 阶段徽章
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
    const barX = 16
    const barY = 36
    const barW = CANVAS_WIDTH - 32
    const barH = 8

    // 轨道
    ctx.fillStyle = `oklch(1 0 0 / 0.1)`
    ctx.beginPath()
    ctx.roundRect(barX, barY, barW, barH, 4)
    ctx.fill()

    // 填充
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

    // 进度文字
    ctx.fillStyle = `oklch(0.9 0.005 12 / ${baseAlpha})`
    ctx.font = '500 10px system-ui, -apple-system, sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText(`${progress}%`, CANVAS_WIDTH - 16, barY - 4)
    ctx.textAlign = 'start'

    // ── 统计行 ──
    ctx.font = '11px system-ui, -apple-system, sans-serif'
    let statX = 16
    const statY = 58

    // 修复计数
    if (snap.fixedCount > 0) {
      ctx.fillStyle = '#22c55e'
      ctx.fillText(`✓ ${snap.fixedCount}`, statX, statY)
      statX += ctx.measureText(`✓ ${snap.fixedCount}`).width + 12
    }

    // 错误计数
    if (snap.errorCount > 0) {
      ctx.fillStyle = '#ef4444'
      ctx.fillText(`✗ ${snap.errorCount}`, statX, statY)
      statX += ctx.measureText(`✗ ${snap.errorCount}`).width + 12
    }

    // 队列
    if (snap.queueSize > 0) {
      ctx.fillStyle = '#f59e0b'
      ctx.fillText(`⟳ ${snap.queueSize}`, statX, statY)
      statX += ctx.measureText(`⟳ ${snap.queueSize}`).width + 12
    }

    // 连续失败
    if (snap.consecutiveFailures > 0) {
      ctx.fillStyle = '#ef4444'
      ctx.fillText(`⚠ ${snap.consecutiveFailures}`, statX, statY)
    }

    // 上次运行
    ctx.fillStyle = `oklch(0.6 0.005 12 / ${baseAlpha})`
    ctx.font = '9px system-ui, -apple-system, sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText(`上次运行: ${formatTimeAgo(snap.lastRunAt)}`, CANVAS_WIDTH - 16, statY)
    ctx.textAlign = 'start'

    // ── 当前活跃计划步骤 ──
    if (snap.plan && snap.plan.hasActive) {
      const planY = 76
      ctx.fillStyle = `oklch(0.85 0.005 12 / ${baseAlpha})`
      ctx.font = '10px system-ui, -apple-system, sans-serif'
      const planTitle = snap.plan.title.length > 22 ? snap.plan.title.slice(0, 20) + '…' : snap.plan.title
      ctx.fillText(`📋 ${planTitle}`, 16, planY)

      // 计划进度条（小）
      const planBarX = 16
      const planBarY = planY + 4
      const planBarW = CANVAS_WIDTH - 32 - 50
      const planBarH = 4
      ctx.fillStyle = `oklch(1 0 0 / 0.08)`
      ctx.beginPath()
      ctx.roundRect(planBarX, planBarY, planBarW, planBarH, 2)
      ctx.fill()
      const planPct = snap.plan.percentComplete
      ctx.fillStyle = '#22c55e'
      ctx.beginPath()
      ctx.roundRect(planBarX, planBarY, Math.max(2, (planPct / 100) * planBarW), planBarH, 2)
      ctx.fill()

      // 百分比
      ctx.fillStyle = `oklch(0.6 0.005 12 / ${baseAlpha})`
      ctx.font = '9px system-ui, -apple-system, sans-serif'
      ctx.textAlign = 'right'
      ctx.fillText(`${planPct}%`, CANVAS_WIDTH - 16, planY + 6)
      ctx.textAlign = 'start'

      // 当前步骤
      if (snap.plan.currentStep) {
        const stepY = planY + 16
        ctx.fillStyle = `oklch(0.7 0.005 12 / ${baseAlpha})`
        ctx.font = '9px system-ui, -apple-system, sans-serif'
        const stepText = snap.plan.currentStep.length > 35 ? snap.plan.currentStep.slice(0, 33) + '…' : snap.plan.currentStep
        ctx.fillText(`→ ${stepText}`, 16, stepY)
      }

      // 摘要文字
      if (snap.summary) {
        const summaryY = snap.plan.currentStep ? 118 : 108
        ctx.fillStyle = `oklch(0.65 0.005 12 / ${baseAlpha})`
        ctx.font = '10px system-ui, -apple-system, sans-serif'
        const summaryText = snap.summary.length > 42 ? snap.summary.slice(0, 40) + '…' : snap.summary
        ctx.fillText(summaryText, 16, summaryY)
      }
    } else {
      // 无计划时直接显示摘要
      if (snap.summary) {
        ctx.fillStyle = `oklch(0.65 0.005 12 / ${baseAlpha})`
        ctx.font = '10px system-ui, -apple-system, sans-serif'
        const summaryText = snap.summary.length > 50 ? snap.summary.slice(0, 48) + '…' : snap.summary
        ctx.fillText(summaryText, 16, 88)
      }
    }

    // ── 实时曲线（sparkline）：修复/错误趋势 ──
    const curveData = history.slice(0, 60).reverse()
    if (curveData.length >= 2) {
      // 标签
      ctx.fillStyle = `oklch(0.65 0.005 12 / ${baseAlpha})`
      ctx.font = '9px system-ui, -apple-system, sans-serif'
      ctx.fillText('修复趋势', CURVE_LEFT, CURVE_TOP - 8)

      // 固定曲线
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

      // 填充区域
      ctx.lineTo(CURVE_LEFT + CURVE_WIDTH, CURVE_TOP + CURVE_HEIGHT)
      ctx.lineTo(CURVE_LEFT, CURVE_TOP + CURVE_HEIGHT)
      ctx.closePath()
      ctx.fillStyle = 'oklch(0.576 0.245 166 / 0.15)'
      ctx.fill()

      // 错误曲线（如果有）
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

        // 填充
        ctx.lineTo(CURVE_LEFT + CURVE_WIDTH, CURVE_TOP + CURVE_HEIGHT)
        ctx.lineTo(CURVE_LEFT, CURVE_TOP + CURVE_HEIGHT)
        ctx.closePath()
        ctx.fillStyle = 'oklch(0.637 0.237 25 / 0.1)'
        ctx.fill()
      }

      // Y 轴标签
      ctx.fillStyle = `oklch(0.5 0.005 12 / ${baseAlpha})`
      ctx.font = '8px system-ui, -apple-system, sans-serif'
      ctx.fillText(String(maxFix), CURVE_LEFT - 4, CURVE_TOP - 1)

      // X 轴
      ctx.strokeStyle = `oklch(1 0 0 / 0.06)`
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(CURVE_LEFT, CURVE_TOP + CURVE_HEIGHT + 1)
      ctx.lineTo(CURVE_LEFT + CURVE_WIDTH, CURVE_TOP + CURVE_HEIGHT + 1)
      ctx.stroke()

      // 时间戳标签
      if (curveData.length > 0) {
        ctx.fillStyle = `oklch(0.45 0.005 12 / ${baseAlpha})`
        ctx.font = '7px system-ui, -apple-system, sans-serif'
        ctx.textAlign = 'right'
        ctx.fillText(formatTime(curveData[curveData.length - 1].timestamp), CURVE_LEFT + CURVE_WIDTH, CURVE_TOP + CURVE_HEIGHT + 12)
        ctx.fillText(formatTime(curveData[0].timestamp), CURVE_LEFT + CURVE_WIDTH, CURVE_TOP - 10)
        ctx.textAlign = 'start'
      }
    } else {
      // 无曲线数据时显示提示
      ctx.fillStyle = `oklch(0.5 0.005 12 / ${baseAlpha})`
      ctx.font = '9px system-ui, -apple-system, sans-serif'
      ctx.fillText('等待趋势数据…', CURVE_LEFT, CURVE_TOP + CURVE_HEIGHT / 2 + 3)
    }

    // ── 模块活动热力图 ──
    const heatData = history.slice(0, 60).reverse()
    if (heatData.length >= 2) {
      ctx.fillStyle = `oklch(0.65 0.005 12 / ${baseAlpha})`
      ctx.font = '9px system-ui, -apple-system, sans-serif'
      ctx.fillText('活动热力', HEATMAP_LEFT, HEATMAP_TOP - 8)

      const numBars = Math.min(heatData.length, 60)
      const barW2 = HEATMAP_WIDTH / numBars
      const barH2 = HEATMAP_HEIGHT

      for (let i = 0; i < numBars; i++) {
        const d = heatData[i]
        const x = HEATMAP_LEFT + i * barW2

        // 根据活动程度计算颜色
        let intensity = 0.05
        if (d.currentStage !== 'idle') intensity += 0.2
        if (d.fixedCount > 0) intensity += Math.min(0.4, d.fixedCount * 0.05)
        if (d.errorCount > 0) intensity += Math.min(0.3, d.errorCount * 0.1)
        if (d.consecutiveFailures > 0) intensity += Math.min(0.2, d.consecutiveFailures * 0.05)

        intensity = clamp(intensity, 0.05, 0.85)

        // 颜色：根据阶段
        let color = STAGE_COLORS[d.currentStage] || '#888'
        // 转换为 oklch 带透明度
        ctx.fillStyle = color
        ctx.globalAlpha = intensity

        const cornerR = Math.min(2, barW2 / 2)
        ctx.beginPath()
        ctx.roundRect(x, HEATMAP_TOP, Math.max(2, barW2 - 1), barH2, cornerR)
        ctx.fill()
      }

      ctx.globalAlpha = baseAlpha
    } else {
      ctx.fillStyle = `oklch(0.5 0.005 12 / ${baseAlpha})`
      ctx.font = '9px system-ui, -apple-system, sans-serif'
      ctx.fillText('等待热力数据…', HEATMAP_LEFT, HEATMAP_TOP + HEATMAP_HEIGHT / 2 + 3)
    }

    // ── 更新时间 ──
    ctx.fillStyle = `oklch(0.45 0.005 12 / ${baseAlpha * 0.7})`
    ctx.font = '8px system-ui, -apple-system, sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText(formatTime(snap.timestamp), CANVAS_WIDTH - 16, CANVAS_HEIGHT - 8)
    ctx.textAlign = 'start'

    ctx.restore()

    animFrameRef.current = requestAnimationFrame(render)
  }, [evoDashboardOpacity])

  // ── 启动/停止渲染循环 ──
  useEffect(() => {
    animFrameRef.current = requestAnimationFrame(render)
    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current)
      }
    }
  }, [render])

  // ── 鼠标穿透 & 对齐 ──
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

// =============================================================================
// Widget 定义
// =============================================================================

export const evolutionDashboardCanvasWidget: IWallpaperWidgetDefinition = {
  id: 'evolution-dashboard-canvas',
  name: '自进化实时仪表盘',
  priority: 5,
  zone: 'overlay',
  shouldShow: (ctx) => {
    // 仅在空闲/休息/多任务时显示（非专注模式）
    if (ctx.mode === 'focus') return false
    if (ctx.hideDecoration) return false
    // 需要进化实时数据
    return ctx.evoDashboardEnabled !== false
  },
  Component: EvolutionDashboardCanvas,
}
