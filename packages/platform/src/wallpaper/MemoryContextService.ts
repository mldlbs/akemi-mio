/**
 * MemoryContextService — 桌面记忆浮窗服务
 *
 * 通过 EventBus 订阅 Memory 状态变更事件，实时推送到渲染进程展示记忆卡片。
 * 同时保留定时轮询作为兜底（默认 30 分钟）。
 *
 * 数据流:
 *   MemoryService 操作 → EventBus memory.* 事件 → MemoryContextService → webContents.send('wallpaper:memoryContext') → React Widget
 *
 * 功能:
 *   - 响应式：Memory 状态变更后立即推送更新
 *   - 兜底轮询：每 30 分钟刷新一次
 *   - 支持显示类型配置（通过 credentials 持久化）
 *   - 鼠标穿透开关（通过 EvolutionDashboardService 协同）
 *   - 低开销设计：缓存上次结果，仅当数据变化时推送
 */

import { BrowserWindow } from 'electron'
import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus, SubscriptionTracker } from '@akemi-mio/core/core/EventBus'
import { getMemoryService } from '@akemi-mio/capabilities/tool/deps'
import { credentialsManager } from '@akemi-mio/core/credentials/CredentialsManager'
import type { MemoryService } from '@akemi-mio/intelligence-memory/MemoryService'

// =============================================================================
// 类型定义
// =============================================================================

/** 记忆卡片条目（给渲染进程用的轻量结构） */
export interface MemoryCardItem {
  /** 记忆 ID */
  id: string
  /** 记忆内容（截断至 120 字符） */
  content: string
  /** 记忆类型 */
  type: string
  /** 置信度 (0-1) */
  confidence: number
  /** 记忆层级 */
  tier: string
  /** 关联主题标签 */
  topics: string[]
  /** 行为得分 (0-1) */
  behaviorScore: number
  /** 是否被固定 */
  isPinned: boolean
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
}

/** 推送到渲染进程的记忆上下文数据 */
export interface MemoryContextPayload {
  /** 记忆卡片列表 */
  cards: MemoryCardItem[]
  /** 更新时间戳 */
  updatedAt: number
  /** 是否包含有效数据 */
  hasData: boolean
  /** 当前显示的显示类型 */
  displayType: MemoryContextDisplayType
  /** 错误信息（如果有） */
  error?: string
}

/** 显示类型配置 */
export type MemoryContextDisplayType =
  | 'all' // 全部高关联记忆
  | 'learning' // 学习计划相关
  | 'interests' // 兴趣标签
  | 'tasks' // 任务状态
  | 'facts' // 用户事实

/** 记忆上下文显示配置 */
export interface MemoryContextConfig {
  /** 是否启用浮窗 */
  enabled: boolean
  /** 显示类型 */
  displayType: MemoryContextDisplayType
  /** 轮询间隔（毫秒，默认 10 分钟） */
  pollIntervalMs: number
  /** 最大卡片数 */
  maxCards: number
  /** 鼠标穿透（浮窗区域是否穿透点击） */
  mouseThrough: boolean
}

// =============================================================================
// 默认配置
// =============================================================================

const DEFAULT_CONFIG: MemoryContextConfig = {
  enabled: true,
  displayType: 'all',
  pollIntervalMs: 30 * 60 * 1000, // 30 分钟（有事件驱动，轮询仅作兜底）
  maxCards: 5,
  mouseThrough: true,
}

const CRED_PREFIX = 'wp_memctx_'

// =============================================================================
// MemoryContextService
// =============================================================================

export class MemoryContextService {
  private mainWindow: BrowserWindow | null = null
  private pushTimer: ReturnType<typeof setInterval> | null = null
  private config: MemoryContextConfig = { ...DEFAULT_CONFIG }
  private lastPayload: MemoryContextPayload | null = null
  private memoryService: MemoryService | null = null
  private subs: SubscriptionTracker = new SubscriptionTracker()

  /** 加载持久化配置 */
  loadConfig(): MemoryContextConfig {
    try {
      this.config = {
        enabled: credentialsManager.get(CRED_PREFIX + 'enabled') !== 'false',
        displayType: (credentialsManager.get(CRED_PREFIX + 'display_type') as MemoryContextDisplayType) || 'all',
        pollIntervalMs: parseInt(credentialsManager.get(CRED_PREFIX + 'poll_interval') || '', 10) || DEFAULT_CONFIG.pollIntervalMs,
        maxCards: parseInt(credentialsManager.get(CRED_PREFIX + 'max_cards') || '', 10) || DEFAULT_CONFIG.maxCards,
        mouseThrough: credentialsManager.get(CRED_PREFIX + 'mouse_through') !== 'false',
      }
    } catch {
      this.config = { ...DEFAULT_CONFIG }
    }
    return { ...this.config }
  }

