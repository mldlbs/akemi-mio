/**
 * FileOrganizerProgressWidget — 文件整理进度可视化壁纸组件
 *
 * 在桌面 overlay 上实时展示文件整理（移动）过程。
 *
 * 功能：
 * 1. 显示整理会话状态（空闲/整理中/已暂停/已完成）
 * 2. 进度条和文件计数统计
 * 3. 当前移动文件的动画指示
 * 4. 最近移动记录列表
 * 5. 暂停/继续/跳过控制按钮
 * 6. 完成后自动淡出摘要
 * 7. 专注模式自动隐藏
 */

import React, { useState, useEffect, useRef } from 'react'
import type { IWallpaperWidgetDefinition, WallpaperWidgetContext } from '../types'

// =============================================================================
// 类型定义
// =============================================================================

interface FileMoveResult {
  filePath: string
  sourcePath: string
  targetPath: string
  ruleId: string
  ruleSource: string
  status: 'moving' | 'completed' | 'skipped' | 'failed'
  durationMs?: number
  error?: string
  reason?: string
  timestamp: number
}

interface OrganizerProgress {
  status: 'idle' | 'organizing' | 'paused' | 'completed'
  totalFiles: number
  completedFiles: number
  failedFiles: number
  skippedFiles: number
  currentFile: string | null
  currentTarget: string | null
  percentComplete: number
  recentMoves: FileMoveResult[]
  startTime: number | null
  endTime: number | null
  summary: string
  isPaused: boolean
  updatedAt: number
}

// =============================================================================
// 常量
// =============================================================================

/** 淡出动画持续时间（ms） */
const FADE_OUT_DURATION = 2000

/** 状态图标映射 */
const STATUS_ICONS: Record<string, string> = {
  completed: '✓',
  skipped: '→',
  failed: '✗',
  moving: '●',
}

/** 状态颜色映射 */
const STATUS_COLORS: Record<string, string> = {
  completed: '#4ade80',
  skipped: '#fbbf24',
  failed: '#f87171',
  moving: '#60a5fa',
}

// =============================================================================
// 辅助组件
// =============================================================================

/** 单条文件移动记录行 */
function FileMoveRow({ move, index }: { move: FileMoveResult; index: number }) {
  const fileName = move.filePath.split('/').pop() || move.filePath.split('\\').pop() || move.filePath
  const targetDir = move.targetPath.split('/').slice(0, -1).join('/') || '.'
  const isLatest = index === 0

  return (
    <div className={`wp-org-move-row${isLatest ? ' wp-org-move-latest' : ''}`} style={{ animationDelay: `${index * 30}ms` }}>
      <span className="wp-org-move-icon" style={{ color: STATUS_COLORS[move.status] || '#94a3b8' }} title={move.status}>
        {STATUS_ICONS[move.status] || '•'}
      </span>
      <span className="wp-org-move-file" title={move.filePath}>
        {fileName}
      </span>
      <span className="wp-org-move-arrow">→</span>
      <span className="wp-org-move-target" title={move.targetPath}>
        {targetDir}
      </span>
      {move.status === 'failed' && move.error && (
        <span className="wp-org-move-error" title={move.error}>
          !
        </span>
      )}
    </div>
  )
}

/** 进度条组件 */
function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="wp-org-progress-track">
      <div className="wp-org-progress-fill" style={{ width: `${percent}%` }} />
    </div>
  )
}

// =============================================================================
// 主组件
// =============================================================================

