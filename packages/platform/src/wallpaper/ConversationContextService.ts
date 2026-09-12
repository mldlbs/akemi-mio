/**
 * ConversationContextService — 对话语境信息浮层服务
 *
 * 从 Memory 系统采集当前对话的关键信息（摘要、待办、进度），
 * 通过 IPC push 到渲染进程在桌面 Overlay 上展示。
 *
 * 数据流:
 *   MemoryService + SummaryMemory → ConversationContextService
 *     → (事件驱动或定时) → webContents.send('wallpaper:conversationContext')
 *     → ConversationContextWidget (React)
 *
 * 功能:
 *   - 对话摘要：从 SummaryMemory 获取最近对话摘要
 *   - 待办任务：从 MemoryService 获取未完成任务列表
 *   - 进度跟踪：计算任务完成比例
 *   - 响应式：订阅 Memory 事件，变更后立即推送
 *   - 兜底轮询：每 30 分钟刷新一次
 *   - 低开销：缓存上次结果，仅数据变化时推送
 */

import { BrowserWindow } from 'electron'
import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus, SubscriptionTracker } from '@akemi-mio/core/core/EventBus'
import { getMemoryService } from '@akemi-mio/capabilities/tool/deps'
import { credentialsManager } from '@akemi-mio/core/credentials/CredentialsManager'

// =============================================================================
// 类型定义
// =============================================================================

/** 任务条目（渲染进程用轻量结构） */
export interface ConversationTaskItem {
  /** 任务 ID */
  taskId: string
  /** 任务标题 */
  title: string
  /** 任务状态 */
  status: 'active' | 'paused' | 'completed' | 'abandoned'
  /** 已完成步骤数 */
  completedSteps: number
  /** 总步骤数 */
  totalSteps: number
  /** 进度百分比 0-100 */
  progressPercent: number
  /** 更新时间 */
  updatedAt: number
}

/** 推送到渲染进程的对话语境数据 */
export interface ConversationContextPayload {
  /** 当前对话摘要 */
  summary: string
  /** 摘要置信度 */
  summaryConfidence: number
  /** 活跃任务列表 */
  activeTasks: ConversationTaskItem[]
  /** 已完成任务数 */
  completedTasks: number
  /** 总任务数 */
  totalTasks: number
  /** 进度百分比 0-100 */
  progressPercent: number
  /** 更新时间戳 */
  updatedAt: number
  /** 是否包含有效数据 */
  hasData: boolean
  /** 错误信息（如果有） */
  error?: string
}

/** 显示配置 */
export interface ConversationContextConfig {
  /** 是否启用浮窗 */
  enabled: boolean
  /** 显示位置 */
  position: 'left' | 'right'
  /** 最大任务显示数 */
  maxTasks: number
  /** 是否显示摘要 */
  showSummary: boolean
  /** 是否显示任务列表 */
  showTasks: boolean
  /** 是否显示进度条 */
  showProgress: boolean
}

// =============================================================================
// 默认配置
// =============================================================================

const DEFAULT_CONFIG: ConversationContextConfig = {
  enabled: true,
  position: 'right',
  maxTasks: 5,
  showSummary: true,
  showTasks: true,
  showProgress: true,
}

const CRED_PREFIX = 'wp_convctx_'

// =============================================================================
// ConversationContextService
// =============================================================================

export class ConversationContextService {
  private mainWindow: BrowserWindow | null = null
  private pushTimer: ReturnType<typeof setInterval> | null = null
  private config: ConversationContextConfig = { ...DEFAULT_CONFIG }
  private lastPayload: ConversationContextPayload | null = null
  private subs: SubscriptionTracker = new SubscriptionTracker()

