/**
 * MemoryContextWidget — 桌面记忆浮窗卡片组件
 *
 * 在桌面 Overlay 上显示最近的高关联记忆卡片列表。
 * 每 10 分钟自动刷新，支持显示类型配置和鼠标穿透。
 *
 * 数据流:
 *   MemoryContextService (main) → IPC push → MemoryContextWidget (renderer)
 *
 * 模式适配：作为 IWallpaperWidgetDefinition 插件，
 * 通过 shouldShow 控制可见性，通过 Component 渲染内容。
 */

import React, { useState, useEffect, useCallback } from 'react'
import type { IWallpaperWidgetDefinition, WallpaperWidgetContext } from '../types'
import { useBatchSetter } from '../../hooks/useBatchSetter'

// =============================================================================
// 类型
// =============================================================================

interface MemoryCardData {
  id: string
  content: string
  type: string
  confidence: number
  tier: string
  topics: string[]
  behaviorScore: number
  isPinned: boolean
  createdAt: number
  updatedAt: number
}

interface MemoryContextPayload {
  cards: MemoryCardData[]
  updatedAt: number
  hasData: boolean
  displayType: string
  error?: string
}

type MemoryContextDisplayType = 'all' | 'learning' | 'interests' | 'tasks' | 'facts'

interface MemoryContextConfig {
  enabled: boolean
  displayType: MemoryContextDisplayType
  pollIntervalMs: number
  maxCards: number
  mouseThrough: boolean
}

// =============================================================================
// 常量
// =============================================================================

/** 类型 → 中文标签映射 */
const TYPE_LABELS: Record<string, string> = {
  user_fact: '用户偏好',
  interaction: '交互记录',
  task_state: '任务状态',
  user_profile: '用户画像',
  fictional: '虚构记忆',
  writing_feedback: '写作反馈',
  polishing_decision: '润色决策',
}

/** 层级 → 标签映射 */
const TIER_LABELS: Record<string, string> = {
  permanent: '永久',
  semi: '半永久',
  ephemeral: '临时',
}

/** 层级 → 颜色映射 */
const TIER_COLORS: Record<string, string> = {
  permanent: '#f59e0b',
  semi: '#60a5fa',
  ephemeral: '#888',
}

/** 显示类型 → 中文标签 */
const DISPLAY_TYPE_LABELS: Record<MemoryContextDisplayType, string> = {
  all: '全部记忆',
  learning: '学习计划',
  interests: '兴趣标签',
  tasks: '任务状态',
  facts: '用户偏好',
}

/** 卡片最大显示字符数 */
const MAX_CONTENT_LENGTH = 100

// =============================================================================
// 子组件: 单条记忆卡片
// =============================================================================

