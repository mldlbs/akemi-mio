/**
 * EventCardBridge — MCP 工具执行事件 → Wallpaper 事件卡片桥接器
 *
 * 将 EventBus 中的工具执行/进化/洞察等事件转换为结构化事件卡片，
 * 推送到渲染进程供 Wallpaper EventCardWidget 显示。
 *
 * 数据流:
 *   EventBus(agent.tool.* / evolution.* / insight.* / creativity.*)
 *     → EventCardBridge.transform()
 *       → webContents.send('wallpaper:event-cards', cards)
 *         → EventCardWidget.render() [renderer]
 *
 * 卡片优先级（低值优先，重要告警靠前）:
 *   1 = error/alert（工具失败、系统错误）
 *   2 = normal（工具完成、进化循环、洞察发现）
 *   3 = low（工具调用、创造想法、工作流步骤）
 *
 * 用户可通过配置选择订阅的事件源（eventSources），
 * 避免信息过载。
 */

import { BrowserWindow } from 'electron'
import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus, SubscriptionTracker } from '@akemi-mio/core/core/EventBus'
import { credentialsManager } from '@akemi-mio/core/credentials/CredentialsManager'

// ════════════════════════════════════════════════════════════
// 类型定义
// ════════════════════════════════════════════════════════════

/** 事件卡片类型 */
export type EventCardType =
  'tool_success' | 'tool_error' | 'tool_invoked' | 'evolution' | 'insight' | 'creativity' | 'workflow' | 'system' | 'agent_error'

/** 事件卡片优先级 */
export type CardPriority = 1 | 2 | 3

/** 事件卡片数据结构 */
export interface EventCard {
  /** 唯一标识 */
  id: string
  /** 事件卡片类型 */
  type: EventCardType
  /** 优先级（1=最高，3=最低） */
  priority: CardPriority
  /** 卡片标题 */
  title: string
  /** 摘要文本 */
  summary: string
  /** 图标（emoji 或 icon class） */
  icon: string
  /** 事件时间戳 */
  timestamp: number
  /** 来源工具名（对于工具事件） */
  toolName?: string
  /** 是否可以点击交互 */
  actionable: boolean
  /** 点击动作标签 */
  actionLabel?: string
  /** 点击动作负载 */
  actionPayload?: Record<string, any>
}

/** 事件源配置：用户可选择订阅哪些类型的事件 */
export const DEFAULT_EVENT_SOURCES: EventCardType[] = ['tool_success', 'tool_error', 'evolution', 'insight', 'agent_error']

export const ALL_EVENT_SOURCES: EventCardType[] = [
  'tool_success',
  'tool_error',
  'tool_invoked',
  'evolution',
  'insight',
  'creativity',
  'workflow',
  'system',
  'agent_error',
]

/** 事件源显示名称映射 */
export const EVENT_SOURCE_LABELS: Record<EventCardType, string> = {
  tool_success: '工具执行成功',
  tool_error: '工具执行失败',
  tool_invoked: '工具调用（低优先级）',
  evolution: '进化循环',
  insight: '洞察发现',
  creativity: '创意生成',
  workflow: '工作流',
  system: '系统状态',
  agent_error: 'Agent 错误',
}

/** 事件源图标映射 */
export const EVENT_SOURCE_ICONS: Record<EventCardType, string> = {
  tool_success: '✅',
  tool_error: '❌',
  tool_invoked: '🛠️',
  evolution: '🧬',
  insight: '💡',
  creativity: '✨',
  workflow: '⚙️',
  system: '🖥️',
  agent_error: '🚨',
}

// ════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════

/** 缓存最大卡片数 */
const MAX_CACHED_CARDS = 50

/** 推送到渲染进程的最大卡片数 */
const MAX_PUSH_CARDS = 10

/** 卡片存活时间（毫秒），超过此时间的卡片自动移除 */
const CARD_TTL_MS = 120_000 // 2 分钟

/** Credential 键名 */
const CRED_CONFIG_KEY = 'wp_event_card_sources'

// ════════════════════════════════════════════════════════════
// EventCardBridge
// ════════════════════════════════════════════════════════════

export class EventCardBridge {
  private subs = new SubscriptionTracker()
  private _started = false
  private cards: EventCard[] = []
  private idCounter = 0

  /** 用户配置的事件源白名单 */
  private enabledSources: Set<EventCardType> = new Set(DEFAULT_EVENT_SOURCES)

  /** 是否已启动 */
  get started(): boolean {
    return this._started
  }

  /** 获取当前缓存的卡片列表 */
  getCards(): EventCard[] {
    this.pruneExpired()
    return [...this.cards]
  }

  /** 获取启用的事件源 */
  getEnabledSources(): EventCardType[] {
    return Array.from(this.enabledSources)
  }

  /** 设置启用的事件源 */
  setEnabledSources(sources: EventCardType[]): void {
    this.enabledSources = new Set(sources)
    // 持久化配置
    credentialsManager.set(CRED_CONFIG_KEY, JSON.stringify(sources))
    log('INFO', 'event_card_bridge_sources_updated', { sources })
  }

