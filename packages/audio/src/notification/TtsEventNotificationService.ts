/**
 * TtsEventNotificationService — 事件驱动的 TTS 语音通知服务
 *
 * 职责：
 * 1. 订阅 EventBus 的 agent.tool.completed / agent.tool.failed 事件
 * 2. 根据过滤规则决定哪些事件需要语音播报
 * 3. 生成简洁的文字摘要
 * 4. 按优先级推送到 NotificationQueue 进行语音合成
 * 5. 高优先级（错误/失败）立即播放，常规通知按队列顺序播放
 *
 * 与 tts_notify 工具的关系：
 * - tts_notify: 手动触发的语音通知（供 Agent/LLM 调用）
 * - TtsEventNotificationService: 自动触发的事件通知（后台自动监听）
 * - 两者共享 NotificationQueue，避免音频重叠
 *
 * 集成方式：
 * - 在 AppRuntime 初始化时调用 createAndStartTtsEventNotifier()
 * - 通过 ttsNotifyFilter 全局过滤器动态调整行为
 * - 通过 tts_notify_config 工具可运行时修改过滤规则
 */

import { eventBus, type EventPayload, type SubscriptionTracker } from '@akemi-mio/core/core/EventBus'
import { log } from '@akemi-mio/core/logger/Logger'
import { cleanTTS } from '@akemi-mio/audio/TtsService'
import { ttsNotifyFilter, notificationQueue, type NotifyPriority } from '@akemi-mio/capabilities/tool/definitions/TtsNotifyTool'

// =============================================================================
//  通知事件类型
// =============================================================================

export type NotifyEventType = 'tool_completed' | 'tool_failed'

/** 工具事件 → 通知摘要映射 */
interface EventToSummary {
  priority: NotifyPriority
  template: (payload: any) => string
}

// =============================================================================
//  事件 → 摘要模板
// =============================================================================

const EVENT_TEMPLATES: Record<NotifyEventType, EventToSummary> = {
  tool_completed: {
    priority: 'normal',
    template: (p: EventPayload['agent.tool.completed']) => {
      const toolName = p.tool
      // 从结果中提取简短摘要
      const resultSnippet = extractResultSnippet(p.result, ttsNotifyFilter.maxTextLength)
      if (resultSnippet && ttsNotifyFilter.style === 'full') {
        return `${toolName} 完成: ${resultSnippet}`
      }
      return `${toolName} 执行成功`
    },
  },
  tool_failed: {
    priority: 'high',
    template: (p: EventPayload['agent.tool.failed']) => {
      const toolName = p.tool
      const errorSnippet = extractErrorSnippet(p.error, ttsNotifyFilter.maxTextLength)
      if (errorSnippet) {
        return `警告: ${toolName} 执行失败 — ${errorSnippet}`
      }
      return `警告: ${toolName} 执行出错`
    },
  },
}

// =============================================================================
//  文本提取器
// =============================================================================

/**
 * 从工具结果中提取简短摘要。
 * 跳过代码块、JSON 等不适合朗读的内容。
 */
function extractResultSnippet(result: string, maxLen: number): string {
  if (!result || result.length < 3) return ''

  let cleaned = cleanTTS(result)

  // 如果清理后过短或过长，截断
  if (cleaned.length > maxLen) {
    cleaned = cleaned.slice(0, maxLen) + '…'
  }
  return cleaned
}

/**
 * 从错误信息中提取简短摘要。
 * 提取第一行或第一个有意义的句子。
 */
function extractErrorSnippet(error: string, maxLen: number): string {
  if (!error) return ''

  // 取第一行
  const firstLine = error.split('\n')[0].trim()
  let cleaned = cleanTTS(firstLine)

  if (cleaned.length > maxLen) {
    cleaned = cleaned.slice(0, maxLen) + '…'
  }
  return cleaned
}

// =============================================================================
//  过滤逻辑
// =============================================================================