function MemoryCard({ card, isLast }: { card: MemoryCardData; isLast: boolean }) {
  const tierColor = TIER_COLORS[card.tier] || '#888'
  const typeLabel = TYPE_LABELS[card.type] || card.type
  const displayContent = card.content.length > MAX_CONTENT_LENGTH ? card.content.slice(0, MAX_CONTENT_LENGTH - 3) + '...' : card.content

  return (
    <div className={`wp-mem-card ${isLast ? 'wp-mem-card--last' : ''}`}>
      {/* 头部：类型标签 + 层级指示器 */}
      <div className="wp-mem-card-header">
        <span className="wp-mem-card-type">{typeLabel}</span>
        <span className="wp-mem-card-tier" style={{ color: tierColor }}>
          {TIER_LABELS[card.tier] || card.tier}
        </span>
        {card.isPinned && (
          <span className="wp-mem-card-pinned" title="已固定">
            📌
          </span>
        )}
      </div>

      {/* 内容 */}
      <div className="wp-mem-card-content" title={card.content}>
        {displayContent}
      </div>

      {/* 底部：置信度 + 主题标签 */}
      <div className="wp-mem-card-footer">
        <span className="wp-mem-card-confidence">置信度 {Math.round(card.confidence * 100)}%</span>
        {card.topics.length > 0 && (
          <span className="wp-mem-card-topics">
            {card.topics.slice(0, 3).map((t, i) => (
              <span key={i} className="wp-mem-card-topic">
                #{t}
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  )
}

// =============================================================================
// 主组件
// =============================================================================

function MemoryContextPanel({ ctx }: { ctx: WallpaperWidgetContext }) {
  const [payload, setPayload] = useState<MemoryContextPayload | null>(null)
  const [config, setConfig] = useState<MemoryContextConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [displayType, setDisplayType] = useState<MemoryContextDisplayType>('all')
  const [showConfig, setShowConfig] = useState(false)

  // 加载配置
  useEffect(() => {
    const loadConfig = async () => {
      try {
        const cfg = await window.electronAPI.getMemoryContextConfig()
        setConfig(cfg as MemoryContextConfig)
        setDisplayType((cfg as MemoryContextConfig).displayType)
      } catch {
        // 静默失败，使用默认值
      }
    }
    loadConfig()
  }, [])

  // 订阅记忆上下文推送（rAF 批量合并）
  const setBatchedPayload = useBatchSetter<MemoryContextPayload>((d) => {
    setPayload(d)
    if (d.error) {
      setError(d.error)
    } else {
      setError(null)
    }
  })
  useEffect(() => {
    const unsub = window.electronAPI.onMemoryContextData((data) => {
      setBatchedPayload(data as MemoryContextPayload)
    })
    return unsub
  }, [setBatchedPayload])

  // 切换显示类型
  const handleDisplayTypeChange = useCallback(async (newType: MemoryContextDisplayType) => {
    setDisplayType(newType)
    try {
      await window.electronAPI.setMemoryContextConfig({ displayType: newType })
    } catch {
      // 静默失败
    }
  }, [])

  // 切换折叠
  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => !prev)
  }, [])

  // 切换配置面板
  const toggleConfig = useCallback(() => {
    setShowConfig((prev) => !prev)
  }, [])

  // 错误状态
  if (error && !payload?.hasData) {
    return (
      <div className="wp-mem-panel wp-mem-panel--error" title={error}>
        <div className="wp-mem-panel-title">
          <span className="wp-mem-panel-icon">🧠</span>
          记忆浮窗
        </div>
        <div className="wp-mem-error">加载失败</div>
      </div>
    )
  }

  // 空数据状态（有服务但无记忆）
  if (payload && !payload.hasData && !error) {
    return (
      <div className="wp-mem-panel wp-mem-panel--empty">
        <div className="wp-mem-panel-title">
          <span className="wp-mem-panel-icon">🧠</span>
          记忆浮窗
          <span className="wp-mem-panel-subtitle">暂无记忆</span>
        </div>
      </div>
    )
  }

  // 无数据（服务未就绪）
  if (!payload) {
    return (
      <div className="wp-mem-panel wp-mem-panel--loading">
        <div className="wp-mem-panel-title">
          <span className="wp-mem-panel-icon">🧠</span>
          记忆浮窗
          <span className="wp-mem-panel-subtitle">等待数据…</span>
        </div>
      </div>
    )
  }

  // 折叠状态
  if (collapsed) {
    return (
      <div className="wp-mem-panel wp-mem-panel--collapsed" onClick={toggleCollapsed} title="展开记忆浮窗">
        <span className="wp-mem-panel-icon">🧠</span>
        <span className="wp-mem-collapsed-count">{payload.cards.length}</span>
      </div>
    )
  }

  const currentLabel = DISPLAY_TYPE_LABELS[displayType] || '全部记忆'

  return (
    <div className="wp-mem-panel">
      {/* 标题栏 */}
      <div className="wp-mem-panel-header">
        <div className="wp-mem-panel-title" onClick={toggleCollapsed}>
          <span className="wp-mem-panel-icon">🧠</span>
          {currentLabel}
          <span className="wp-mem-panel-count">{payload.cards.length}</span>
        </div>
        <div className="wp-mem-panel-actions">
          <button className="wp-mem-config-btn" onClick={toggleConfig} title="切换显示类型">
            ⚙️
          </button>
          <button className="wp-mem-collapse-btn" onClick={toggleCollapsed} title="折叠">
            −
          </button>
        </div>
      </div>

      {/* 配置面板 */}
      {showConfig && (
        <div className="wp-mem-config-dropdown">
          {(['all', 'learning', 'interests', 'tasks', 'facts'] as MemoryContextDisplayType[]).map((type) => (
            <button
              key={type}
              className={`wp-mem-config-option ${displayType === type ? 'wp-mem-config-option--active' : ''}`}
              onClick={() => handleDisplayTypeChange(type)}
            >
              {DISPLAY_TYPE_LABELS[type]}
            </button>
          ))}
        </div>
      )}

      {/* 卡片列表 */}
      <div className="wp-mem-card-list">
        {payload.cards.map((card, i) => (
          <MemoryCard key={card.id} card={card} isLast={i === payload.cards.length - 1} />
        ))}
      </div>

      {/* 底部信息 */}
      <div className="wp-mem-panel-footer">
        <span className="wp-mem-refresh-time">{formatTime(payload.updatedAt)}</span>
        {config?.mouseThrough && (
          <span className="wp-mem-through-hint" title="鼠标穿透已启用">
            🖱️ 穿透
          </span>
        )}
      </div>
    </div>
  )
}

// =============================================================================
// 工具函数
// =============================================================================

function formatTime(timestamp: number): string {
  const d = new Date(timestamp)
  const now = Date.now()
  const diffMs = now - timestamp

  if (diffMs < 60_000) return '刚刚'
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)} 分钟前`
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

// =============================================================================
// Widget 定义
// =============================================================================

export const memoryContextWidget: IWallpaperWidgetDefinition = {
  id: 'memory-context',
  name: '记忆浮窗',
  priority: 20,
  zone: 'overlay',
  shouldShow: (ctx: WallpaperWidgetContext) => {
    // 仅在非专注模式、非隐藏装饰时显示
    if (ctx.hideDecoration) return false
    if (ctx.mode === 'focus') return false
    return true
  },
  Component: (ctx: WallpaperWidgetContext) => <MemoryContextPanel ctx={ctx} />,
}
