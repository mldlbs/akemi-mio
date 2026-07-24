/**
 * SchedulerNotificationBridge — 调度事件 → 语音/桌面通知桥接
 *
 * 将 plan_scheduler.* 事件转化为 TTS 语音通知和桌面提示。
 *
 * 职责：
 * 1. 订阅 EventBus 中所有 plan_scheduler.* 事件
 * 2. 根据事件类型和过滤规则决定是否需要通知
 * 3. 生成简洁的中文语音摘要
 * 4. 高优先级（错误/失败）通知立即发送，常规通知排队
 * 5. Task failed 累积去重：同类错误 1 分钟内不重复播报
 *
 * 集成方式：
 * - 在 PlanSchedulerCoordinator.start() 时自动调用 start()
 * - 也可独立使用：new SchedulerNotificationBridge().start()
 * - 通过 ttsNotifyFilter 全局过滤器控制通知行为
 */

import { eventBus, type SubscriptionTracker } from '../core/EventBus'
import { log } from '../logger/Logger'
import { cleanTTS } from '../tts/TtsService'
import { ttsNotifyFilter, notificationQueue, type NotifyPriority } from '../tool/definitions/TtsNotifyTool'

// ════════════════════════════════════════════════════════════════
//  类型定义
// ════════════════════════════════════════════════════════════════

/** 通知事件映射：事件类型 → (优先级, 生成摘要) */
interface ScheduledEventTemplate {
  priority: NotifyPriority
  template: (payload: any) => string
}

// ════════════════════════════════════════════════════════════════
//  事件模板（中文语音友好）
// ════════════════════════════════════════════════════════════════

const EVENT_TEMPLATES: Record<string, ScheduledEventTemplate> = {
  plan_scheduler_plan_execution_started: {
    priority: 'normal',
    template: (p: any) => {
      return `开始执行计划 "${p.planTitle}"，共 ${p.taskCount} 个步骤`
    },
  },
  plan_scheduler_plan_execution_completed: {
    priority: 'high',
    template: (p: any) => {
      return `计划执行完成`
    },
  },
  plan_scheduler_plan_execution_failed: {
    priority: 'high',
    template: (p: any) => {
      return `计划执行失败: ${p.error}`
    },
  },
  plan_scheduler_task_completed: {
    priority: 'low',
    template: (_p: any) => {
      return '' // 单个任务完成默认不播报，避免频繁打扰
    },
  },
  plan_scheduler_task_failed: {
    priority: 'normal',
    template: (p: any) => {
      return `任务执行失败，第 ${p.attempt} 次重试`
    },
  },
  plan_scheduler_task_degraded: {
    priority: 'low',
    template: (p: any) => {
      return `自动降级到 ${p.fallbackTool}: ${p.reason}`
    },
  },
  plan_scheduler_task_needs_confirm: {
    priority: 'high',
    template: (p: any) => {
      return `需要确认: ${p.issue}`
    },
  },
  plan_scheduler_suggestion_generated: {
    priority: 'low',
    template: (p: any) => {
      return `调度建议: ${p.suggestion}`
    },
  },
}

// ════════════════════════════════════════════════════════════════
//  错误去重：同类错误 1 分钟内不重复播报
// ════════════════════════════════════════════════════════════════

const DEDUP_WINDOW_MS = 60_000
const dedupCache = new Map<string, number>()

function isDuplicate(key: string): boolean {
  const now = Date.now()
  const last = dedupCache.get(key)
  if (last && now - last < DEDUP_WINDOW_MS) return true
  dedupCache.set(key, now)
  return false
}

function cleanupDedupCache(): void {
  const now = Date.now()
  for (const [key, ts] of dedupCache) {
    if (now - ts > DEDUP_WINDOW_MS) dedupCache.delete(key)
  }
}
// 每 5 分钟清理一次过期键
setInterval(cleanupDedupCache, 5 * 60_000).unref()

