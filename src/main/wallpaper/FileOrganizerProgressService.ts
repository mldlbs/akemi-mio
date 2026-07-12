/**
 * FileOrganizerProgressService — 文件整理可视化进度服务
 *
 * 监听 FileOrganizerExecutor 发出的 EventBus 事件，
 * 聚合整理进度并通过 IPC 推送到渲染进程的 Overlay 展示。
 *
 * 数据流:
 *   EventBus file_organizer.move.* → FileOrganizerProgressService
 *     → webContents.send('organizer:progress') → React Widget
 *
 * 功能:
 *   - 自动检测整理会话开始/结束（通过 pipeline 事件）
 *   - 跟踪每个文件的移动状态
 *   - 推送进度摘要和统计
 *   - 支持暂停/继续/跳过控制
 *   - 完成后自动标记结束"
 */

import { BrowserWindow } from 'electron'
import { log } from '../logger/Logger'
import { eventBus, SubscriptionTracker } from '../core/EventBus'

// =============================================================================
// 类型定义
// =============================================================================

/** 单个文件移动事件 */
export interface FileMoveEvent {
  /** 文件相对路径 */
  filePath: string
  /** 源路径 */
  sourcePath: string
  /** 目标路径 */
  targetPath: string
  /** 匹配规则 ID */
  ruleId: string
  /** 规则来源 */
  ruleSource: string
  /** 移动开始时间戳 */
  timestamp: number
}

/** 文件移动结果状态 */
export type FileMoveStatus = 'moving' | 'completed' | 'skipped' | 'failed'

/** 移动结果事件（与 start 事件不同，包含结果） */
export interface FileMoveResult {
  filePath: string
  sourcePath: string
  targetPath: string
  ruleId: string
  ruleSource: string
  status: FileMoveStatus
  durationMs?: number
  error?: string
  reason?: string
  timestamp: number
}

/** 整理会话进度状态 */
export type SessionStatus = 'idle' | 'organizing' | 'paused' | 'completed'

/** 推送到渲染进程的进度数据 */
export interface OrganizerProgressPayload {
  status: SessionStatus
  /** 待处理文件总数 */
  totalFiles: number
  /** 已成功移动的文件数 */
  completedFiles: number
  /** 失败的文件数 */
  failedFiles: number
  /** 跳过的文件数 */
  skippedFiles: number
  /** 正在移动的当前文件（null 表示无） */
  currentFile: string | null
  /** 当前文件的目标路径 */
  currentTarget: string | null
  /** 当前进度百分比 0-100 */
  percentComplete: number
  /** 文件移动事件列表（最近一批） */
  recentMoves: FileMoveResult[]
  /** 会话开始时间戳 */
  startTime: number | null
  /** 会话结束时间戳 */
  endTime: number | null
  /** 摘要文本（完成后显示） */
  summary: string
  /** 是否处于暂停状态 */
  isPaused: boolean
  /** 最后更新时间 */
  updatedAt: number
}

// =============================================================================
// 默认状态
// =============================================================================

const DEFAULT_PAYLOAD: OrganizerProgressPayload = {
  status: 'idle',
  totalFiles: 0,
  completedFiles: 0,
  failedFiles: 0,
  skippedFiles: 0,
  currentFile: null,
  currentTarget: null,
  percentComplete: 0,
  recentMoves: [],
  startTime: null,
  endTime: null,
  summary: '',
  isPaused: false,
  updatedAt: Date.now(),
}

// =============================================================================
// FileOrganizerProgressService
// =============================================================================