function FileOrganizerProgressPanel({ hideDecoration }: WallpaperWidgetContext) {
  const [progress, setProgress] = useState<OrganizerProgress | null>(null)
  const [fadeOut, setFadeOut] = useState(false)
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── 订阅 IPC 进度事件 ──
  useEffect(() => {
    const unsub = window.electronAPI.onOrganizerProgress((data) => {
      setProgress(data)
      setFadeOut(false)

      // 完成时触发淡出
      if (data.status === 'completed') {
        if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
        fadeTimerRef.current = setTimeout(() => {
          setFadeOut(true)
        }, 4000)
      }
    })

    return () => {
      unsub()
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    }
  }, [])

  // ── 没有活跃数据或状态空闲 → 不渲染 ──
  if (!progress || progress.status === 'idle') return null

  // 专注模式隐藏
  if (hideDecoration) return null

  // ── 完成状态判断 ──
  const isFinished = progress.status === 'completed'

  return (
    <div
      className={`wp-org-panel${isFinished && fadeOut ? ' wp-org-fade-out' : ''}`}
      style={{
        animationDuration: isFinished && fadeOut ? `${FADE_OUT_DURATION}ms` : undefined,
      }}
    >
      {/* ── 标题栏 ── */}
      <div className="wp-org-header">
        <span className="wp-org-title">{progress.isPaused ? '⏸ 整理已暂停' : isFinished ? '✅ 整理完成' : '📁 文件整理中'}</span>
        {!isFinished && <span className="wp-org-percent">{progress.percentComplete}%</span>}
      </div>

      {/* ── 进度条 ── */}
      {!isFinished && <ProgressBar percent={progress.percentComplete} />}

      {/* ── 统计摘要行 ── */}
      <div className="wp-org-stats">
        {progress.totalFiles > 0 && (
          <span className="wp-org-stat">
            总计 <strong>{progress.totalFiles}</strong>
          </span>
        )}
        {progress.completedFiles > 0 && (
          <span className="wp-org-stat wp-org-stat-ok">
            已完成 <strong>{progress.completedFiles}</strong>
          </span>
        )}
        {progress.failedFiles > 0 && (
          <span className="wp-org-stat wp-org-stat-err">
            失败 <strong>{progress.failedFiles}</strong>
          </span>
        )}
        {progress.skippedFiles > 0 && (
          <span className="wp-org-stat wp-org-stat-skip">
            跳过 <strong>{progress.skippedFiles}</strong>
          </span>
        )}
      </div>

      {/* ── 当前文件 ── */}
      {progress.currentFile && !isFinished && (
        <div className="wp-org-current">
          <span className="wp-org-current-icon">●</span>
          <span className="wp-org-current-file" title={progress.currentFile}>
            {progress.currentFile.split('/').pop() || progress.currentFile}
          </span>
          <span className="wp-org-current-arrow">→</span>
          <span className="wp-org-current-target" title={progress.currentTarget || ''}>
            {(progress.currentTarget || '').split('/').slice(0, -1).join('/') || '.'}
          </span>
        </div>
      )}

      {/* ── 暂停/继续/跳过 控制按钮 ── */}
      {!isFinished && (
        <div className="wp-org-controls">
          {progress.isPaused ? (
            <button className="wp-org-btn wp-org-btn-resume" onClick={() => window.electronAPI.organizerResume()} title="继续整理">
              ▶ 继续
            </button>
          ) : (
            <button className="wp-org-btn wp-org-btn-pause" onClick={() => window.electronAPI.organizerPause()} title="暂停整理">
              ⏸ 暂停
            </button>
          )}
          {progress.currentFile && (
            <button className="wp-org-btn wp-org-btn-skip" onClick={() => window.electronAPI.organizerSkip()} title="跳过当前文件">
              ⏭ 跳过
            </button>
          )}
        </div>
      )}

      {/* ── 最近移动记录 ── */}
      {progress.recentMoves.length > 0 && (
        <div className="wp-org-moves">
          {progress.recentMoves
            .slice()
            .reverse()
            .slice(0, 5)
            .map((move, i) => (
              <FileMoveRow key={`${move.filePath}-${move.timestamp}`} move={move} index={i} />
            ))}
        </div>
      )}

      {/* ── 完成摘要 ── */}
      {isFinished && progress.summary && <div className="wp-org-summary">{progress.summary}</div>}
    </div>
  )
}

// =============================================================================
// Widget 定义
// =============================================================================

export const fileOrganizerProgressWidget: IWallpaperWidgetDefinition = {
  id: 'file-organizer-progress',
  name: '文件整理进度',
  priority: 30,
  zone: 'overlay',
  shouldShow: (ctx) => {
    if (ctx.hideDecoration) return false
    return true // 始终监听，内部通过 null 状态控制显示
  },
  Component: FileOrganizerProgressPanel,
}
