/**
 * BlogKanbanCanvas — 桌面博客写作看板 Canvas Widget
 *
 * 在壁纸 Overlay 上以半透明玻璃面板形式实时显示博客写作工作流的进度。
 * 遵循 EvolutionDashboardCanvas 的架构模式：
 *   - Canvas 2D 渲染
 *   - JSON 指纹去重
 *   - IPC 事件驱动 + 轮询兜底
 *
 * 显示内容:
 *   1. 活跃博客会话总数与列表
 *   2. 7 阶段工作流管道（主题分析→素材收集→大纲→初稿→审核→润色→发布规划）
 *   3. 当前阶段标签与进度百分比
 *   4. 各阶段状态指示灯（pending/running/completed/skipped/failed）
 *   5. 悬停时显示阶段详情提示
 *   6. 双击打开详细面板
 *
 * 区: overlay
 * 可见性: 由配置控制（默认启用）
 * 鼠标穿透: 容器 pointer-events: none，Canvas 内部处理交互
 */

import React, { useRef, useEffect, useCallback, useState } from 'react'
import type { IWallpaperWidgetDefinition, WallpaperWidgetContext } from '../types'

// ════════════════════════════════════════════════════════════
// 类型定义
// ════════════════════════════════════════════════════════════

interface StageStatusItem {
  stageId: string
  label: string
  status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed'
  index: number
}

interface BlogKanbanSessionData {
  sessionId: string
  topic: string
  targetPlatform: string
  currentStageId: string
  currentStageLabel: string
  stageProgress: number
  currentStageIndex: number
  totalStages: number
  completedStages: number
  skippedStages: number
  percentComplete: number
  completed: boolean
  stageStatuses: StageStatusItem[]
  createdAt: number
  lastActivityAt: number
  progressText: string
}

interface BlogKanbanPayload {
  sessions: BlogKanbanSessionData[]
  totalActiveSessions: number
  hasActiveSessions: boolean
  timestamp: number
}

// ════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════

const CANVAS_WIDTH = 380
const CANVAS_HEIGHT = 340

const PANEL_PADDING = 14
const PANEL_TOP = 12

const SESSION_TOP = 44
const SESSION_HEIGHT = 78

const STAGE_NODE_RADIUS = 10
const STAGE_TOP_Y = 22
const STAGE_BAR_Y = 52
const STAGE_BAR_H = 6

const MAX_SESSIONS = 3

const STAGE_STATUS_COLORS: Record<string, string> = {
  pending: '#555555',
  running: '#60a5fa',
  completed: '#22c55e',
  skipped: '#a78bfa',
  failed: '#ef4444',
}

const STAGE_STATUS_LABELS: Record<string, string> = {
  pending: '待处理',
  running: '进行中',
  completed: '已完成',
  skipped: '已跳过',
  failed: '失败',
}

// ════════════════════════════════════════════════════════════
// 工具函数
// ════════════════════════════════════════════════════════════

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`
  return `${Math.floor(diff / 86400000)}d`
}

function formatSessionTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const time = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  return isToday ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`
}

// ════════════════════════════════════════════════════════════
// 组件
// ════════════════════════════════════════════════════════════

