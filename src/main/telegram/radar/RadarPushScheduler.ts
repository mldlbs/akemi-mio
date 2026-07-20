/**
 * RadarPushScheduler — 雷达推送规则定时调度器
 *
 * 使用已有的 Scheduler 类，每分钟检查所有已启用的推送规则，
 * 当当前时间匹配规则时，触发 StartupRadarAdapter 扫描并通过 Telegram 推送结果。
 *
 * ## 工作流
 *
 *   Scheduler.cron('*', '*', tick)  // 每 30 秒检查一次
 *       ↓
 *   tick() → 遍历所有 enabled 规则
 *       ↓ 规则时间匹配
 *   startupRadarAdapter.scan() → Telegram enqueueReply
 *
 * ## 持久化
 *
 * 调度器在系统重启后自动重新加载规则（从 SQLite），
 * 不丢失定时任务配置。
 */

import { log } from '../../logger/Logger'
import { scheduler } from '../../core/Scheduler'
import { radarPushRuleStore } from './RadarPushRuleStore'
import { eventBus } from '../../core/EventBus'
import type { RadarPushRule } from './types'

// ════════════════════════════════════════════════════════════════
// 配置
// ════════════════════════════════════════════════════════════════

/** 两次推送之间的最小间隔（分钟），避免重复推送 */
const MIN_PUSH_INTERVAL_MS = 5 * 60 * 1000 // 5 分钟

/** 没有规则时默认使用的规则名 */
const DEFAULT_RULE_NAME = '默认推送'

/** 带重试的 fetch，超时 30s */
async function fetchWithRetry(url: string, retries = 2): Promise<Response> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(30000) })
    } catch (err) {
      if (i < retries) {
        log('WARN', 'remote_radar_retry', { attempt: i + 1, error: String(err) })
        await new Promise((r) => setTimeout(r, 2000))
      } else {
        throw err
      }
    }
  }
  throw new Error('unreachable')
}

// ════════════════════════════════════════════════════════════════
// RadarPushScheduler
// ════════════════════════════════════════════════════════════════

export class RadarPushScheduler {
  /** Scheduler 任务 ID */
  private taskId: string | null = null

  /** 是否已启动 */
  private running = false

  /** 最后一次推送时间（用于全局去重） */
  private lastGlobalPushTime = 0

  /** 最后一次推送的消息 hash，用于内容级去重 */
  private lastMessageHash = ''

  // ════════════════════════════════════════════════════════════════
  // 生命周期
  // ════════════════════════════════════════════════════════════════

  /**
   * 启动调度器：每分钟检查一次规则匹配。
   * 在 AppRuntime 初始化完成后调用。
   */
  start(): void {
    if (this.running) return

    // 确保 store 已初始化
    radarPushRuleStore.initialize()

    // 使用 Scheduler.cron 注册每分钟检查任务
    // cron('*', '*') 每 30 秒检查一次 tick ⇒ 实际检查频率为 30 秒
    this.taskId = scheduler.cron('*', '*', () => this.tick(), '@radar-push')

    this.running = true
    log('INFO', 'radar_push_scheduler_started')

    // 发出事件
    eventBus.emit('radar.push.scheduler_started', {
      timestamp: Date.now(),
    } as any)
  }

  /**
   * 停止调度器。
   */
  stop(): void {
    if (!this.running) return

    if (this.taskId) {
      scheduler.cancel(this.taskId)
      this.taskId = null
    }

    this.running = false
    log('INFO', 'radar_push_scheduler_stopped')
  }

  /**
   * 调度器是否正在运行。
   */
  get isRunning(): boolean {
    return this.running
  }

  // ════════════════════════════════════════════════════════════════
  // 核心逻辑
  // ════════════════════════════════════════════════════════════════