export class FileOrganizerProgressService {
  private state: OrganizerProgressPayload = { ...DEFAULT_PAYLOAD }
  private subs = new SubscriptionTracker()
  private mainWindow: BrowserWindow | null = null
  private pushTimer: ReturnType<typeof setTimeout> | null = null
  /** 推送防抖间隔 */
  private static readonly PUSH_DEBOUNCE_MS = 200
  /** 自动淡出延迟 (完成 5 秒后) */
  private static readonly AUTO_FADE_DELAY_MS = 5000
  /** 当前移动的 Map: filePath → FileMoveEvent */
  private activeMoves = new Map<string, FileMoveEvent>()
  /** 已完成/失败/跳过的结果列表（保留最近 50 条） */
  private completedMoves: FileMoveResult[] = []
  private static readonly MAX_RECENT_MOVES = 50
  /** 自动淡出定时器 */
  private fadeTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    this.registerEventListeners()
  }

  /** 设置目标渲染窗口 */
  setWindow(win: BrowserWindow | null): void {
    this.mainWindow = win
  }

  /** 获取当前状态快照 */
  getState(): OrganizerProgressPayload {
    return { ...this.state }
  }

  /** 重置状态 */
  reset(): void {
    this.state = { ...DEFAULT_PAYLOAD }
    this.activeMoves.clear()
    this.completedMoves = []
    if (this.fadeTimer) {
      clearTimeout(this.fadeTimer)
      this.fadeTimer = null
    }
    this.pushState()
  }

  /** 暂停当前整理 */
  pause(): void {
    if (this.state.status !== 'organizing') return
    this.state.status = 'paused'
    this.state.isPaused = true
    this.state.updatedAt = Date.now()
    this.pushState()
    log('INFO', 'organizer_progress_paused')
  }

  /** 继续当前整理 */
  resume(): void {
    if (this.state.status !== 'paused') return
    this.state.status = 'organizing'
    this.state.isPaused = false
    this.state.updatedAt = Date.now()
    this.pushState()
    log('INFO', 'organizer_progress_resumed')
  }

  /** 跳过当前文件（仅 UI 标记，实际跳过由 executor 反馈决定） */
  skipCurrent(): void {
    if (!this.state.currentFile) return
    const filePath = this.state.currentFile
    this.recordResult({
      filePath,
      sourcePath: this.state.currentFile,
      targetPath: this.state.currentTarget || '',
      ruleId: '',
      ruleSource: '',
      status: 'skipped',
      reason: 'user_skipped',
      timestamp: Date.now(),
    })
    this.state.currentFile = null
    this.state.currentTarget = null
    this.state.updatedAt = Date.now()
    this.pushState()
    log('INFO', 'organizer_progress_skipped', { filePath })
  }

  /** 销毁服务 */
  destroy(): void {
    this.subs.dispose()
    if (this.pushTimer) {
      clearTimeout(this.pushTimer)
      this.pushTimer = null
    }
    if (this.fadeTimer) {
      clearTimeout(this.fadeTimer)
      this.fadeTimer = null
    }
  }

  // ==================== 事件监听注册 ====================

  private registerEventListeners(): void {
    // 管道启动 — 检测文件整理会话开始
    eventBus.track(
      'pipeline.started' as any,
      () => {
        // 重置状态，准备新的整理会话
        this.reset()
        this.state.status = 'organizing'
        this.state.startTime = Date.now()
        this.state.updatedAt = Date.now()
        this.pushState()
      },
      this.subs,
      'fops:pipeline_start',
    )

    // 管道完成 — 整理会话结束
    eventBus.track(
      'pipeline.completed' as any,
      (p: any) => {
        const totalCollected = p.totalCollected ?? p.collected ?? 0
        this.state.totalFiles = totalCollected
        this.finalizeSession()
      },
      this.subs,
      'fops:pipeline_complete',
    )

    // 管道错误
    eventBus.track(
      'pipeline.errored' as any,
      () => {
        this.state.status = 'idle'
        this.state.updatedAt = Date.now()
        this.pushState()
      },
      this.subs,
      'fops:pipeline_error',
    )

    // ── 文件移动事件 ──

    eventBus.track(
      'file_organizer.move.start' as any,
      (evt: any) => {
        if (this.state.isPaused) return
        this.state.status = 'organizing'
        this.state.currentFile = evt.filePath
        this.state.currentTarget = evt.targetPath
        this.state.totalFiles++
        this.state.updatedAt = Date.now()

        // 记录活跃移动
        this.activeMoves.set(evt.filePath, {
          filePath: evt.filePath,
          sourcePath: evt.sourcePath,
          targetPath: evt.targetPath,
          ruleId: evt.ruleId,
          ruleSource: evt.ruleSource,
          timestamp: evt.timestamp,
        })

        this.schedulePush()
      },
      this.subs,
      'fops:move_start',
    )

    eventBus.track(
      'file_organizer.move.completed' as any,
      (evt: any) => {
        this.activeMoves.delete(evt.filePath)
        this.state.completedFiles++
        this.state.currentFile = null
        this.state.currentTarget = null
        this.updatePercentComplete()

        this.recordResult({
          filePath: evt.filePath,
          sourcePath: evt.sourcePath,
          targetPath: evt.targetPath,
          ruleId: evt.ruleId,
          ruleSource: evt.ruleSource,
          status: 'completed',
          timestamp: evt.timestamp,
        })
      },
      this.subs,
      'fops:move_complete',
    )

    eventBus.track(
      'file_organizer.move.failed' as any,
      (evt: any) => {
        this.activeMoves.delete(evt.filePath)
        this.state.failedFiles++
        this.state.currentFile = null
        this.state.currentTarget = null
        this.updatePercentComplete()

        this.recordResult({
          filePath: evt.filePath,
          sourcePath: evt.sourcePath,
          targetPath: evt.targetPath,
          ruleId: evt.ruleId,
          ruleSource: evt.ruleSource,
          status: 'failed',
          error: evt.error,
          timestamp: evt.timestamp,
        })
      },
      this.subs,
      'fops:move_failed',
    )

    eventBus.track(
      'file_organizer.move.skipped' as any,
      (evt: any) => {
        this.state.skippedFiles++
        this.updatePercentComplete()

        this.recordResult({
          filePath: evt.filePath,
          sourcePath: evt.sourcePath,
          targetPath: evt.targetPath,
          ruleId: evt.ruleId,
          ruleSource: evt.ruleSource,
          status: 'skipped',
          reason: evt.reason,
          timestamp: evt.timestamp,
        })
      },
      this.subs,
      'fops:move_skipped',
    )
  }

  // ==================== 内部方法 ====================

  /** 记录移动结果并更新最近列表 */
  private recordResult(result: FileMoveResult): void {
    this.completedMoves.push(result)
    if (this.completedMoves.length > FileOrganizerProgressService.MAX_RECENT_MOVES) {
      this.completedMoves.shift()
    }
    this.state.recentMoves = [...this.completedMoves.slice(-10)]
    this.state.updatedAt = Date.now()
    this.schedulePush()
  }

  /** 更新进度百分比 */
  private updatePercentComplete(): void {
    const total = this.state.totalFiles
    if (total === 0) {
      this.state.percentComplete = 0
      return
    }
    const done = this.state.completedFiles + this.state.skippedFiles + this.state.failedFiles
    this.state.percentComplete = Math.min(100, Math.round((done / total) * 100))
  }

  /** 结束当前整理会话，生成摘要 */
  private finalizeSession(): void {
    this.state.status = 'completed'
    this.state.currentFile = null
    this.state.currentTarget = null
    this.state.endTime = Date.now()
    this.state.updatedAt = Date.now()

    const { completedFiles, failedFiles, skippedFiles, totalFiles } = this.state
    const parts: string[] = []
    if (completedFiles > 0) parts.push(`已完成 ${completedFiles} 个文件`)
    if (failedFiles > 0) parts.push(`失败 ${failedFiles} 个`)
    if (skippedFiles > 0) parts.push(`跳过 ${skippedFiles} 个`)
    this.state.summary = parts.length > 0
      ? `文件整理完成：${parts.join('，')}`
      : totalFiles > 0
        ? '文件整理完成，无需移动'
        : '未检测到需要整理的文件'

    this.pushState()

    // 自动淡出 — 5 秒后标记为 idle
    if (this.fadeTimer) clearTimeout(this.fadeTimer)
    this.fadeTimer = setTimeout(() => {
      this.state.status = 'idle'
      this.state.summary = ''
      this.state.recentMoves = []
      this.state.updatedAt = Date.now()
      this.pushState()
    }, FileOrganizerProgressService.AUTO_FADE_DELAY_MS)
  }

  /** 防抖推送 */
  private schedulePush(): void {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer)
    }
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      this.pushState()
    }, FileOrganizerProgressService.PUSH_DEBOUNCE_MS)
  }

  /** 立即推送当前状态到渲染进程 */
  private pushState(): void {
    const win = this.mainWindow
    if (!win || win.isDestroyed()) return

    try {
      win.webContents.send('organizer:progress', this.getState())
    } catch (err: any) {
      log('WARN', 'organizer_progress_push_failed', { error: String(err) })
    }
  }
}
