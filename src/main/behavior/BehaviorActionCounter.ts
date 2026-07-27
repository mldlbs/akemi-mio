/**
 * BehaviorActionCounter — 行为使用频率计数器（轻量版）
 *
 * 追踪用户最近的操作行为（语音输入、工具调用等），
 * 维护一个使用频率计数器，供 Wallpaper Overlay 显示高频快捷入口。
 *
 * 数据流：
 *   1. 订阅 EventBus 中 agent.tool.invoked / voice.recording.started 等事件
 *   2. 在内存中维护 actionId → count 的频率映射（最近 N 条交互窗口）
 *   3. 通过 getTopActions(n) 返回 Top-n 高频动作
 *   4. 频率变化时通过 IPC 推送到渲染进程
 *
 * 动作条目定义：
 *   - actionId: 唯一标识（如 'voice:start', 'tool:read_file'）
 *   - label:    显示文本（如 '语音输入', '读取文件'）
 *   - icon:     图标 class（如 'ri-mic-line', 'ri-file-text-line'）
 *   - category: 分类（'voice' | 'tool'）
 *
 * @module behavior
 */

import { BrowserWindow } from 'electron'
import { log } from '../logger/Logger'
import { eventBus, SubscriptionTracker } from '../core/EventBus'

// ════════════════════════════════════════════════════════════
// 类型定义
// ════════════════════════════════════════════════════════════

/** 动作分类 */
export type ActionCategory = 'voice' | 'tool' | 'other'

/** 单个动作条目 */
export interface ActionEntry {
  /** 动作唯一标识 */
  actionId: string
  /** 分类 */
  category: ActionCategory
  /** 显示文本 */
  label: string
  /** 图标 class（remixicon 格式） */
  icon: string
  /** 触发方式（用于点击后执行） */
  trigger: 'voice:start' | 'tool:invoke'
  /** 触发关联的工具名（trigger=tool:invoke 时使用） */
  toolName?: string
}

/** 带频率的动作条目 */
export interface ActionEntryWithFrequency extends ActionEntry {
  /** 当前频率计数 */
  frequency: number
  /** 最后使用时间戳 */
  lastUsedAt: number
}

/** 推送到渲染进程的 Top-N 动作负载 */
export interface TopActionsPayload {
  actions: ActionEntryWithFrequency[]
  timestamp: number
}

// ════════════════════════════════════════════════════════════
// 已知动作注册表
// ════════════════════════════════════════════════════════════

/** 预注册的可追踪动作 */
const REGISTERED_ACTIONS: Record<string, ActionEntry> = {
  'voice:start': {
    actionId: 'voice:start',
    category: 'voice',
    label: '语音输入',
    icon: 'ri-mic-line',
    trigger: 'voice:start',
  },
  'voice:ode_solve': {
    actionId: 'voice:ode_solve',
    category: 'voice',
    label: '语音求解',
    icon: 'ri-function-line',
    trigger: 'voice:start',
  },
  'tool:desktop_quick_note': {
    actionId: 'tool:desktop_quick_note',
    category: 'tool',
    label: '快速笔记',
    icon: 'ri-sticky-note-line',
    trigger: 'tool:invoke',
    toolName: 'desktop_quick_note',
  },
  'tool:desktop_todo_add': {
    actionId: 'tool:desktop_todo_add',
    category: 'tool',
    label: '待办添加',
    icon: 'ri-task-line',
    trigger: 'tool:invoke',
    toolName: 'desktop_todo_add',
  },
  'tool:desktop_app_launch': {
    actionId: 'tool:desktop_app_launch',
    category: 'tool',
    label: '应用启动',
    icon: 'ri-apps-2-line',
    trigger: 'tool:invoke',
    toolName: 'desktop_app_launch',
  },
}

// ════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════

/** 交互窗口大小：只跟踪最近 N 次交互，超出的丢弃 */
const INTERACTION_WINDOW_SIZE = 50

/** Top-N 默认值 */
const DEFAULT_TOP_N = 2