/**
 * 检查指定工具是否应被过滤掉（不播报通知）。
 * 检查优先级：全局开关 > 黑名单 > 白名单
 */
function shouldFilterTool(toolName: string): boolean {
  if (!ttsNotifyFilter.enabled) return true

  // 黑名单匹配 — 过滤
  if (ttsNotifyFilter.blockTools.includes(toolName)) return true

  // 白名单：如果设置了白名单，只有白名单内的工具才通知
  if (ttsNotifyFilter.allowTools.length > 0) {
    return !ttsNotifyFilter.allowTools.includes(toolName)
  }

  return false
}

// =============================================================================
//  服务实现
// =============================================================================

export class TtsEventNotificationService {
  private started = false
  private disposers: Array<() => void> = []

  /** 启动服务：订阅事件 */
  start(): void {
    if (this.started) return
    this.started = true

    log('INFO', 'tts_notif_service_start')

    // 订阅工具完成事件
    const dis1 = eventBus.on('agent.tool.completed', (p) => this.handleEvent('tool_completed', p), {
      priority: 'low',
      label: 'tts_notif:tool_completed',
    })
    this.disposers.push(dis1)

    // 订阅工具失败事件
    const dis2 = eventBus.on('agent.tool.failed', (p) => this.handleEvent('tool_failed', p), {
      priority: 'high',
      label: 'tts_notif:tool_failed',
    })
    this.disposers.push(dis2)

    log('INFO', 'tts_notif_service_running')
  }

  /** 使用 SubscriptionTracker 启动（自动清理生命周期） */
  startWithTracker(tracker: SubscriptionTracker): void {
    if (this.started) return
    this.started = true

    log('INFO', 'tts_notif_service_start')

    eventBus.track('agent.tool.completed', (p) => this.handleEvent('tool_completed', p), tracker, {
      priority: 'low',
      label: 'tts_notif:tool_completed',
    })

    eventBus.track('agent.tool.failed', (p) => this.handleEvent('tool_failed', p), tracker, {
      priority: 'high',
      label: 'tts_notif:tool_failed',
    })

    log('INFO', 'tts_notif_service_running')
  }

  /** 停止服务：取消所有订阅 */
  stop(): void {
    if (!this.started) return

    for (const disposer of this.disposers) {
      try {
        disposer()
      } catch {
        // 忽略
      }
    }
    this.disposers = []
    this.started = false

    log('INFO', 'tts_notif_service_stopped')
  }

  /** 服务是否运行中 */
  isRunning(): boolean {
    return this.started
  }

  /** 处理事件 */
  private handleEvent(type: NotifyEventType, payload: any): void {
    try {
      const toolName = payload?.tool
      if (!toolName) return

      // 过滤检查
      if (shouldFilterTool(toolName)) return

      const template = EVENT_TEMPLATES[type]
      const summary = template.template(payload)

      // 如果摘要过短，跳过播报（避免播报无意义的内容）
      const cleaned = cleanTTS(summary)
      if (!cleaned || cleaned.length < 5) return

      log('INFO', 'tts_notif_event', {
        type,
        tool: toolName,
        priority: template.priority,
        summary: summary.slice(0, 60),
      })

      // 推送到通知队列
      notificationQueue.enqueue(summary, template.priority)
    } catch (err) {
      log('WARN', 'tts_notif_handle_error', {
        error: String(err),
        type,
        tool: payload?.tool,
      })
    }
  }
}

// =============================================================================
//  全局单例 & 工厂函数
// =============================================================================

export const ttsEventNotifier = new TtsEventNotificationService()

/**
 * 创建并启动事件通知服务。
 * 推荐在 AppRuntime 初始化时调用此函数。
 */
export function createAndStartTtsEventNotifier(tracker?: SubscriptionTracker): TtsEventNotificationService {
  if (tracker) {
    ttsEventNotifier.startWithTracker(tracker)
  } else {
    ttsEventNotifier.start()
  }
  return ttsEventNotifier
}
