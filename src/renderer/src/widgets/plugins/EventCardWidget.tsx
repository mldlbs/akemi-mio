/**
 * EventCardWidget — MCP 事件卡片壁纸 Widget
 *
 * 在桌面 WallpaperOverlay 上以浮动卡片形式显示 MCP 工具执行事件。
 * 卡片按优先级排序，支持鼠标穿透和点击交互。
 *
 * 功能：
 *   1. 通过 IPC 订阅 'wallpaper:event-cards' 通道接收事件卡片
 *   2. 按优先级排序显示（重要事件在前）
 *   3. 默认鼠标穿透，可点击卡片查看详情
 *   4. 卡片自动淡出（2 分钟 TTL）
 *   5. 面板可折叠/展开
 *
 * 区：overlay（在主面板下方浮动显示）
 * 可见性：始终显示（除非 hideDecoration）
 */

import React, { useState, useEffect, useCallback, useRef } from 'react'
import type { IWallpaperWidgetDefinition, WallpaperWidgetContext } from '../types'

// ════════════════════════════════════════════════════════════
// 类型定义（与 EventCardBridge 中一致）
// ════════════════════════════════════════════════════════════

type EventCardType =
  | 'tool_success'
  | 'tool_error'
  | 'tool_invoked'
  | 'evolution'
  | 'insight'
  | 'creativity'
  | 'workflow'
  | 'system'
  | 'agent_error'

type CardPriority = 1 | 2 | 3

interface EventCard {
  id: string
  type: EventCardType
  priority: CardPriority
  title: string
  summary: string
  icon: string
  timestamp: number
  toolName?: string
  actionable: boolean
  actionLabel?: string
  actionPayload?: Record<string, any>
}

// ════════════════════════════════════════════════════════════
// 色彩映射
// ════════════════════════════════════════════════════════════

const PRIORITY_COLORS: Record<CardPriority, { border: string; bg: string; glow: string }> = {
  1: { border: '#ef444466', bg: 'oklch(0.5 0.2 20 / 0.15)', glow: '#ef444433' }, // 高优先级-红色
  2: { border: '#60a5fa66', bg: 'oklch(0.3 0.1 250 / 0.12)', glow: '#60a5fa33' }, // 中优先级-蓝色
  3: { border: '#a78bfa44', bg: 'oklch(0.25 0.08 280 / 0.08)', glow: '#a78bfa22' }, // 低优先级-紫色
}

const TYPE_ICONS: Record<EventCardType, string> = {
  tool_success: '✅',
  tool_error: '❌',
  tool_invoked: '🛠️',
  evolution: '🧬',
  insight: '💡',
  creativity: '✨',
  workflow: '⚙️',
  system: '🖥️',
  agent_error: '🚨',
}

// ════════════════════════════════════════════════════════════
// 单个事件卡片
// ════════════════════════════════════════════════════════════