  /**
   * 每次 tick（每 ~30 秒）检查所有已启用规则是否匹配当前时间。
   */
  private tick(): string {
    try {
      // 检查全局冷却
      const now = Date.now()
      if (now - this.lastGlobalPushTime < MIN_PUSH_INTERVAL_MS) {
        return 'cooldown'
      }

      const rules = radarPushRuleStore.getEnabled()
      if (rules.length === 0) {
        // 没有规则时使用默认规则直接推送
        this.lastGlobalPushTime = Date.now()
        this.executePush(this.defaultRule()).catch((err) => {
          log('ERROR', 'radar_push_execution_failed', {
            id: 'default',
            error: String(err),
          })
        })
        return 'default_push'
      }

      const currentMinute = new Date().getMinutes()
      const currentHour = new Date().getHours()
      const currentDay = new Date().getDay() // 0=Sun

      let matchedCount = 0

      for (const rule of rules) {
        if (this.isRuleMatching(rule, currentMinute, currentHour, currentDay)) {
          // 检查是否在最小间隔内推送过
          if (rule.lastPushedAt && now - rule.lastPushedAt < MIN_PUSH_INTERVAL_MS) {
            log('DEBUG', 'radar_push_skipped_cooldown', {
              id: rule.id,
              lastPushed: new Date(rule.lastPushedAt).toISOString(),
            })
            continue
          }

          matchedCount++
          this.executePush(rule).catch((err) => {
            log('ERROR', 'radar_push_execution_failed', {
              id: rule.id,
              error: String(err),
            })
          })
        }
      }

      if (matchedCount > 0) {
        this.lastGlobalPushTime = now
      }

      return `matched=${matchedCount}`
    } catch (err) {
      log('ERROR', 'radar_push_tick_error', { error: String(err) })
      return 'error'
    }
  }

  /**
   * 判断规则是否匹配当前时间。
   */
  private isRuleMatching(
    rule: RadarPushRule,
    currentMinute: number,
    currentHour: number,
    currentDay: number,
  ): boolean {
    // 检查分钟
    if (rule.minute !== currentMinute) return false

    // 检查小时
    if (rule.hour !== currentHour) return false

    // 检查星期
    switch (rule.frequency) {
      case 'daily':
        return true
      case 'weekday':
        return currentDay >= 1 && currentDay <= 5
      case 'weekend':
        return currentDay === 0 || currentDay === 6
      case 'weekly':
        return rule.dayOfWeek === undefined || rule.dayOfWeek === currentDay
      default:
        return true
    }
  }

  /**
   * 执行推送：从远程 Radar API 获取数据并发送到 Telegram。
   */
  private async executePush(rule: RadarPushRule): Promise<void> {
    log('INFO', 'radar_push_executing', {
      id: rule.id,
      name: rule.name,
      keywords: rule.keywords,
      location: rule.location,
    })

    const message = await this.fetchRemoteRadarMessage(rule)

    // 内容级去重：相同消息不重复推送
    const hash = simpleHash(message)
    if (hash === this.lastMessageHash) {
      log('INFO', 'radar_push_duplicate_skipped', { hash })
      return
    }
    this.lastMessageHash = hash

    this.emitPushEvent(rule, message, 0)
    radarPushRuleStore.markPushed(rule.id)
  }

  /**
   * 从 /api/briefing 获取已格式化好的中文简报，直接作为推送消息。
   */
  private async fetchRemoteRadarMessage(rule: RadarPushRule): Promise<string> {
    try {
      const res = await fetchWithRetry('https://ai.crlkcloud.cyou/api/briefing', 2)
      if (!res.ok) return `📡 商业信号雷达 | 服务暂不可用 (${res.status})`

      const text = await res.text()
      const lines = text.split('\n')

      // 替换头部：统一冠名
      const header = `📡 商业信号雷达 · ${new Date().toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}`
      // 第一行原始是 "📡 商业信号雷达 · X月X日 周X"，替换掉保持统一格式
      const body = lines.map((l, i) => (i === 0 ? header : l)).join('\n')

      return body
    } catch (err: any) {
      log('WARN', 'remote_radar_fetch_failed', { error: err.message })
      return `📡 商业信号雷达 | 获取失败: ${err.message}`
    }
  }

  /** 当数据库中没有规则时使用的默认规则 */
  private defaultRule(): RadarPushRule {
    return {
      id: '__default__',
      name: DEFAULT_RULE_NAME,
      enabled: true,
      frequency: 'daily',
      minute: new Date().getMinutes(),
      hour: new Date().getHours(),
      keywords: [],
      sources: [],
      rawText: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pushCount: 0,
    }
  }

  /**
   * 通过 EventBus 发出推送事件，由 TelegramService 订阅并发送。
   */
  private emitPushEvent(rule: RadarPushRule, message: string, signalCount: number): void {
    eventBus.emit('radar.push.rule_fired', {
      ruleId: rule.id,
      ruleName: rule.name,
      message,
      signalCount,
      timestamp: Date.now(),
    } as any)
  }
}

/** 全局单例 */
export const radarPushScheduler = new RadarPushScheduler()

/** 简单哈希 */
function simpleHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(36)
}