  /** 保存配置 */
  saveConfig(patch: Partial<MemoryContextConfig>): MemoryContextConfig {
    try {
      if (patch.enabled !== undefined) {
        credentialsManager.set(CRED_PREFIX + 'enabled', patch.enabled ? 'true' : 'false')
        this.config.enabled = patch.enabled
      }
      if (patch.displayType !== undefined) {
        credentialsManager.set(CRED_PREFIX + 'display_type', patch.displayType)
        this.config.displayType = patch.displayType
      }
      if (patch.pollIntervalMs !== undefined) {
        credentialsManager.set(CRED_PREFIX + 'poll_interval', String(patch.pollIntervalMs))
        this.config.pollIntervalMs = patch.pollIntervalMs
      }
      if (patch.maxCards !== undefined) {
        credentialsManager.set(CRED_PREFIX + 'max_cards', String(patch.maxCards))
        this.config.maxCards = patch.maxCards
      }
      if (patch.mouseThrough !== undefined) {
        credentialsManager.set(CRED_PREFIX + 'mouse_through', patch.mouseThrough ? 'true' : 'false')
        this.config.mouseThrough = patch.mouseThrough
      }
      log('INFO', 'memory_context_config_saved', { config: this.config })
    } catch (err: any) {
      log('WARN', 'memory_context_config_save_failed', { error: String(err) })
    }
    return { ...this.config }
  }

  /** 获取当前配置 */
  getConfig(): MemoryContextConfig {
    return { ...this.config }
  }

  /** 设置目标渲染窗口 */
  setWindow(win: BrowserWindow | null): void {
    this.mainWindow = win
    // 窗口就绪后立即推送一次
    if (win && !win.isDestroyed() && this.config.enabled) {
      this.pushMemoryContext()
    }
  }

  /** 获取 MemoryService 引用（延迟绑定，避免循环依赖） */
  private getMemory(): MemoryService | null {
    if (!this.memoryService) {
      this.memoryService = getMemoryService()
    }
    return this.memoryService
  }

  /** 启动定时轮询（兜底）+ 订阅 Memory 事件 */
  start(): void {
    if (this.pushTimer) return
    this.loadConfig()
    if (!this.config.enabled) return

    // 订阅 Memory 状态变更事件 → 立即推送更新
    this.subscribeToMemoryEvents()

    // 首次立即推送
    this.pushMemoryContext()

    // 兜底轮询（事件驱动为主，轮询仅保底）
    this.pushTimer = setInterval(() => {
      this.pushMemoryContext()
    }, this.config.pollIntervalMs)

    log('INFO', 'memory_context_service_started', {
      intervalMs: this.config.pollIntervalMs,
      displayType: this.config.displayType,
      maxCards: this.config.maxCards,
    })
  }

  /** 订阅 Memory 状态变更事件 */
  private subscribeToMemoryEvents(): void {
    // 记忆条目创建 → 立即刷新
    eventBus.track(
      'memory.entry.created',
      () => {
        this.pushMemoryContext()
      },
      this.subs,
      'memory_context_service',
    )

    // 记忆条目更新 → 立即刷新
    eventBus.track(
      'memory.entry.updated',
      () => {
        this.pushMemoryContext()
      },
      this.subs,
      'memory_context_service',
    )

    // 记忆条目删除 → 立即刷新
    eventBus.track(
      'memory.entry.deleted',
      () => {
        this.pushMemoryContext()
      },
      this.subs,
      'memory_context_service',
    )

    // 记忆上下文批量变更（修剪/清理） → 立即刷新
    eventBus.track(
      'memory.context.changed',
      () => {
        this.pushMemoryContext()
      },
      this.subs,
      'memory_context_service',
    )

    log('INFO', 'memory_context_subscribed_events')
  }

  /** 停止定时轮询 + 取消事件订阅 */
  stop(): void {
    this.subs.dispose()
    if (this.pushTimer) {
      clearInterval(this.pushTimer)
      this.pushTimer = null
    }
  }

  /** 立即手动推送一次 */
  refresh(): void {
    this.pushMemoryContext()
  }

  /** 销毁服务 */
  destroy(): void {
    this.stop()
    this.subs.dispose()
    this.mainWindow = null
    this.memoryService = null
    this.lastPayload = null
  }

  // ==================== 数据采集与推送 ====================