  /** 加载持久化配置 */
  loadConfig(): ConversationContextConfig {
    try {
      this.config = {
        enabled: credentialsManager.get(CRED_PREFIX + 'enabled') !== 'false',
        position: (credentialsManager.get(CRED_PREFIX + 'position') as 'left' | 'right') || 'right',
        maxTasks: parseInt(credentialsManager.get(CRED_PREFIX + 'max_tasks') || '', 10) || DEFAULT_CONFIG.maxTasks,
        showSummary: credentialsManager.get(CRED_PREFIX + 'show_summary') !== 'false',
        showTasks: credentialsManager.get(CRED_PREFIX + 'show_tasks') !== 'false',
        showProgress: credentialsManager.get(CRED_PREFIX + 'show_progress') !== 'false',
      }
    } catch {
      this.config = { ...DEFAULT_CONFIG }
    }
    return { ...this.config }
  }

  /** 保存配置 */
  saveConfig(patch: Partial<ConversationContextConfig>): ConversationContextConfig {
    try {
      if (patch.enabled !== undefined) {
        credentialsManager.set(CRED_PREFIX + 'enabled', patch.enabled ? 'true' : 'false')
        this.config.enabled = patch.enabled
      }
      if (patch.position !== undefined) {
        credentialsManager.set(CRED_PREFIX + 'position', patch.position)
        this.config.position = patch.position
      }
      if (patch.maxTasks !== undefined) {
        credentialsManager.set(CRED_PREFIX + 'max_tasks', String(patch.maxTasks))
        this.config.maxTasks = patch.maxTasks
      }
      if (patch.showSummary !== undefined) {
        credentialsManager.set(CRED_PREFIX + 'show_summary', patch.showSummary ? 'true' : 'false')
        this.config.showSummary = patch.showSummary
      }
      if (patch.showTasks !== undefined) {
        credentialsManager.set(CRED_PREFIX + 'show_tasks', patch.showTasks ? 'true' : 'false')
        this.config.showTasks = patch.showTasks
      }
      if (patch.showProgress !== undefined) {
        credentialsManager.set(CRED_PREFIX + 'show_progress', patch.showProgress ? 'true' : 'false')
        this.config.showProgress = patch.showProgress
      }
      log('INFO', 'conversation_context_config_saved', { config: this.config })
    } catch (err: any) {
      log('WARN', 'conversation_context_config_save_failed', { error: String(err) })
    }
    return { ...this.config }
  }

  /** 获取当前配置 */
  getConfig(): ConversationContextConfig {
    return { ...this.config }
  }

  /** 设置目标渲染窗口 */
  setWindow(win: BrowserWindow | null): void {
    this.mainWindow = win
    // 窗口就绪后立即推送一次
    if (win && !win.isDestroyed() && this.config.enabled) {
      this.pushContext()
    }
  }

  /** 启动服务 */
  start(): void {
    if (this.pushTimer) return
    this.loadConfig()
    if (!this.config.enabled) return

    // 订阅 Memory 事件
    this.subscribeToMemoryEvents()

    // 首次立即推送
    this.pushContext()

    // 兜底轮询（30 分钟）
    this.pushTimer = setInterval(
      () => {
        this.pushContext()
      },
      30 * 60 * 1000,
    )

    log('INFO', 'conversation_context_service_started', {
      position: this.config.position,
      showSummary: this.config.showSummary,
      showTasks: this.config.showTasks,
    })
  }

  /** 停止服务 */
  stop(): void {
    this.subs.dispose()
    if (this.pushTimer) {
      clearInterval(this.pushTimer)
      this.pushTimer = null
    }
  }

  /** 立即手动刷新一次 */
  refresh(): void {
    this.pushContext()
  }

  /** 销毁服务 */
  destroy(): void {
    this.stop()
    this.subs.dispose()
    this.mainWindow = null
    this.lastPayload = null
  }

  // ==================== 事件订阅 ====================

  /** 订阅 Memory 状态变更事件 */
  private subscribeToMemoryEvents(): void {
    const push = () => this.pushContext()

    eventBus.track('memory.entry.created', push, this.subs, 'conversation_context_service')
    eventBus.track('memory.entry.updated', push, this.subs, 'conversation_context_service')
    eventBus.track('memory.entry.deleted', push, this.subs, 'conversation_context_service')
    eventBus.track('memory.context.changed', push, this.subs, 'conversation_context_service')

    log('INFO', 'conversation_context_subscribed_events')
  }

