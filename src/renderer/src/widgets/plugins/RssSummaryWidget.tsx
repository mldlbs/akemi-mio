/**
 * RssSummaryWidget — 信息摘要面板
 *
 * 在 browsing 情境下显示待办事项和技术资讯摘要。
 *
 * 模式适配：作为 IWallpaperWidgetDefinition 插件，
 * 通过 shouldShow 控制可见性，通过 Component 渲染内容。
 */

import React from 'react'
import type { IWallpaperWidgetDefinition, WallpaperWidgetContext } from '../types'

// =============================================================================
// 示例数据（未来可从主进程推送）
// =============================================================================

const SAMPLE_RSS_ITEMS = [
  { title: 'TypeScript 5.8 发布公告', source: 'Dev Blog', time: '2h 前' },
  { title: 'React 19 新特性概览', source: 'React Blog', time: '1d 前' },
  { title: 'Vite 6 迁移指南', source: 'Vite', time: '3d 前' },
]

// ── 简易待办项类型 ──
interface TodoItem {
  id: string
  text: string
  done: boolean
}

// =============================================================================
// 组件
// =============================================================================

function RssSummary() {
  // 从 localStorage 读取待办事项
  const [todos, setTodos] = React.useState<TodoItem[]>([])

  React.useEffect(() => {
    const loadTodos = () => {
      try {
        const stored = localStorage.getItem('mio_todos')
        if (stored) {
          setTodos(JSON.parse(stored))
        }
      } catch {
        // 静默失败
      }
    }
    loadTodos()
    window.addEventListener('storage', loadTodos)
    return () => window.removeEventListener('storage', loadTodos)
  }, [])

  const activeTodos = todos.filter((t) => !t.done).slice(0, 5)

  return (
    <div className="wp-context-panel wp-rss-summary">
      <div className="wp-context-panel-header">
        <span className="wp-context-panel-icon">📋</span>
        <span className="wp-context-panel-title">信息摘要</span>
      </div>

      {activeTodos.length > 0 && (
        <div className="wp-rss-section">
          <div className="wp-rss-section-title">待办事项</div>
          {activeTodos.map((todo) => (
            <div key={todo.id} className="wp-rss-item">
              <span className="wp-rss-item-icon">☐</span>
              <span className="wp-rss-item-text">{todo.text}</span>
            </div>
          ))}
        </div>
      )}

      <div className="wp-rss-section">
        <div className="wp-rss-section-title">最新动态</div>
        {SAMPLE_RSS_ITEMS.map((item, i) => (
          <div key={i} className="wp-rss-item">
            <span className="wp-rss-item-source">{item.source}</span>
            <span className="wp-rss-item-text">{item.title}</span>
            <span className="wp-rss-item-time">{item.time}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// =============================================================================
// Widget 定义
// =============================================================================

export const rssSummaryWidget: IWallpaperWidgetDefinition = {
  id: 'rss-summary',
  name: '信息摘要',
  priority: 20,
  zone: 'overlay',
  shouldShow: (ctx) => {
    if (ctx.hideDecoration) return false
    return ctx.context === 'browsing' && ctx.config.enabled
  },
  Component: RssSummary,
}
