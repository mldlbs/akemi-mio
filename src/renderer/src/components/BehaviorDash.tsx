import { useRef, useEffect } from 'react'
import type { FocusScoreState } from '../hooks/useFocusScore'

// =============================================================================
// BehaviorDash — 行为专注仪表盘小组件
// =============================================================================
//
// 在壁纸 Overlay 左下角显示渐变色进度条和专注状态文字。
// 鼠标穿透保持开启（继承自父容器 .wallpaper-overlay）。
//
// 行为:
//   - 渐变色进度条反映当前专注分数
//   - 简短文字描述专注等级
//   - 休息提醒时闪烁提示
//   - 全部通过 CSS transition 实现平滑动画
//
// =============================================================================

interface BehaviorDashProps {
  focus: FocusScoreState
}

export function BehaviorDash({ focus }: BehaviorDashProps) {
  const barRef = useRef<HTMLDivElement>(null)

  // ── 合成 style ──
  const barStyle: React.CSSProperties = {
    width: `${focus.progress * 100}%`,
    background: `linear-gradient(90deg, ${focus.gradientFrom}, ${focus.gradientTo})`,
    transition: 'width 0.8s ease, background 0.6s ease',
  }

  const containerStyle: React.CSSProperties = {
    borderColor: focus.color,
    transition: 'border-color 0.6s ease',
  }

  // ── 休息提醒闪烁 ──
  useEffect(() => {
    if (!barRef.current) return
    if (focus.restReminder) {
      barRef.current.classList.add('bdash-rest-pulse')
    } else {
      barRef.current.classList.remove('bdash-rest-pulse')
    }
  }, [focus.restReminder])

  return (
    <div className="bdash-container" style={containerStyle}>
      {/* ── 进度条轨道 ── */}
      <div className="bdash-track">
        <div ref={barRef} className="bdash-bar" style={barStyle} />
      </div>

      {/* ── 文字标签 ── */}
      <div className="bdash-labels">
        <span
          className={`bdash-label${focus.restReminder ? ' bdash-label-rest' : ''}`}
          style={{ color: focus.restReminder ? focus.color : undefined }}
        >
          {focus.label}
        </span>
        <span className="bdash-score">{focus.score}</span>
      </div>

      {/* ── 休息提醒详情 ── */}
      {focus.restReminder && focus.restReminderText && (
        <div className="bdash-rest-text">{focus.restReminderText}</div>
      )}
    </div>
  )
}
