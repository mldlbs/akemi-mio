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
import { startupRadarAdapter } from '../../startup-radar'
import { radarPushRuleStore } from './RadarPushRuleStore'
import { eventBus } from '../../core/EventBus'
import type { RadarPushRule } from './types'

// ════════════════════════════════════════════════════════════════
// 配置
// ════════════════════════════════════════════════════════════════

/** 两次推送之间的最小间隔（分钟），避免重复推送 */
const MIN_PUSH_INTERVAL_MS = 5 * 60 * 1000 // 5 分钟

/** 雷达扫描的最大信号数 */
const MAX_SCAN_SIGNALS = 10

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
      const rules = radarPushRuleStore.getEnabled()
      if (rules.length === 0) return 'no_rules'

      const now = new Date()
      const currentMinute = now.getMinutes()
      const currentHour = now.getHours()
      const currentDay = now.getDay() // 0=Sun

      let matchedCount = 0

      for (const rule of rules) {
        if (this.isRuleMatching(rule, currentMinute, currentHour, currentDay)) {
          // 检查是否在最小间隔内推送过
          if (rule.lastPushedAt && Date.now() - rule.lastPushedAt < MIN_PUSH_INTERVAL_MS) {
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
        this.lastGlobalPushTime = Date.now()
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
   * 执行推送：触发雷达扫描并发送结果到 Telegram。
   */
  private async executePush(rule: RadarPushRule): Promise<void> {
    log('INFO', 'radar_push_executing', {
      id: rule.id,
      name: rule.name,
      keywords: rule.keywords,
      location: rule.location,
    })

    // 1. 构建扫描参数
    const sources = rule.sources.length > 0
      ? rule.sources
      : ['hackernews', 'github_trending', '36kr']

    // 合并地点到关键词
    const keywords = [...rule.keywords]
    if (rule.location && !keywords.includes(rule.location)) {
      keywords.push(rule.location)
    }

    // 2. 执行雷达扫描
    const result = await startupRadarAdapter.scan({
      sources: sources as any[],
      keywords: keywords.length > 0 ? keywords : undefined,
      limit: MAX_SCAN_SIGNALS,
      minScore: 0.3,
    })

    // 3. 格式化并推送
    if (!result || result.signals.length === 0) {
      // 无信号时，推送一条简洁的"无新信息"
      const noSignalMsg = [
        `📡 **雷达推送: ${rule.name}**`,
        `━━━ ⏰ ${new Date().toLocaleString('zh-CN', { hour12: false })} ━━━`,
        '',
        '📭 当前无匹配的新信号。',
        rule.location ? `📍 ${rule.location}` : '',
        keywords.length > 0 ? `🔑 ${keywords.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n')

      this.emitPushEvent(rule, noSignalMsg, 0)
    } else {
      // 有信号，使用适配器的批量格式化
      const signalMsg = startupRadarAdapter.formatBatchForTelegram(result.signals, {
        detailed: false,
        showScores: false,
        showUrl: true,
      })

      const header = `📡 **雷达推送: ${rule.name}**\n━━━ ⏰ ${new Date().toLocaleString('zh-CN', { hour12: false })} ━━━\n\n`
      const fullMsg = header + signalMsg

      this.emitPushEvent(rule, fullMsg, result.signals.length)
    }

    // 4. 更新规则推送状态
    radarPushRuleStore.markPushed(rule.id)
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