  // ==================== 数据采集与推送 ====================

  /**
   * 从 Memory 系统采集对话上下文并推送到渲染进程。
   * 使用缓存策略：仅当数据有变化时才推送。
   */
  private pushContext(): void {
    const win = this.mainWindow
    if (!win || win.isDestroyed()) return

    const payload = this.collectContext()
    if (!payload) return

    // 缓存比较：仅当数据有变化时推送
    if (this.lastPayload && this.isPayloadEqual(this.lastPayload, payload)) {
      return
    }

    this.lastPayload = payload

    try {
      win.webContents.send('wallpaper:conversationContext', payload)
    } catch (err: any) {
      log('WARN', 'conversation_context_push_failed', { error: String(err) })
    }
  }

  /**
   * 从 MemoryService 采集对话上下文。
   * 包含：对话摘要、待办任务、进度统计。
   */
  private collectContext(): ConversationContextPayload | null {
    try {
      const mem = getMemoryService()
      if (!mem) {
        log('DEBUG', 'conversation_context_skip_no_service')
        return null
      }

      // 1. 采集对话摘要（从 SummaryMemory 取最近一条）
      //    通过 MemoryService 的 unifiedQuery 间接获取
      let summary = ''
      let summaryConfidence = 0
      try {
        const summaries = (mem as any).summary?.getRecent(1)
        if (summaries && summaries.length > 0 && typeof summaries[0] === 'string') {
          summary = summaries[0].length > 150 ? summaries[0].slice(0, 147) + '...' : summaries[0]
          summaryConfidence = 0.8
        }
      } catch {
        // SummaryMemory 可能未初始化
      }

      // 2. 采集待办任务
      const tasks = mem.getUnfinishedTasks()
      const allTaskEntries = mem.getEntries().filter((e) => e.type === 'task_state' && e.structuredData)

      // 统计总任务数（含已完成的）
      let completedTasks = 0
      for (const e of allTaskEntries) {
        try {
          const data = JSON.parse(e.structuredData!)
          if (data.status === 'completed') completedTasks++
        } catch {
          // 跳过解析失败
        }
      }
      const totalTasks = allTaskEntries.length
      const progressPercent = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0

      // 转换为轻量任务条目
      const activeTasks: ConversationTaskItem[] = tasks.slice(0, this.config.maxTasks).map((t) => ({
        taskId: t.taskId,
        title: t.title.length > 60 ? t.title.slice(0, 57) + '...' : t.title,
        status: t.status,
        completedSteps: t.steps.filter((s) => s.status === 'completed').length,
        totalSteps: t.steps.length,
        progressPercent:
          t.steps.length > 0 ? Math.round((t.steps.filter((s) => s.status === 'completed').length / t.steps.length) * 100) : 0,
        updatedAt: t.updatedAt,
      }))

      const hasData = summary.length > 0 || activeTasks.length > 0

      return {
        summary,
        summaryConfidence,
        activeTasks,
        completedTasks,
        totalTasks,
        progressPercent,
        updatedAt: Date.now(),
        hasData,
      }
    } catch (err: any) {
      log('WARN', 'conversation_context_collect_failed', { error: String(err) })
      return {
        summary: '',
        summaryConfidence: 0,
        activeTasks: [],
        completedTasks: 0,
        totalTasks: 0,
        progressPercent: 0,
        updatedAt: Date.now(),
        hasData: false,
        error: String(err),
      }
    }
  }

  /**
   * 比较两次推送数据是否相同（避免无效 IPC 传输）。
   */
  private isPayloadEqual(a: ConversationContextPayload, b: ConversationContextPayload): boolean {
    if (a.summary !== b.summary) return false
    if (a.progressPercent !== b.progressPercent) return false
    if (a.activeTasks.length !== b.activeTasks.length) return false
    for (let i = 0; i < a.activeTasks.length; i++) {
      if (a.activeTasks[i].taskId !== b.activeTasks[i].taskId) return false
      if (a.activeTasks[i].status !== b.activeTasks[i].status) return false
    }
    return true
  }
}