/** 推送到渲染进程的 IPC 通道名 */
const IPC_CHANNEL = 'wallpaper:top-actions'

// ════════════════════════════════════════════════════════════
// BehaviorActionCounter
// ════════════════════════════════════════════════════════════

export class BehaviorActionCounter {
  private subscriptions = new SubscriptionTracker()
  private _started = false

  /** 交互历史队列（最近 INTERACTION_WINDOW_SIZE 条） */
  private interactionHistory: Array<{ actionId: string; timestamp: number }> = []

  /** 注册的动作表（actionId → ActionEntry） */
  private actions = new Map<string, ActionEntry>()

  /** 防抖：避免高频推送（ms） */
  private lastPushTime = 0
  private static readonly PUSH_THROTTLE_MS = 2000

  /** 是否已启动 */
  get started(): boolean {
    return this._started
  }

  // ══════════════════════════════════════════════════════════
  // 生命周期
  // ══════════════════════════════════════════════════════════

  /**
   * 注册初始动作并订阅 EventBus 事件。
   */
  start(): void {
    if (this._started) return
    this._started = true

    // 注册预定义动作
    for (const [id, entry] of Object.entries(REGISTERED_ACTIONS)) {
      this.actions.set(id, entry)
    }

    // 订阅工具调用事件
    eventBus.track(
      'agent.tool.invoked' as any,
      (payload: any) => {
        const toolName: string = payload.tool ?? 'unknown'
        this.recordToolAction(toolName)
      },
      this.subscriptions,
      'bac:tool_invoked',
    )

    // 订阅语音录制事件
    eventBus.track(
      'voice.recording.started' as any,
      () => {
        this.recordAction('voice:start')
      },
      this.subscriptions,
      'bac:voice_start',
    )

    log('INFO', 'behavior_action_counter_started')
  }

  /**
   * 停止计数器，清理所有订阅。
   */
  stop(): void {
    this.subscriptions.dispose()
    this._started = false
    this.interactionHistory = []
    log('INFO', 'behavior_action_counter_stopped')
  }

  // ══════════════════════════════════════════════════════════
  // 动作注册
  // ══════════════════════════════════════════════════════════

  /**
   * 注册或更新一个动作条目。
   * 外部模块可调用此方法注册自定义工具动作。
   */
  registerAction(entry: ActionEntry): void {
    this.actions.set(entry.actionId, entry)
  }

  // ══════════════════════════════════════════════════════════
  // 动作记录
  // ══════════════════════════════════════════════════════════

  /**
   * 记录一个动作（外部或 IPC 调用）。
   * @param actionId 动作标识
   */
  recordAction(actionId: string): void {
    // 未知动作不记录
    if (!this.actions.has(actionId)) return

    const now = Date.now()
    this.interactionHistory.push({ actionId, timestamp: now })

    // 裁剪超出窗口
    if (this.interactionHistory.length > INTERACTION_WINDOW_SIZE) {
      this.interactionHistory = this.interactionHistory.slice(-INTERACTION_WINDOW_SIZE)
    }

    // 推送到渲染进程（带节流）
    this.throttledPush()
  }

  /**
   * 根据工具名记录工具调用动作。
   * 将工具名映射到注册的动作，若未注册则自动创建一个通用条目。
   */
  recordToolAction(toolName: string): void {
    // 检查是否已有该工具的注册动作
    const actionId = `tool:${toolName}`
    if (this.actions.has(actionId)) {
      this.recordAction(actionId)
      return
    }

    // 自动注册通用工具条目
    const label = this.humanizeToolName(toolName)
    this.actions.set(actionId, {
      actionId,
      category: 'tool',
      label,
      icon: 'ri-tools-line',
      trigger: 'tool:invoke',
      toolName,
    })
    this.recordAction(actionId)
  }

  // ══════════════════════════════════════════════════════════
  // 查询接口
  // ══════════════════════════════════════════════════════════

