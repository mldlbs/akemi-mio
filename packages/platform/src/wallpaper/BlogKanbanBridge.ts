/**
 * BlogKanbanBridge — 博客写作看板数据桥接器
 *
 * 将 BlogAgentService 的活跃会话状态映射为 Wallpaper BlogKanbanCanvas 需要的格式，
 * 通过 IPC 推送到渲染进程。
 *
 * 数据流:
 *   BlogAgentService (main)
 *     → BlogKanbanBridge.formatKanbanData()
 *       → webContents.send('wallpaper:blog-kanban:update', data)
 *         → BlogKanbanCanvas (renderer) 绘制
 *
 * 设计遵循现有的 EventCardBridge 模式:
 *   - 单例模式
 *   - 通过 IPC send/push 推送数据到渲染进程
 *   - 渲染进程通过 preload 暴露的订阅方法接收
 */

import { BrowserWindow } from 'electron'
import { log } from '@akemi-mio/core/logger/Logger'
import { blogAgentService } from '@akemi-mio/intelligence/agent/blog/BlogAgentService'
import { BLOG_STAGE_ORDER, BLOG_STAGE_LABELS } from '@akemi-mio/intelligence/agent/blog/types'

// ════════════════════════════════════════════════════════════
// 类型定义 — 推送数据的结构
// ════════════════════════════════════════════════════════════

/** 单个博客写作会话的看板数据 */
export interface BlogKanbanSessionData {
  /** 会话 ID */
  sessionId: string
  /** 话题/标题 */
  topic: string
  /** 目标发布平台 */
  targetPlatform: string
  /** 当前阶段 ID */
  currentStageId: string
  /** 当前阶段中文标签 */
  currentStageLabel: string
  /** 所有阶段的进度 (0-100) */
  stageProgress: number
  /** 当前阶段在全流程中的索引 (0-based) */
  currentStageIndex: number
  /** 总阶段数 (7) */
  totalStages: number
  /** 已完成阶段数 */
  completedStages: number
  /** 已被跳过的阶段数 */
  skippedStages: number
  /** 整体完成百分比 0-100 */
  percentComplete: number
  /** 会话是否已完成 */
  completed: boolean
  /** 各阶段状态映射 */
  stageStatuses: Array<{
    stageId: string
    label: string
    status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed'
    index: number
  }>
  /** 创建时间戳 */
  createdAt: number
  /** 最后活动时间 */
  lastActivityAt: number
  /** 合并的进度文本 */
  progressText: string
}

/** 看板数据推送负载 */
export interface BlogKanbanPayload {
  /** 活跃会话列表 */
  sessions: BlogKanbanSessionData[]
  /** 总活跃会话数 */
  totalActiveSessions: number
  /** 是否有任何活跃会话 */
  hasActiveSessions: boolean
  /** 数据生成时间戳 */
  timestamp: number
}

// ════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════

/** 推送间隔（毫秒）— 2s 满足实时性需求 */
const PUSH_INTERVAL_MS = 2000

// ════════════════════════════════════════════════════════════
// BlogKanbanBridge
// ════════════════════════════════════════════════════════════

export class BlogKanbanBridge {
  private _started = false
  private intervalTimer: ReturnType<typeof setInterval> | null = null
  private cachedPayload: BlogKanbanPayload | null = null
  private lastDataJson = ''

  /** 是否已启动 */
  get started(): boolean {
    return this._started
  }

  /** 获取缓存的看板数据 */
  getCachedPayload(): BlogKanbanPayload | null {
    return this.cachedPayload
  }

  // ══════════════════════════════════════════════════════════
  // 生命周期
  // ══════════════════════════════════════════════════════════

  /**
   * 启动桥接器，开始定期拉取并推送博客看板数据。
   */
  start(): void {
    if (this._started) return
    this._started = true

    // 立即推送一次
    this.pushNow()

    // 定期推送
    this.intervalTimer = setInterval(() => {
      this.pushNow()
    }, PUSH_INTERVAL_MS)

    log('INFO', 'blog_kanban_bridge_started')
  }

  /**
   * 停止桥接器。
   */
  stop(): void {
    this._started = false
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer)
      this.intervalTimer = null
    }
    this.cachedPayload = null
    this.lastDataJson = ''
    log('INFO', 'blog_kanban_bridge_stopped')
  }

  // ══════════════════════════════════════════════════════════
  // 数据处理
  // ══════════════════════════════════════════════════════════

  /**
   * 从 BlogAgentService 获取当前会话数据，格式化为看板数据。
   */
  private buildPayload(): BlogKanbanPayload {
    const sessions = blogAgentService.listActiveSessions()

    const sessionsData: BlogKanbanSessionData[] = sessions.map((s) => {
      const currentIdx = BLOG_STAGE_ORDER.indexOf(s.currentStage)
      const completedCount = BLOG_STAGE_ORDER.filter((st) => s.stageStatuses[st] === 'completed').length
      const skippedCount = s.skippedStages.length
      const totalCount = BLOG_STAGE_ORDER.length - skippedCount
      const pct = Math.round((completedCount / Math.max(1, totalCount)) * 100)

      const stageList = BLOG_STAGE_ORDER.map((st, idx) => ({
        stageId: st,
        label: BLOG_STAGE_LABELS[st],
        status: s.stageStatuses[st],
        index: idx,
      }))

      return {
        sessionId: s.sessionId,
        topic: s.topic,
        targetPlatform: s.targetPlatform,
        currentStageId: s.currentStage,
        currentStageLabel: BLOG_STAGE_LABELS[s.currentStage],
        stageProgress: completedCount > 0 ? Math.round((currentIdx / (BLOG_STAGE_ORDER.length - 1)) * 100) : 0,
        currentStageIndex: currentIdx,
        totalStages: BLOG_STAGE_ORDER.length,
        completedStages: completedCount,
        skippedStages: skippedCount,
        percentComplete: pct,
        completed: s.completed,
        stageStatuses: stageList,
        createdAt: s.createdAt,
        lastActivityAt: s.lastActivityAt,
        progressText: `${completedCount}/${totalCount} · ${pct}%`,
      }
    })

    return {
      sessions: sessionsData,
      totalActiveSessions: sessionsData.length,
      hasActiveSessions: sessionsData.length > 0,
      timestamp: Date.now(),
    }
  }

  /**
   * 构建数据并通过 IPC 推送到渲染进程。
   * 若数据无变化则跳过推送（JSON 指纹去重）。
   */
  pushNow(force = false): void {
    try {
      const payload = this.buildPayload()
      this.cachedPayload = payload

      const json = JSON.stringify(payload)
      if (!force && json === this.lastDataJson) return
      this.lastDataJson = json

      this.broadcast(payload)
    } catch (err) {
      log('WARN', 'blog_kanban_bridge_push_failed', { error: String(err) })
    }
  }

  /**
   * 手动刷新推送（供外部调用，如 IPC 请求）。
   */
  refresh(): void {
    this.pushNow(true)
  }

  // ══════════════════════════════════════════════════════════
  // IPC 广播
  // ══════════════════════════════════════════════════════════

  /**
   * 广播看板数据到所有窗口。
   */
  private broadcast(payload: BlogKanbanPayload): void {
    const wins = BrowserWindow.getAllWindows()
    for (const win of wins) {
      if (win && !win.isDestroyed()) {
        win.webContents.send('wallpaper:blog-kanban:update', payload)
      }
    }
  }
}

// ════════════════════════════════════════════════════════════
// 全局单例
// ════════════════════════════════════════════════════════════

export const blogKanbanBridge = new BlogKanbanBridge()
