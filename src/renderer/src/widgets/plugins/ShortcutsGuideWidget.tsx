/**
 * ShortcutsGuideWidget — 快捷键指南
 *
 * 在 coding 情境下显示常用快捷键参考。
 *
 * 模式适配：作为 IWallpaperWidgetDefinition 插件，
 * 通过 shouldShow 控制可见性，通过 Component 渲染内容。
 */

import React from 'react'
import type { IWallpaperWidgetDefinition, WallpaperWidgetContext } from '../types'

// =============================================================================
// 快捷键列表
// =============================================================================

const CODE_SHORTCUTS = [
  { keys: 'Ctrl+Shift+P', desc: '命令面板' },
  { keys: 'Ctrl+P', desc: '快速打开文件' },
  { keys: 'Ctrl+F', desc: '当前文件搜索' },
  { keys: 'Ctrl+Shift+F', desc: '全局搜索' },
  { keys: 'Ctrl+`', desc: '终端切换' },
  { keys: 'Ctrl+D', desc: '选中下一个匹配' },
  { keys: 'Alt+↑/↓', desc: '移动行' },
  { keys: 'Ctrl+/', desc: '注释切换' },
]

// =============================================================================
// 组件
// =============================================================================

function ShortcutsGuide() {
  return (
    <div className="wp-context-panel wp-shortcuts-guide">
      <div className="wp-context-panel-header">
        <span className="wp-context-panel-icon">⌨️</span>
        <span className="wp-context-panel-title">常用快捷键</span>
      </div>
      <div className="wp-shortcuts-grid">
        {CODE_SHORTCUTS.map((s, i) => (
          <div key={i} className="wp-shortcut-item">
            <kbd className="wp-shortcut-keys">{s.keys}</kbd>
            <span className="wp-shortcut-desc">{s.desc}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// =============================================================================
// Widget 定义
// =============================================================================

export const shortcutsGuideWidget: IWallpaperWidgetDefinition = {
  id: 'shortcuts-guide',
  name: '快捷键指南',
  priority: 10,
  zone: 'overlay',
  shouldShow: (ctx) => {
    if (ctx.hideDecoration) return false
    return ctx.context === 'coding' && ctx.config.enabled
  },
  Component: ShortcutsGuide,
}