  /**
   * 从 Memory 系统采集活跃上下文并推送到渲染进程。
   * 使用缓存策略：仅当数据有变化时才推送，降低 IPC 开销。
   */
  private pushMemoryContext(): void {
    const win = this.mainWindow
    if (!win || win.isDestroyed()) return

    const payload = this.collectActiveContext()
    if (!payload) return

    // 缓存比较：仅当数据有变化时推送
    if (this.lastPayload && this.isPayloadEqual(this.lastPayload, payload)) {
      return
    }

    this.lastPayload = payload

    try {
      win.webContents.send('wallpaper:memoryContext', payload)
    } catch (err: any) {
      log('WARN', 'memory_context_push_failed', { error: String(err) })
    }
  }

  /**
   * 从 MemoryService 采集活跃上下文。
   */
  private collectActiveContext(): MemoryContextPayload | null {
    try {
      const mem = this.getMemory()
      if (!mem) {
        log('DEBUG', 'memory_context_skip_no_service')
        return null
      }

      // 获取所有内存条目
      const allEntries = mem.getEntries()
      if (!allEntries || allEntries.length === 0) {
        // 无记忆时返回空列表（有效状态，非错误）
        return {
          cards: [],
          updatedAt: Date.now(),
          hasData: false,
          displayType: this.config.displayType,
        }
      }

      // 评分排序：综合行为得分、置信度、是否固定、最近访问时间
      const scored = allEntries
        .map((e) => {
          // 综合得分 = behaviorScore * 0.4 + confidence * 0.3 + pinned bonus + recency bonus
          const pinnedBonus = e.isPinned ? 0.2 : 0
          const recencyBonus = Math.max(0, 0.1 - ((Date.now() - e.lastAccessedAt) / (30 * 24 * 3600 * 1000)) * 0.1)
          const compositeScore = (e.behaviorScore ?? 0.5) * 0.4 + e.confidence * 0.3 + pinnedBonus + recencyBonus
          return { entry: e, score: compositeScore }
        })
        .sort((a, b) => b.score - a.score)

      // 根据显示类型过滤
      let filtered = scored
      if (this.config.displayType !== 'all') {
        filtered = scored.filter((s) => this.matchesDisplayType(s.entry, this.config.displayType))
      }

      // 取前 N 条
      const topCards = filtered.slice(0, this.config.maxCards)

      const cards: MemoryCardItem[] = topCards.map((s) => ({
        id: s.entry.id,
        content: s.entry.content.length > 120 ? s.entry.content.slice(0, 117) + '...' : s.entry.content,
        type: s.entry.type,
        confidence: s.entry.confidence,
        tier: s.entry.tier,
        topics: s.entry.topics || [],
        behaviorScore: s.entry.behaviorScore ?? 0.5,
        isPinned: s.entry.isPinned,
        createdAt: s.entry.createdAt,
        updatedAt: s.entry.updatedAt,
      }))

      return {
        cards,
        updatedAt: Date.now(),
        hasData: cards.length > 0,
        displayType: this.config.displayType,
      }
    } catch (err: any) {
      log('WARN', 'memory_context_collect_failed', { error: String(err) })
      return {
        cards: [],
        updatedAt: Date.now(),
        hasData: false,
        displayType: this.config.displayType,
        error: String(err),
      }
    }
  }

  /**
   * 判断记忆条目是否匹配当前显示类型。
   */
  private matchesDisplayType(entry: { type: string; topics?: string[]; content: string }, displayType: MemoryContextDisplayType): boolean {
    switch (displayType) {
      case 'all':
        return true
      case 'learning':
        // 学习计划相关的记忆：topic 含 learning/study/tutorial 或 type 为 task_state
        return (
          entry.type === 'task_state' ||
          (entry.topics || []).some((t) => /learning|study|tutorial|course|lesson|learn/i.test(t)) ||
          /学习|课程|教程|练习/i.test(entry.content)
        )
      case 'interests':
        // 兴趣标签：topic 含兴趣相关关键词或 type 为 user_fact
        return entry.type === 'user_fact' || (entry.topics || []).length > 0
      case 'tasks':
        // 任务状态
        return entry.type === 'task_state'
      case 'facts':
        // 用户事实
        return entry.type === 'user_fact'
      default:
        return true
    }
  }

  /**
   * 比较两次推送数据是否相同（避免无效 IPC 传输）。
   */
  private isPayloadEqual(a: MemoryContextPayload, b: MemoryContextPayload): boolean {
    if (a.cards.length !== b.cards.length) return false
    if (a.displayType !== b.displayType) return false
    for (let i = 0; i < a.cards.length; i++) {
      if (a.cards[i].id !== b.cards[i].id) return false
      if (a.cards[i].content !== b.cards[i].content) return false
    }
    return true
  }
}
