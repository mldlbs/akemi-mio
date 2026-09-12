/**
 * MemoryFlashWidget — 记忆壁纸闪回模块
 *
 * 在桌面空闲时渐变显示近期对话记忆的简要摘要，形成不打扰的闪回。
 *
 * 数据流:
 *   MemoryContextService (main) → IPC push('wallpaper:memoryContext') → MemoryFlashWidget
 *
 * 交互:
 *   单击闪光摘要 → 展开显示完整记忆面板
 *   双击闪光摘要 → 打开最近话题（通过 chat IPC）
 *
 * 渲染:
 *   以 CSS 淡入淡出动画渲染在屏幕右下角半透明层。
 *   所有数据在本地渲染，不经过网络。
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
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

// =============================================================================
// 常量
// =============================================================================

/** 每条记忆显示时长 (ms) */
const DISPLAY_DURATION = 6000

/** 淡入淡出过渡时长 (ms) */
const FADE_DURATION = 700

/** 旋转总周期 (ms) */
const ROTATE_INTERVAL = DISPLAY_DURATION + FADE_DURATION * 2

/** 双击判定间隔 (ms) */
const DOUBLE_CLICK_THRESHOLD = 350

/** 闪回显示的最大卡片数 */
const MAX_FLASHBACK_CARDS = 3

/** 摘要截断长度 */
const SUMMARY_MAX_LENGTH = 55

// =============================================================================
// 工具函数
// =============================================================================

/**
 * 从记忆内容中提取简短摘要。
 * 策略：去掉前缀标签 → 取首句 → 截断至 SUMMARY_MAX_LENGTH。
 */
function extractSummary(content: string): string {
  // 去掉开头的 【xxx】 或 [xxx] 标签
  let text = content.replace(/^[【[][^】\]]*[】\]]\s*/, '')
  // 尝试取首句（中文句号、感叹号、问号、英文句号、换行）
  const sentenceMatch = text.match(/^([^。！？.!?\n]+[。！？.!?])/)
  if (sentenceMatch) {
    text = sentenceMatch[1]
  }
  // 截断
  return text.length > SUMMARY_MAX_LENGTH ? text.slice(0, SUMMARY_MAX_LENGTH - 3) + '...' : text
}

// =============================================================================
// 内置类型中文映射
// =============================================================================

const TYPE_LABELS: Record<string, string> = {
  user_fact: '个人偏好',
  interaction: '对话记录',
  task_state: '任务信息',
  user_profile: '用户画像',
  fictional: '印象',
  writing_feedback: '写作反馈',
}

// =============================================================================
// 子组件: 展开记忆面板
// =============================================================================

