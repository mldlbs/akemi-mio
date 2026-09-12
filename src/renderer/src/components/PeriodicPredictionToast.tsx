import { useState, useEffect, useCallback } from 'react'

// =============================================================================
// PeriodicPredictionToast — 行为预测哑提醒组件
// =============================================================================
//
// 从主进程接收行为预测事件，以非侵入方式展示预测内容。
// 支持两种预测来源:
//   1. BehaviorPeriodicPredictor — 查询话题预测（如"听音乐""查看天气"）
//   2. AsrKeywordActionTracker — ASR 关键词驱动的动作预测（如"上午好，要打开浏览器吗？"）
//
// 轻打扰设计:
//   - 小图标展示，不抢占焦点
//   - 悬停/点击展开详情
//   - 用户可一键忽略
//   - 过期自动消失
//
// =============================================================================

/** 预测事件数据结构（与主进程 BehaviorPeriodicPredictor.ts 对齐） */
interface PredictionEvent {
  topic: string
  description: string
  confidence: number
  associatedTool?: string
  preloaded: boolean
  eventId: string
  expiresAt: number
}

// =============================================================================
// 话题图标映射
// =============================================================================

const TOPIC_ICONS: Record<string, string> = {
  '天气': '🌤️',
  '时间': '🕐',
  '新闻': '📰',
  '编程': '💻',
  '写作': '✍️',
  '学习': '📚',
  '翻译': '🔤',
  '图片': '🎨',
  '音乐': '🎵',
  '视频': '🎬',
  '搜索': '🔍',
  '设置': '⚙️',
  '帮助': '❓',
  '推荐': '👍',
  '日程': '📅',
  '交通': '🚗',
  // ASR 关键词驱动的动作预测（英文 action category）
  'browse': '🌐',
  'music': '🎵',
  'weather': '🌤️',
  'news': '📰',
  'code': '💻',
  'schedule': '📅',
  'write': '✍️',
  'translate': '🔤',
  'image': '🎨',
  'study': '📚',
  'video': '🎬',
  'help': '❓',
}

/** ASR 动作类别列表（用于判断事件类型） */
const ASR_ACTION_CATEGORIES = new Set([
  'browse', 'music', 'weather', 'news', 'code',
  'schedule', 'write', 'translate', 'image', 'study', 'video', 'help',
])

/** 根据话题获取图标 */
function getTopicIcon(topic: string): string {
  return TOPIC_ICONS[topic] || '💡'
}

/** 判断事件是否为 ASR 语音习惯动作提示 */
function isAsrActionHint(topic: string): boolean {
  return ASR_ACTION_CATEGORIES.has(topic)
}

// =============================================================================
// 组件
// =============================================================================

export function PeriodicPredictionToast() {
  const [events, setEvents] = useState<PredictionEvent[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // ── 订阅预测事件 ──
  useEffect(() => {
    const unsub = (window as any).electronAPI?.onBehaviorPrediction?.((data: PredictionEvent) => {
      setEvents((prev) => {
        // 去重：相同 topic 替换旧事件
        const filtered = prev.filter((e) => e.topic !== data.topic)
        return [...filtered, data].sort((a, b) => b.confidence - a.confidence)
      })
    })
    return () => unsub?.()
  }, [])

  // ── 定期清理过期事件 ──
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      setEvents((prev) => prev.filter((e) => e.expiresAt > now))
    }, 30_000)
    return () => clearInterval(timer)
  }, [])

  // ── 忽略/关闭事件 ──
  const dismissEvent = useCallback((eventId: string) => {
    setEvents((prev) => prev.filter((e) => e.eventId !== eventId))
  }, [])

  // ── 展开/收起详情 ──
  const toggleExpand = useCallback((eventId: string) => {
    setExpandedId((prev) => (prev === eventId ? null : eventId))
  }, [])

  if (events.length === 0) return null

  return (
    <div className="prediction-toast-container">
      {events.map((event) => {
        const isExpanded = expandedId === event.eventId
        const confidencePct = Math.round(event.confidence * 100)
        const isAction = isAsrActionHint(event.topic)

        return (
          <div
            key={event.eventId}
            className={`prediction-toast-item ${isExpanded ? 'expanded' : ''} ${isAction ? 'asr-action-hint' : ''}`}
            onClick={() => toggleExpand(event.eventId)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') toggleExpand(event.eventId)
            }}
          >
            {/* 紧凑视图：图标 + 简短描述 */}
            <div className="prediction-toast-compact">
              <span className="prediction-toast-icon">{getTopicIcon(event.topic)}</span>
              <span className={`prediction-toast-text ${isAction ? 'prediction-toast-action-text' : ''}`}>
                {event.description}
              </span>
              <span className="prediction-toast-confidence">{confidencePct}%</span>
              <button
                className="prediction-toast-dismiss"
                onClick={(e) => {
                  e.stopPropagation()
                  dismissEvent(event.eventId)
                }}
                title="忽略"
                aria-label="忽略此预测"
              >
                ×
              </button>
            </div>

            {/* 展开视图：详细信息 */}
            {isExpanded && (
              <div className="prediction-toast-detail">
                <div className="prediction-toast-detail-row">
                  <span className="prediction-toast-detail-label">类型</span>
                  <span>{isAction ? '🎤 语音习惯预测' : '📊 行为模式预测'}</span>
                </div>
                <div className="prediction-toast-detail-row">
                  <span className="prediction-toast-detail-label">话题</span>
                  <span>{event.topic}</span>
                </div>
                {event.associatedTool && (
                  <div className="prediction-toast-detail-row">
                    <span className="prediction-toast-detail-label">关联工具</span>
                    <span>{event.associatedTool}</span>
                  </div>
                )}
                <div className="prediction-toast-detail-row">
                  <span className="prediction-toast-detail-label">预加载</span>
                  <span>{event.preloaded ? '✅ 已就绪' : '⏳ 待加载'}</span>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