// ════════════════════════════════════════════════════════════════
//  SchedulerNotificationBridge
// ════════════════════════════════════════════════════════════════

export class SchedulerNotificationBridge {
  private started = false
  private disposers: Array<() => void> = []

  /** 启动桥接：订阅所有 plan_scheduler 事件 */
  start(): void {
    if (this.started) return
    this.started = true

    log('INFO', 'sched_notif_bridge_start')

    // 为每个已知事件模板创建订阅
    for (const [eventName, template] of Object.entries(EVENT_TEMPLATES)) {
      const eventKey = eventName.replace(/_/g, '.') as any

      const disposer = eventBus.on(
        eventKey,
        (payload: any) => this.handleEvent(eventName, payload, template),
        { priority: template.priority === 'high' ? 'high' : 'low', label: `sched_notif:${eventName}` },
      )
      this.disposers.push(disposer)
    }

    log('INFO', 'sched_notif_bridge_running', {
      subscribedCount: Object.keys(EVENT_TEMPLATES).length,
    })
  }

  /** 使用 SubscriptionTracker 启动（自动清理生命周期） */
  startWithTracker(tracker: SubscriptionTracker): void {
    if (this.started) return
    this.started = true

    log('INFO', 'sched_notif_bridge_start')

    for (const [eventName, template] of Object.entries(EVENT_TEMPLATES)) {
      const eventKey = eventName.replace(/_/g, '.') as any

      eventBus.track(
        eventKey,
        (payload: any) => this.handleEvent(eventName, payload, template),
        tracker,
        { priority: template.priority === 'high' ? 'high' : 'low', label: `sched_notif:${eventName}` },
      )
    }

    log('INFO', 'sched_notif_bridge_running', {
      subscribedCount: Object.keys(EVENT_TEMPLATES).length,
    })
  }

  /** 停止桥接 */
  stop(): void {
    if (!this.started) return

    for (const disposer of this.disposers) {
      try { disposer() } catch { /* ignore */ }
    }
    this.disposers = []

    this.started = false
    log('INFO', 'sched_notif_bridge_stopped')
  }

  /** 是否运行中 */
  isRunning(): boolean {
    return this.started
  }

  /** 处理事件 */
  private handleEvent(eventName: string, payload: any, template: ScheduledEventTemplate): void {
    try {
      // 全局通知开关
      if (!ttsNotifyFilter.enabled) return

      // 生成摘要
      const summary = template.template(payload)
      if (!summary || summary.length < 3) return

      // 清理 TTS 不友好字符
      const cleaned = cleanTTS(summary)
      if (!cleaned || cleaned.length < 3) return

      // 高优先级事件错误去重
      if (template.priority === 'normal' || template.priority === 'high') {
        const dedupKey = `${eventName}:${summary.slice(0, 40)}`
        if (isDuplicate(dedupKey)) {
          log('INFO', 'sched_notif_bridge_dedup', { eventName, summary: summary.slice(0, 40) })
          return
        }
      }

      log('INFO', 'sched_notif_bridge_notify', {
        eventName,
        priority: template.priority,
        summary: summary.slice(0, 60),
      })

      // 推送到通知队列
      notificationQueue.enqueue(cleaned, template.priority)
    } catch (err) {
      log('WARN', 'sched_notif_bridge_error', {
        error: String(err),
        eventName,
      })
    }
  }
}

// ════════════════════════════════════════════════════════════════
//  全局单例 & 工厂函数
// ════════════════════════════════════════════════════════════════

export const schedulerNotificationBridge = new SchedulerNotificationBridge()

/**
 * 创建并启动调度通知桥接。
 * 推荐在 PlanSchedulerCoordinator.start() 中调用此函数。
 */
export function createAndStartSchedulerNotificationBridge(tracker?: SubscriptionTracker): SchedulerNotificationBridge {
  if (tracker) {
    schedulerNotificationBridge.startWithTracker(tracker)
  } else {
    schedulerNotificationBridge.start()
  }
  return schedulerNotificationBridge
}