function BlogKanbanCanvas({ opacity, hideDecoration }: WallpaperWidgetContext) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const lastJsonRef = useRef<string>('')
  const [payload, setPayload] = useState<BlogKanbanPayload | null>(null)
  const [detailSession, setDetailSession] = useState<BlogKanbanSessionData | null>(null)
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null)
  const [hoveredStage, setHoveredStage] = useState<{ sessionIdx: number; stage: StageStatusItem } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // ── 绘制函数 ──
  const paint = useCallback(
    (data: BlogKanbanPayload) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const dpr = window.devicePixelRatio || 1
      if (canvas.width !== CANVAS_WIDTH * dpr) canvas.width = CANVAS_WIDTH * dpr
      if (canvas.height !== CANVAS_HEIGHT * dpr) canvas.height = CANVAS_HEIGHT * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)

      const baseAlpha = clamp(opacity ?? 0.85, 0.1, 1)

      ctx.save()
      ctx.globalAlpha = baseAlpha

      // ── 玻璃背景 ──
      ctx.fillStyle = `oklch(0 0 0 / 0.32)`
      ctx.beginPath()
      ctx.roundRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT, 14)
      ctx.fill()

      // ── 标题行 ──
      ctx.fillStyle = `oklch(0.85 0.005 12 / ${baseAlpha})`
      ctx.font = '600 13px system-ui, -apple-system, sans-serif'
      ctx.fillText('📝 博客写作看板', PANEL_PADDING, PANEL_TOP + 16)

      if (data.hasActiveSessions) {
        ctx.fillStyle = `oklch(0.5 0.005 12 / ${baseAlpha})`
        ctx.font = '10px system-ui, -apple-system, sans-serif'
        ctx.textAlign = 'right'
        ctx.fillText(`${data.totalActiveSessions} 个活跃会话`, CANVAS_WIDTH - PANEL_PADDING, PANEL_TOP + 16)
        ctx.textAlign = 'start'

        // ── 渲染每个会话 ──
        const displaySessions = data.sessions.slice(0, MAX_SESSIONS)
        displaySessions.forEach((session, sIdx) => {
          const sessionY = SESSION_TOP + sIdx * SESSION_HEIGHT

          // ─ 会话标题行 ──
          ctx.fillStyle = `oklch(0.82 0.005 12 / ${baseAlpha})`
          ctx.font = '500 11px system-ui, -apple-system, sans-serif'
          const topicText = session.topic.length > 18 ? session.topic.slice(0, 16) + '…' : session.topic
          ctx.fillText(topicText, PANEL_PADDING + 2, sessionY + 14)

          // 平台标签（如果有）
          if (session.targetPlatform) {
            ctx.fillStyle = `oklch(0.55 0.02 250 / ${baseAlpha})`
            ctx.font = '9px system-ui, -apple-system, sans-serif'
            ctx.fillText(session.targetPlatform, PANEL_PADDING + 2, sessionY + 26)
          }

          // 时间
          ctx.fillStyle = `oklch(0.5 0.005 12 / ${baseAlpha * 0.7})`
          ctx.font = '8px system-ui, -apple-system, sans-serif'
          const timeLabel = `${formatSessionTime(session.lastActivityAt)} · ${formatTimeAgo(session.lastActivityAt)}`
          ctx.textAlign = 'right'
          ctx.fillText(timeLabel, CANVAS_WIDTH - PANEL_PADDING, sessionY + 14)
          ctx.textAlign = 'start'

          // ─ 阶段管道：7 个节点（圆点 + 连线） ──
          const stagePositions = Array.from({ length: 7 }, (_, i) => {
            const trackLeft = PANEL_PADDING + 10
            const trackWidth = CANVAS_WIDTH - PANEL_PADDING * 2 - 20
            const nodeSpacing = trackWidth / 6
            return {
              x: trackLeft + i * nodeSpacing,
              y: sessionY + STAGE_TOP_Y,
            }
          })

          // 画连线（先画在节点后面）
          for (let i = 0; i < 6; i++) {
            const from = stagePositions[i]
            const to = stagePositions[i + 1]
            const fromStatus = session.stageStatuses[i]?.status || 'pending'
            const toStatus = session.stageStatuses[i + 1]?.status || 'pending'

            // 已完成段的连线用亮色
            const isActive = fromStatus === 'completed' || fromStatus === 'running'
            ctx.beginPath()
            ctx.moveTo(from.x + STAGE_NODE_RADIUS, from.y)
            ctx.lineTo(to.x - STAGE_NODE_RADIUS, to.y)
            ctx.strokeStyle = isActive
              ? `oklch(0.576 0.245 166 / ${baseAlpha * 0.5})`
              : `oklch(1 0 0 / ${baseAlpha * 0.12})`
            ctx.lineWidth = 2
            ctx.stroke()
          }

          // 画节点
          session.stageStatuses.forEach((stage, i) => {
            const pos = stagePositions[i]
            const color = STAGE_STATUS_COLORS[stage.status] || '#555'
            const isRunning = stage.status === 'running'

            // 外圈（选中状态发光）
            if (isRunning) {
              ctx.beginPath()
              ctx.arc(pos.x, pos.y, STAGE_NODE_RADIUS + 4, 0, Math.PI * 2)
              ctx.fillStyle = `oklch(0.6 0.2 220 / ${baseAlpha * 0.15})`
              ctx.fill()
            }

            // 节点主体
            ctx.beginPath()
            ctx.arc(pos.x, pos.y, STAGE_NODE_RADIUS, 0, Math.PI * 2)
            ctx.fillStyle = isRunning ? color : `oklch(0.3 0.02 ${stage.status === 'completed' ? 150 : 0} / ${baseAlpha})`
            ctx.fill()

            // 已完成节点打勾
            if (stage.status === 'completed') {
              ctx.strokeStyle = '#fff'
              ctx.lineWidth = 1.5
              ctx.beginPath()
              ctx.moveTo(pos.x - 3, pos.y)
              ctx.lineTo(pos.x - 1, pos.y + 3)
              ctx.lineTo(pos.x + 4, pos.y - 2)
              ctx.stroke()
            }

            // 跳过节点显示 ×
            if (stage.status === 'skipped') {
              ctx.strokeStyle = '#fff'
              ctx.lineWidth = 1.5
              ctx.beginPath()
              ctx.moveTo(pos.x - 3, pos.y - 3)
              ctx.lineTo(pos.x + 3, pos.y + 3)
              ctx.moveTo(pos.x + 3, pos.y - 3)
              ctx.lineTo(pos.x - 3, pos.y + 3)
              ctx.stroke()
            }

            // 失败节点显示 !
            if (stage.status === 'failed') {
              ctx.fillStyle = '#fff'
              ctx.font = 'bold 12px system-ui, -apple-system, sans-serif'
              ctx.textAlign = 'center'
              ctx.fillText('!', pos.x, pos.y + 4)
              ctx.textAlign = 'start'
            }
          })

          // ─ 进度条 ──
          const barX = PANEL_PADDING + 2
          const barY = sessionY + STAGE_BAR_Y
          const barW = CANVAS_WIDTH - PANEL_PADDING * 2 - 4

          // 进度条背景
          ctx.fillStyle = `oklch(1 0 0 / 0.08)`
          ctx.beginPath()
          ctx.roundRect(barX, barY, barW, STAGE_BAR_H, 3)
          ctx.fill()

          // 进度条填充
          const pct = clamp(session.percentComplete, 0, 100)
          if (pct > 0) {
            const fillW = (pct / 100) * barW
            const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0)
            grad.addColorStop(0, '#22c55e')
            grad.addColorStop(1, '#60a5fa')
            ctx.fillStyle = grad
            ctx.beginPath()
            ctx.roundRect(barX, barY, Math.max(4, fillW), STAGE_BAR_H, 3)
            ctx.fill()
          }

          // 百分比文字
          ctx.fillStyle = `oklch(0.82 0.005 12 / ${baseAlpha})`
          ctx.font = '9px system-ui, -apple-system, sans-serif'
          ctx.textAlign = 'right'
          ctx.fillText(`${session.percentComplete}% · ${session.progressText}`, CANVAS_WIDTH - PANEL_PADDING, barY + STAGE_BAR_H + 12)
          ctx.textAlign = 'start'

          // ─ 当前阶段标签 ──
          ctx.fillStyle = `oklch(0.65 0.02 220 / ${baseAlpha})`
          ctx.font = '9px system-ui, -apple-system, sans-serif'
          const currentLabel = `→ ${session.currentStageLabel}`
          ctx.fillText(currentLabel, PANEL_PADDING + 2, barY + STAGE_BAR_H + 26)
        })

        // ── 更多会话提示 ──
        if (data.sessions.length > MAX_SESSIONS) {
          const moreY = SESSION_TOP + MAX_SESSIONS * SESSION_HEIGHT + 4
          ctx.fillStyle = `oklch(0.45 0.005 12 / ${baseAlpha * 0.6})`
          ctx.font = '9px system-ui, -apple-system, sans-serif'
          ctx.textAlign = 'center'
          ctx.fillText(`还有 ${data.sessions.length - MAX_SESSIONS} 个会话 · 双击查看详情`, CANVAS_WIDTH / 2, moreY)
          ctx.textAlign = 'start'
        }
      } else {
        // ── 无活跃会话 ──
        ctx.fillStyle = `oklch(0.5 0.005 12 / ${baseAlpha * 0.6})`
        ctx.font = '13px system-ui, -apple-system, sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText('暂无活跃博客会话', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 - 6)
        ctx.fillStyle = `oklch(0.4 0.005 12 / ${baseAlpha * 0.4})`
        ctx.font = '10px system-ui, -apple-system, sans-serif'
        ctx.fillText('启动「开始写博客」创建新会话', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 + 16)
        ctx.textAlign = 'start'
      }

      // ── 右下角时间戳 ──
      if (data.hasActiveSessions) {
        ctx.fillStyle = `oklch(0.4 0.005 12 / ${baseAlpha * 0.5})`
        ctx.font = '8px system-ui, -apple-system, sans-serif'
        ctx.textAlign = 'right'
        ctx.fillText(formatSessionTime(data.timestamp), CANVAS_WIDTH - PANEL_PADDING, CANVAS_HEIGHT - 6)
        ctx.textAlign = 'start'
      }

      ctx.restore()
    },
    [opacity],
  )

  // ── IPC 数据订阅（推送 + 轮询兜底） ──
  useEffect(() => {
    const api = (window as any).electronAPI
    if (!api) return

    // 初始加载
    api.getBlogKanbanStatus().then((data: BlogKanbanPayload | null) => {
      if (data) {
        setPayload(data)
        const json = JSON.stringify(data)
        if (json !== lastJsonRef.current) {
          lastJsonRef.current = json
          paint(data)
        }
      }
    })

    // 订阅推送
    const unsub = api.onBlogKanbanUpdate((data: BlogKanbanPayload) => {
      setPayload(data)
      const json = JSON.stringify(data)
      if (json === lastJsonRef.current) return
      lastJsonRef.current = json
      paint(data)
    })

    // 轮询兜底（30s）
    const interval = setInterval(async () => {
      try {
        const data = await api.getBlogKanbanStatus()
        if (data) {
          setPayload(data)
          const json = JSON.stringify(data)
          if (json === lastJsonRef.current) return
          lastJsonRef.current = json
          paint(data)
        }
      } catch {
        // 静默失败
      }
    }, 30_000)

    return () => {
      if (typeof unsub === 'function') unsub()
      clearInterval(interval)
    }
  }, [paint])

  // ── 鼠标事件处理 ──
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!payload?.hasActiveSessions) return
      const rect = (e.target as HTMLElement).getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      setMousePos({ x: mx, y: my })

      // 检测悬停节点
      let found: { sessionIdx: number; stage: StageStatusItem } | null = null
      const displaySessions = payload.sessions.slice(0, MAX_SESSIONS)
      for (let sIdx = 0; sIdx < displaySessions.length; sIdx++) {
        const positions = Array.from({ length: 7 }, (_, i) => {
          const trackLeft = PANEL_PADDING + 10
          const trackWidth = CANVAS_WIDTH - PANEL_PADDING * 2 - 20
          const nodeSpacing = trackWidth / 6
          return {
            x: trackLeft + i * nodeSpacing,
            y: SESSION_TOP + sIdx * SESSION_HEIGHT + STAGE_TOP_Y,
          }
        })
        for (let i = 0; i < positions.length; i++) {
          const dx = mx - positions[i].x
          const dy = my - positions[i].y
          if (dx * dx + dy * dy <= (STAGE_NODE_RADIUS + 4) * (STAGE_NODE_RADIUS + 4)) {
            found = { sessionIdx: sIdx, stage: displaySessions[sIdx].stageStatuses[i] }
            break
          }
        }
        if (found) break
      }
      setHoveredStage(found)
    },
    [payload],
  )

  const handleDoubleClick = useCallback(() => {
    if (!payload?.hasActiveSessions || payload.sessions.length === 0) return
    // 打开最近活跃会话的详细信息
    const sorted = [...payload.sessions].sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    setDetailSession(sorted[0])
  }, [payload])

  const containerStyle: React.CSSProperties = {
    position: 'absolute',
    bottom: '16px',
    right: '16px',
    pointerEvents: 'auto',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  }

  return (
    <>
      {/* 详情浮层 */}
      {detailSession && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'oklch(0 0 0 / 0.4)',
          }}
          onClick={() => setDetailSession(null)}
        >
          <div
            style={{
              width: 420,
              maxHeight: '80vh',
              background: 'oklch(0.15 0.01 250 / 0.95)',
              borderRadius: 16,
              padding: 20,
              backdropFilter: 'blur(16px)',
              WebkitBackdropFilter: 'blur(16px)',
              border: '1px solid oklch(1 0 0 / 0.1)',
              color: '#e0e0e0',
              fontFamily: 'system-ui, -apple-system, sans-serif',
              overflowY: 'auto',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>📝 博客写作详情</h2>
              <button
                onClick={() => setDetailSession(null)}
                style={{
                  background: 'none', border: 'none', color: '#888', fontSize: 20, cursor: 'pointer', padding: '0 4px',
                }}
              >
                ×
              </button>
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>{detailSession.topic}</div>
              <div style={{ fontSize: 12, color: '#888' }}>
                {detailSession.targetPlatform && `${detailSession.targetPlatform} · `}
                进度 {detailSession.percentComplete}% · 创建于 {formatSessionTime(detailSession.createdAt)}
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>工作流阶段</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {detailSession.stageStatuses.map((stage) => {
                  const colorMap: Record<string, string> = {
                    completed: '#22c55e',
                    running: '#60a5fa',
                    skipped: '#a78bfa',
                    failed: '#ef4444',
                    pending: '#555',
                  }
                  const labelMap: Record<string, string> = {
                    completed: '✓',
                    running: '▶',
                    skipped: '–',
                    failed: '✗',
                    pending: '○',
                  }
                  return (
                    <div
                      key={stage.stageId}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '3px 8px',
                        borderRadius: 6,
                        background: `oklch(0.2 0.02 ${stage.status === 'completed' ? 150 : 250} / 0.6)`,
                        border: `1px solid ${colorMap[stage.status] || '#555'}44`,
                        fontSize: 11,
                      }}
                    >
                      <span style={{ color: colorMap[stage.status] || '#888' }}>{labelMap[stage.status] || '○'}</span>
                      <span>{stage.label}</span>
                    </div>
                  )
                })}
              </div>
            </div>

            {detailSession.skippedStages > 0 && (
              <div style={{ fontSize: 11, color: '#a78bfa', marginBottom: 8 }}>
                已跳过 {detailSession.skippedStages} 个阶段
              </div>
            )}

            <div style={{ marginTop: 12, padding: 10, background: 'oklch(0 0 0 / 0.2)', borderRadius: 8 }}>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>操作提示</div>
              <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                {detailSession.completed
                  ? '✅ 此会话已完成。可开始新的博客写作。'
                  : `当前处于「${detailSession.currentStageLabel}」阶段。可通过 MCP 工具或对话推进。`}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 悬停提示 */}
      {hoveredStage && (
        <div
          style={{
            position: 'fixed',
            left: mousePos ? mousePos.x + (containerRef.current?.getBoundingClientRect().left || 0) + 16 : 0,
            top: mousePos ? mousePos.y + (containerRef.current?.getBoundingClientRect().top || 0) - 32 : 0,
            padding: '4px 10px',
            background: 'oklch(0.15 0.01 250 / 0.9)',
            borderRadius: 6,
            border: '1px solid oklch(1 0 0 / 0.1)',
            color: '#ccc',
            fontSize: 11,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            zIndex: 9998,
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        >
          {hoveredStage.stage.label}
          <span style={{ color: STAGE_STATUS_COLORS[hoveredStage.stage.status] || '#888', marginLeft: 6 }}>
            {STAGE_STATUS_LABELS[hoveredStage.stage.status]}
          </span>
        </div>
      )}

      {/* Canvas */}
      <div
        ref={containerRef}
        style={containerStyle}
      >
        <canvas
          ref={canvasRef}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
          style={{
            width: CANVAS_WIDTH,
            height: CANVAS_HEIGHT,
            borderRadius: '14px',
            display: 'block',
            cursor: payload?.hasActiveSessions ? 'pointer' : 'default',
          }}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => {
            setHoveredStage(null)
            setMousePos(null)
          }}
          onDoubleClick={handleDoubleClick}
          title={payload?.hasActiveSessions ? '双击查看详情' : undefined}
        />
      </div>
    </>
  )
}

// ════════════════════════════════════════════════════════════
// Widget 定义
// ════════════════════════════════════════════════════════════

export const blogKanbanWidget: IWallpaperWidgetDefinition = {
  id: 'blog-kanban-canvas',
  name: '博客写作看板',
  priority: 4,
  zone: 'overlay',
  shouldShow: (ctx) => {
    if (ctx.mode === 'focus') return false
    if (ctx.hideDecoration) return false
    return true
  },
  Component: BlogKanbanCanvas,
}