  /**
   * 获取 Top-N 高频动作（按频率降序）。
   * @param n 返回条数（默认 2）
   */
  getTopActions(n: number = DEFAULT_TOP_N): ActionEntryWithFrequency[] {
    const freqMap = this.computeFrequencies()
    const sorted = Array.from(freqMap.entries())
      .sort((a, b) => {
        // 按频率降序，同频率按最后使用时间降序
        if (b[1].count !== a[1].count) return b[1].count - a[1].count
        return b[1].lastUsed - a[1].lastUsed
      })
      .slice(0, n)

    return sorted.map(([actionId, { count, lastUsed }]) => {
      const entry = this.actions.get(actionId)!
      return {
        ...entry,
        frequency: count,
        lastUsedAt: lastUsed,
      }
    })
  }

  /**
   * 获取当前交互窗口的频率统计。
   */
  getInteractionStats(): {
    totalInteractions: number
    topActions: ActionEntryWithFrequency[]
    historySize: number
  } {
    return {
      totalInteractions: this.interactionHistory.length,
      topActions: this.getTopActions(DEFAULT_TOP_N),
      historySize: INTERACTION_WINDOW_SIZE,
    }
  }

  // ══════════════════════════════════════════════════════════
  // 推送
  // ══════════════════════════════════════════════════════════

  /**
   * 手动触发现推送（可由外部调用刷新）。
   */
  pushToRenderer(): void {
    this.doPush()
  }

  // ══════════════════════════════════════════════════════════
  // 内部方法
  // ══════════════════════════════════════════════════════════

  /**
   * 计算交互窗口内各动作的频率。
   */
  private computeFrequencies(): Map<string, { count: number; lastUsed: number }> {
    const freqMap = new Map<string, { count: number; lastUsed: number }>()

    for (const record of this.interactionHistory) {
      const existing = freqMap.get(record.actionId)
      if (existing) {
        existing.count++
        if (record.timestamp > existing.lastUsed) {
          existing.lastUsed = record.timestamp
        }
      } else {
        freqMap.set(record.actionId, { count: 1, lastUsed: record.timestamp })
      }
    }

    return freqMap
  }

  /**
   * 节流推送：限制推送频率，避免高频事件导致渲染进程频繁更新。
   */
  private throttledPush(): void {
    const now = Date.now()
    if (now - this.lastPushTime < BehaviorActionCounter.PUSH_THROTTLE_MS) return
    this.lastPushTime = now
    this.doPush()
  }

  /**
   * 实际推送 Top-N 动作到渲染进程。
   */
  private doPush(): void {
    const topActions = this.getTopActions(DEFAULT_TOP_N)
    const payload: TopActionsPayload = {
      actions: topActions,
      timestamp: Date.now(),
    }

    const wins = BrowserWindow.getAllWindows()
    for (const win of wins) {
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC_CHANNEL, payload)
      }
    }
  }

  /**
   * 将工具名转换为人类可读标签。
   * eg. 'read_file' → '读取文件', 'desktop_quick_note' → '快速笔记'
   */
  private humanizeToolName(name: string): string {
    // 移除非通用前缀
    const stripped = name.replace(/^desktop_/, '').replace(/^ai_/, '')
    // snake_case → 中文近似
    const parts = stripped.split('_')
    const known: Record<string, string> = {
      read: '读取',
      write: '写入',
      search: '搜索',
      query: '查询',
      list: '列表',
      create: '创建',
      delete: '删除',
      update: '更新',
      get: '获取',
      set: '设置',
      run: '运行',
      execute: '执行',
      note: '笔记',
      todo: '待办',
      task: '任务',
      quick: '快捷',
      app: '应用',
      launch: '启动',
      file: '文件',
      text: '文本',
      image: '图片',
      chat: '对话',
    }
    const translated = parts.map((p) => known[p] || p)
    return translated.join('')
  }
}

// ════════════════════════════════════════════════════════════
// 全局单例
// ════════════════════════════════════════════════════════════

/** 全局 BehaviorActionCounter 单例 */
export const behaviorActionCounter = new BehaviorActionCounter()