  // ══════════════════════════════════════════════════════════
  // 生命周期
  // ══════════════════════════════════════════════════════════

  /**
   * 启动桥接器。
   * 加载持久化配置，订阅 EventBus 事件。
   */
  start(): void {
    if (this._started) return
    this._started = true

    // 加载持久化配置
    this.loadConfig()

    // 订阅所有相关事件
    this.subscribeToolEvents()
    this.subscribeEvolutionEvents()
    this.subscribeInsightEvents()
    this.subscribeCreativityEvents()
    this.subscribeWorkflowEvents()
    this.subscribeAgentEvents()

    log('INFO', 'event_card_bridge_started', {
      enabledSources: Array.from(this.enabledSources),
    })
  }

  /** 停止桥接器 */
  stop(): void {
    this.subs.dispose()
    this._started = false
    this.cards = []
    log('INFO', 'event_card_bridge_stopped')
  }

  // ══════════════════════════════════════════════════════════
  // 配置
  // ══════════════════════════════════════════════════════════

  private loadConfig(): void {
    try {
      const raw = credentialsManager.get(CRED_CONFIG_KEY)
      if (raw) {
        const parsed: EventCardType[] = JSON.parse(raw)
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.enabledSources = new Set(parsed)
        }
      }
    } catch {
      // 配置损坏，使用默认值
      this.enabledSources = new Set(DEFAULT_EVENT_SOURCES)
    }
  }

  // ══════════════════════════════════════════════════════════
  // 事件订阅
  // ══════════════════════════════════════════════════════════

  private subscribeToolEvents(): void {
    // ── 工具调用 ──
    eventBus.track(
      'agent.tool.invoked' as any,
      (payload: any) => {
        if (!this.enabledSources.has('tool_invoked')) return
        const toolName: string = payload.tool ?? 'unknown'
        this.addCard({
          type: 'tool_invoked',
          priority: 3,
          title: `调用工具: ${toolName}`,
          summary: `正在执行 ${toolName}…`,
          icon: EVENT_SOURCE_ICONS.tool_invoked,
          toolName,
          actionable: false,
        })
      },
      this.subs,
      'ecb:tool_invoked',
    )

    // ── 工具完成 ──
    eventBus.track(
      'agent.tool.completed' as any,
      (payload: any) => {
        if (!this.enabledSources.has('tool_success')) return
        const toolName: string = payload.tool ?? 'unknown'
        const result: string = payload.result ?? ''
        const summary = result.length > 80 ? result.slice(0, 77) + '...' : result
        this.addCard({
          type: 'tool_success',
          priority: 2,
          title: `工具完成: ${toolName}`,
          summary: summary || '执行成功',
          icon: EVENT_SOURCE_ICONS.tool_success,
          toolName,
          actionable: true,
          actionLabel: '查看详情',
          actionPayload: { tool: toolName, result },
        })
      },
      this.subs,
      'ecb:tool_completed',
    )

    // ── 工具失败 ──
    eventBus.track(
      'agent.tool.failed' as any,
      (payload: any) => {
        if (!this.enabledSources.has('tool_error')) return
        const toolName: string = payload.tool ?? 'unknown'
        const error: string = payload.error ?? '未知错误'
        this.addCard({
          type: 'tool_error',
          priority: 1,
          title: `工具失败: ${toolName}`,
          summary: error.length > 80 ? error.slice(0, 77) + '...' : error,
          icon: EVENT_SOURCE_ICONS.tool_error,
          toolName,
          actionable: true,
          actionLabel: '查看错误',
          actionPayload: { tool: toolName, error },
        })
      },
      this.subs,
      'ecb:tool_failed',
    )
  }

  private subscribeEvolutionEvents(): void {
    // ── 进化循环完成 ──
    eventBus.track(
      'evolution.cycle.completed' as any,
      (payload: any) => {
        if (!this.enabledSources.has('evolution')) return
        const success: boolean = payload.success ?? true
        const summary: string = payload.summary ?? ''
        const planTitle: string = payload.planTitle ?? ''
        this.addCard({
          type: 'evolution',
          priority: success ? 2 : 1,
          title: success ? '进化循环完成' : '进化循环失败',
          summary: planTitle
            ? `${planTitle}: ${summary.length > 60 ? summary.slice(0, 57) + '...' : summary}`
            : summary.length > 80
              ? summary.slice(0, 77) + '...'
              : summary,
          icon: success ? '🧬' : '⚠️',
          actionable: false,
        })
      },
      this.subs,
      'ecb:evolution',
    )
  }

  private subscribeInsightEvents(): void {
    eventBus.track(
      'insight.found' as any,
      (payload: any) => {
        if (!this.enabledSources.has('insight')) return
        const count: number = payload.count ?? 0
        if (count === 0) return
        this.addCard({
          type: 'insight',
          priority: 2,
          title: `发现 ${count} 个洞察`,
          summary: `检测到 ${count} 个新的洞察分析结果`,
          icon: EVENT_SOURCE_ICONS.insight,
          actionable: false,
        })
      },
      this.subs,
      'ecb:insight',
    )
  }

  private subscribeCreativityEvents(): void {
    eventBus.track(
      'creativity.ideas.generated' as any,
      (payload: any) => {
        if (!this.enabledSources.has('creativity')) return
        const count: number = payload.count ?? 0
        const ideas: any[] = payload.ideas ?? []
        if (count === 0) return
        const topIdea = ideas.length > 0 ? (ideas[0].title ?? '') : ''
        this.addCard({
          type: 'creativity',
          priority: 3,
          title: `生成 ${count} 个创意`,
          summary: topIdea ? `最佳: ${topIdea.length > 50 ? topIdea.slice(0, 47) + '...' : topIdea}` : `${count} 个新点子已就绪`,
          icon: EVENT_SOURCE_ICONS.creativity,
          actionable: false,
        })
      },
      this.subs,
      'ecb:creativity',
    )
  }

  private subscribeWorkflowEvents(): void {
    eventBus.track(
      'workflow.run.step' as any,
      (payload: any) => {
        if (!this.enabledSources.has('workflow')) return
        const stepId: string = payload.stepId ?? ''
        const status: string = payload.status ?? ''
        const error: string = payload.error ?? ''
        this.addCard({
          type: 'workflow',
          priority: error ? 1 : 2,
          title: `工作流步骤: ${stepId.slice(0, 20)}`,
          summary: error
            ? `步骤失败: ${error.length > 60 ? error.slice(0, 57) + '...' : error}`
            : status === 'completed'
              ? '步骤完成'
              : `状态: ${status}`,
          icon: error ? '⚠️' : EVENT_SOURCE_ICONS.workflow,
          actionable: error ? true : false,
          actionLabel: error ? '查看错误' : undefined,
          actionPayload: error ? { stepId, error } : undefined,
        })
      },
      this.subs,
      'ecb:workflow',
    )
  }

  private subscribeAgentEvents(): void {
    eventBus.track(
      'agent.error' as any,
      (payload: any) => {
        if (!this.enabledSources.has('agent_error')) return
        const error: string = payload.error ?? '未知错误'
        this.addCard({
          type: 'agent_error',
          priority: 1,
          title: 'Agent 错误',
          summary: error.length > 80 ? error.slice(0, 77) + '...' : error,
          icon: EVENT_SOURCE_ICONS.agent_error,
          actionable: true,
          actionLabel: '查看错误',
          actionPayload: { error },
        })
      },
      this.subs,
      'ecb:agent_error',
    )
  }

  // ══════════════════════════════════════════════════════════
  // 卡片管理
  // ══════════════════════════════════════════════════════════

  /**
   * 添加一张卡片并推送到渲染进程。
   */
  private addCard(data: {
    type: EventCardType
    priority: CardPriority
    title: string
    summary: string
    icon: string
    toolName?: string
    actionable: boolean
    actionLabel?: string
    actionPayload?: Record<string, any>
  }): void {
    const card: EventCard = {
      id: `ec_${Date.now()}_${++this.idCounter}`,
      ...data,
      timestamp: Date.now(),
    }

    // 添加到缓存（头部插入，最新的在前）
    this.cards.unshift(card)

    // 裁剪超出数量限制
    if (this.cards.length > MAX_CACHED_CARDS) {
      this.cards = this.cards.slice(0, MAX_CACHED_CARDS)
    }

    // 裁剪过期卡片
    this.pruneExpired()

    // 推送到渲染进程
    this.pushToRenderer()
  }

  /**
   * 移除过期卡片并返回最新推送列表。
   */
  private pruneExpired(): void {
    const cutoff = Date.now() - CARD_TTL_MS
    this.cards = this.cards.filter((c) => c.timestamp > cutoff)
  }

  /**
   * 推送排序后的卡片列表到所有窗口。
   * 按 priority 升序（重要在前），同优先级按 timestamp 降序（最新在前）。
   */
  private pushToRenderer(): void {
    const sorted = this.getSortedCards()
    const payload = sorted.slice(0, MAX_PUSH_CARDS)

    const wins = BrowserWindow.getAllWindows()
    for (const win of wins) {
      if (win && !win.isDestroyed()) {
        win.webContents.send('wallpaper:event-cards', payload)
      }
    }
  }

  /**
   * 获取排序后的卡片列表。
   * 按 priority 升序，同优先级按 timestamp 降序。
   */
  getSortedCards(): EventCard[] {
    this.pruneExpired()
    return [...this.cards].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority
      return b.timestamp - a.timestamp
    })
  }

  /**
   * 手动推送当前卡片到渲染进程（用于客户端请求刷新）。
   */
  refreshPush(): void {
    this.pushToRenderer()
  }
}

// ════════════════════════════════════════════════════════════
// 全局单例
// ════════════════════════════════════════════════════════════

export const eventCardBridge = new EventCardBridge()
