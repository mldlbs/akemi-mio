// =============================================================================
// TaskSwitcher — 浮动任务切换器（多任务模式）
// =============================================================================
//
// 在壁纸 Overlay 中显示，帮助用户感知最近的窗口/应用切换。
// 鼠标穿透保持开启（继承自父容器 pointer-events: none）。
//
// 行为:
//   - 显示最近的应用切换记录（类别图标 + 文字）
//   - 浮动在屏幕中央偏下位置
//   - 自动动画进出
//   - 全部通过 CSS transition 实现平滑动画
//   - 鼠标穿透不干扰操作
//
// =============================================================================

import { useState, useEffect } from 'react'

// ── 类别中文名与图标 ──
const CATEGORY_INFO: Record<string, { label: string; icon: string }> = {
  code: { label: '编码', icon: '💻' },
  browser: { label: '浏览器', icon: '🌐' },
  media: { label: '娱乐', icon: '🎵' },
  communication: { label: '通讯', icon: '💬' },
  other: { label: '其他', icon: '📄' },
}

interface SwitchEntry {
  fromCategory: string
  toCategory: string
}

interface TaskSwitcherProps {
  /** 最近切换记录 */
  switches: SwitchEntry[]
  /** 是否可见 */
  visible: boolean
}

export function TaskSwitcher({ switches, visible }: TaskSwitcherProps) {
  const [prevSwitches, setPrevSwitches] = useState<SwitchEntry[]>([])

  // 当 switches 变化时平滑过渡
  useEffect(() => {
    if (switches.length > 0) {
      setPrevSwitches(switches)
    }
  }, [switches])

  // 取最近的切换记录，去重
  const displaySwitches = (switches.length > 0 ? switches : prevSwitches)
    .filter((s, i, arr) => {
      // 去重
      if (i === 0) return true
      return s.fromCategory !== arr[i - 1].fromCategory || s.toCategory !== arr[i - 1].toCategory
    })
    .slice(-4)
    .reverse() // 最新的在前

  if (!visible || displaySwitches.length === 0) return null

  // 从类别信息中获取样式
  const fromInfo = CATEGORY_INFO[displaySwitches[0]?.fromCategory] || CATEGORY_INFO.other
  const toInfo = CATEGORY_INFO[displaySwitches[0]?.toCategory] || CATEGORY_INFO.other

  return (
    <div className="wp-task-switcher">
      <div className="wp-ts-header">
        <span className="wp-ts-dot" />
        <span className="wp-ts-label">多任务切换</span>
      </div>

      {/* 最新切换高亮 */}
      <div className="wp-ts-current">
        <span className="wp-ts-icon">{fromInfo.icon}</span>
        <span className="wp-ts-arrow">→</span>
        <span className="wp-ts-icon">{toInfo.icon}</span>
        <span className="wp-ts-text">
          {fromInfo.label} → {toInfo.label}
        </span>
      </div>

      {/* 历史切换列表 */}
      {displaySwitches.length > 1 && (
        <div className="wp-ts-history">
          {displaySwitches.slice(1).map((s, i) => {
            const fi = CATEGORY_INFO[s.fromCategory] || CATEGORY_INFO.other
            const ti = CATEGORY_INFO[s.toCategory] || CATEGORY_INFO.other
            return (
              <div key={i} className="wp-ts-history-item">
                <span className="wp-ts-icon-sm">{fi.icon}</span>
                <span className="wp-ts-arrow-sm">→</span>
                <span className="wp-ts-icon-sm">{ti.icon}</span>
                <span className="wp-ts-text-sm">{ti.label}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