function EventCardItem({
  card,
  onDismiss,
  onAction,
}: {
  card: EventCard
  onDismiss: (id: string) => void
  onAction: (card: EventCard) => void
}) {
  const colors = PRIORITY_COLORS[card.priority]
  const [visible, setVisible] = useState(false)
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 进入动画
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 50)
    return () => clearTimeout(t)
  }, [])

  // 自动关闭（1.5 分钟后自动收起）
  useEffect(() => {
    dismissTimerRef.current = setTimeout(() => {
      setVisible(false)
      setTimeout(() => onDismiss(card.id), 400)
    }, 90_000)
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    }
  }, [card.id, onDismiss])

  // 格式化相对时间
  const timeAgo = useCallback(() => {
    const diff = Date.now() - card.timestamp
    if (diff < 5_000) return '刚刚'
    if (diff < 60_000) return `${Math.floor(diff / 1000)}秒前`
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`
    return `${Math.floor(diff / 3_600_000)}小时前`
  }, [card.timestamp])

  return (
    <div
      className={`wp-event-card${visible ? ' wp-event-card-visible' : ''}${
        card.actionable ? ' wp-event-card-actionable' : ''
      }`}
      style={{
        '--ec-border': colors.border,
        '--ec-bg': colors.bg,
        '--ec-glow': colors.glow,
        borderColor: colors.border,
        background: colors.bg,
      } as React.CSSProperties}
      onClick={card.actionable ? () => onAction(card) : undefined}
      title={card.actionable ? card.actionLabel || '点击查看详情' : undefined}
    >
      {/* 优先级指示条 */}
      <div className="wp-event-card-bar" style={{ background: colors.border.replace('66', 'cc') }} />

      {/* 卡片内容 */}
      <div className="wp-event-card-body">
        <div className="wp-event-card-header">
          <span className="wp-event-card-icon">{card.icon}</span>
          <span className="wp-event-card-title">{card.title}</span>
          <span className="wp-event-card-time">{timeAgo()}</span>
        </div>
        <div className="wp-event-card-summary">{card.summary}</div>
      </div>

      {/* 关闭按钮 */}
      <button
        className="wp-event-card-close"
        onClick={(e) => {
          e.stopPropagation()
          setVisible(false)
          setTimeout(() => onDismiss(card.id), 400)
        }}
        aria-label="关闭"
      >
        ×
      </button>
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// 事件卡片容器
// ════════════════════════════════════════════════════════════

function EventCardContainer({ hideDecoration }: WallpaperWidgetContext) {
  const [cards, setCards] = useState<EventCard[]>([])
  const [expanded, setExpanded] = useState(true)
  const [detailCard, setDetailCard] = useState<EventCard | null>(null)
  const cardsRef = useRef<EventCard[]>([])

  // ── 订阅 IPC 卡片数据 ──
  useEffect(() => {
    const unsub = (window as any).electronAPI?.onEventCards?.((payload: EventCard[]) => {
      if (Array.isArray(payload)) {
        cardsRef.current = payload
        setCards(payload)
      }
    })
    return () => {
      if (typeof unsub === 'function') unsub()
    }
  }, [])

  // ── 轮询刷新（兜底，防止 IPC 推送丢失） ──
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await (window as any).electronAPI?.getEventCards?.()
        if (res?.cards && Array.isArray(res.cards)) {
          cardsRef.current = res.cards
          setCards(res.cards)
        }
      } catch {
        // 静默失败
      }
    }, 15_000)
    return () => clearInterval(interval)
  }, [])

  // ── 关闭卡片 ──
  const handleDismiss = useCallback((id: string) => {
    setCards((prev) => prev.filter((c) => c.id !== id))
  }, [])

  // ── 点击卡片详情 ──
  const handleAction = useCallback((card: EventCard) => {
    setDetailCard(card)
  }, [])

  // ── 隐藏状态下不渲染 ──
  if (hideDecoration) return null

  // ── 按优先级排序 ──
  const sortedCards = [...cards].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    return b.timestamp - a.timestamp
  })

  // 展开时显示最多 5 张，折叠时显示最多 2 张
  const displayCards = expanded ? sortedCards.slice(0, 5) : sortedCards.slice(0, 2)

  if (sortedCards.length === 0) return null

  return (
    <div className={`wp-event-card-container${!expanded ? ' wp-event-card-collapsed' : ''}`}>
      {/* 详情弹窗 */}
      {detailCard && (
        <div className="wp-event-card-detail-overlay" onClick={() => setDetailCard(null)}>
          <div className="wp-event-card-detail" onClick={(e) => e.stopPropagation()}>
            <div className="wp-event-card-detail-header">
              <span className="wp-event-card-detail-icon">{detailCard.icon}</span>
              <span className="wp-event-card-detail-title">{detailCard.title}</span>
              <button
                className="wp-event-card-close"
                onClick={() => setDetailCard(null)}
                aria-label="关闭"
              >
                ×
              </button>
            </div>
            <div className="wp-event-card-detail-body">
              <div className="wp-event-card-detail-row">
                <span className="wp-event-card-detail-label">类型</span>
                <span className="wp-event-card-detail-value">{detailCard.type}</span>
              </div>
              {detailCard.toolName && (
                <div className="wp-event-card-detail-row">
                  <span className="wp-event-card-detail-label">工具</span>
                  <span className="wp-event-card-detail-value">{detailCard.toolName}</span>
                </div>
              )}
              <div className="wp-event-card-detail-row">
                <span className="wp-event-card-detail-label">优先级</span>
                <span className="wp-event-card-detail-value">
                  {detailCard.priority === 1 ? '高' : detailCard.priority === 2 ? '中' : '低'}
                </span>
              </div>
              <div className="wp-event-card-detail-row">
                <span className="wp-event-card-detail-label">时间</span>
                <span className="wp-event-card-detail-value">
                  {new Date(detailCard.timestamp).toLocaleString('zh-CN')}
                </span>
              </div>
              <div className="wp-event-card-detail-separator" />
              <div className="wp-event-card-detail-summary">{detailCard.summary}</div>
              {detailCard.actionPayload && (
                <div className="wp-event-card-detail-payload">
                  <div className="wp-event-card-detail-label">详情数据</div>
                  <pre className="wp-event-card-detail-json">
                    {JSON.stringify(detailCard.actionPayload, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 折叠/展开按钮 */}
      {sortedCards.length > 2 && (
        <button
          className="wp-event-card-expand-btn"
          onClick={() => setExpanded((prev) => !prev)}
          title={expanded ? '折叠' : `展开 (${sortedCards.length} 条)`}
        >
          <span className="wp-event-card-expand-count">{sortedCards.length}</span>
          <i className={`ri-arrow-${expanded ? 'down' : 'up'}-s-line`} />
        </button>
      )}

      {/* 卡片列表 */}
      {displayCards.map((card) => (
        <EventCardItem
          key={card.id}
          card={card}
          onDismiss={handleDismiss}
          onAction={handleAction}
        />
      ))}
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// Widget 定义
// ════════════════════════════════════════════════════════════

export const eventCardWidget: IWallpaperWidgetDefinition = {
  id: 'event-card',
  name: 'MCP 事件卡片',
  priority: 3,
  zone: 'overlay',
  shouldShow: () => true,
  Component: EventCardContainer,
}