function ExpandedPanel({ cards, onClose }: { cards: MemoryCardData[]; onClose: () => void }) {
  return (
    <div className="wp-mem-flash-expanded">
      {/* 标题栏 */}
      <div className="wp-mem-flash-expanded-header">
        <span className="wp-mem-flash-expanded-title">💭 记忆闪回</span>
        <button
          className="wp-mem-flash-expanded-close"
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          title="关闭"
        >
          ✕
        </button>
      </div>

      {/* 卡片列表 */}
      <div className="wp-mem-flash-expanded-list">
        {cards.map((card) => {
          const typeLabel = TYPE_LABELS[card.type] || card.type
          return (
            <div key={card.id} className="wp-mem-flash-expanded-item">
              <div className="wp-mem-flash-expanded-type">{typeLabel}</div>
              <div className="wp-mem-flash-expanded-content">{extractSummary(card.content)}</div>
              {card.topics.length > 0 && (
                <div className="wp-mem-flash-expanded-topics">
                  {card.topics.slice(0, 3).map((t) => (
                    <span key={t} className="wp-mem-flash-expanded-topic">
                      #{t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// =============================================================================
// 主组件
// =============================================================================

function MemoryFlashPanel({ ctx: _ctx }: { ctx: WallpaperWidgetContext }) {
  const [payload, setPayload] = useState<MemoryContextPayload | null>(null)
  const [index, setIndex] = useState(0)
  const [fadeState, setFadeState] = useState<'fade-in' | 'visible' | 'fade-out'>('fade-in')
  const [expanded, setExpanded] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastClickRef = useRef(0)

  // ── 订阅记忆上下文 IPC 推送（rAF 批量合并） ──
  const setBatchedPayload = useBatchSetter<MemoryContextPayload>((d) => {
    setPayload(d)
  })
  useEffect(() => {
    const unsub = window.electronAPI.onMemoryContextData((data) => {
      setBatchedPayload(data as MemoryContextPayload)
    })
    return unsub
  }, [])

  // ── 旋转轮播：淡出 → 下一张 → 淡入 → 停留 → 重复 ──
  useEffect(() => {
    const cards = payload?.cards?.slice(0, MAX_FLASHBACK_CARDS) || []
    if (cards.length <= 1) return // 单条或空数据不轮转

    const cycle = () => {
      // 清除之前的定时器
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)

      // 1. 淡出
      setFadeState('fade-out')

      // 2. 淡出完成后切换到下一张并开始淡入
      fadeTimerRef.current = setTimeout(() => {
        setIndex((prev) => (prev + 1) % cards.length)
        setFadeState('fade-in')

        // 3. 淡入完成后进入 visible 状态
        fadeTimerRef.current = setTimeout(() => {
          setFadeState('visible')
        }, FADE_DURATION)
      }, FADE_DURATION)
    }

    // 首次进入：淡入
    setFadeState('fade-in')
    fadeTimerRef.current = setTimeout(() => {
      setFadeState('visible')
    }, FADE_DURATION)

    // 启动轮转定时器
    timeoutRef.current = setInterval(cycle, ROTATE_INTERVAL)

    return () => {
      if (timeoutRef.current) clearInterval(timeoutRef.current)
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    }
  }, [payload])

  // ── 点击处理 ──
  const handleInteraction = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      const now = Date.now()

      if (now - lastClickRef.current < DOUBLE_CLICK_THRESHOLD) {
        // 双击 → 打开最近话题
        const cards = payload?.cards?.slice(0, MAX_FLASHBACK_CARDS) || []
        const current = cards[index]
        if (current?.topics?.length && current.topics[0]) {
          window.electronAPI.chat(`告诉我关于 ${current.topics[0]} 的更多信息`).catch(() => {})
        }
        lastClickRef.current = 0
      } else {
        // 单击 → 切换展开面板
        setExpanded((prev) => !prev)
        lastClickRef.current = now
      }
    },
    [payload, index],
  )

  // ── 获取当前显示的卡片 ──
  const cards = payload?.cards?.slice(0, MAX_FLASHBACK_CARDS) || []
  const current = cards[index]

  // ── 空数据状态（有服务但无记忆或无卡片）：不显示 ──
  if (!current || cards.length === 0) return null

  // ── 加载中状态（等待首次 IPC 推送）：不显示 ──
  if (!payload) return null

  // ── 错误状态（有 error 且无有效卡片）：不显示 ──
  if (!payload.hasData || !!payload.error) return null

  const summary = extractSummary(current.content)

  // ── 展开面板 ──
  if (expanded) {
    return (
      <div className="wp-mem-flash-wrapper" onClick={handleInteraction}>
        <ExpandedPanel cards={cards} onClose={() => setExpanded(false)} />
      </div>
    )
  }

  // ── 闪回气泡 ──
  const fadeClass = fadeState === 'fade-out' ? 'wp-mem-flash-fade-out' : fadeState === 'fade-in' ? 'wp-mem-flash-fade-in' : ''

  return (
    <div className="wp-mem-flash-wrapper" onClick={handleInteraction} title="单击展开记忆面板，双击打开最近话题">
      <div className={`wp-mem-flash-bubble ${fadeClass}`}>
        <span className="wp-mem-flash-icon">💭</span>
        <span className="wp-mem-flash-text">{summary}</span>
      </div>
    </div>
  )
}

// =============================================================================
// Widget 定义
// =============================================================================

export const memoryFlashWidget: IWallpaperWidgetDefinition = {
  id: 'memory-flash',
  name: '记忆闪回',
  priority: 30,
  zone: 'overlay',
  shouldShow: (ctx: WallpaperWidgetContext) => {
    // 仅在 break 模式（空闲/休息）且不隐藏装饰时显示
    if (ctx.hideDecoration) return false
    if (ctx.mode === 'focus') return false
    // break 模式下隐私淡入太强时也不显示（保护隐私）
    if (ctx.mode === 'break' && ctx.privacyFade > 0.6) return false
    // multitasking 时不显示（增加信息负担）
    if (ctx.mode === 'multitasking') return false
    return true
  },
  Component: (ctx: WallpaperWidgetContext) => <MemoryFlashPanel ctx={ctx} />,
}
