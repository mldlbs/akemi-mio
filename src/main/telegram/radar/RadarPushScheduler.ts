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
   * 从远程 Radar API 获取数据并格式化为中文解读风格消息。
   */
  private async fetchRemoteRadarMessage(rule: RadarPushRule): Promise<string> {
    const THEME_CN: Record<string, string> = {
      ai_infrastructure: 'AI 基础设施', dev_productivity: '开发者工具',
      compliance_automation: '合规自动化', data_tools: '数据工具',
      knowledge_management: '知识管理', collaboration: '协同办公',
      nocode_lowcode: '低代码', fintech: '金融科技',
      security: '安全', other: '其他',
    }
    const TYPE_CN: Record<string, string> = {
      market_gap: '市场缺口', feature_request: '功能需求',
      replacement: '替代方案', workflow: '流程痛点', bug: 'Bug 修复',
    }

    try {
      const res = await fetchWithRetry('https://ai.crlkcloud.cyou/radar/pipeline', 2)
      if (!res.ok) return `📡 创业雷达 | 服务暂不可用 (${res.status})`

      const body: any = await res.json()
      const signals: any[] = body.signals || []
      const opps: any[] = body.opportunities || []
      const themes: any[] = body.themes || []

      // ── 信号按主题归类计数 ──
      const themeCounts = new Map<string, number>()
      for (const s of signals) {
        const t = THEME_CN[s.theme] || s.theme || '其他'
        themeCounts.set(t, (themeCounts.get(t) || 0) + 1)
      }
      const themeDist = [...themeCounts.entries()].sort((a, b) => b[1] - a[1])

      // ── 机会排序 TOP 3 ──
      const topOpps = [...opps]
        .sort((a: any, b: any) => (b.avg_score || 0) - (a.avg_score || 0))
        .slice(0, 3)

      // ── 主题热度 TOP 5 ──
      const topThemes = [...themes].sort((a, b) => b.count - a.count).slice(0, 5)

      const highValue = signals.filter((s: any) => (s.score || 0) >= 7).length

      // ═══════════════════════ 组装消息 ═══════════════════════
      const lines: string[] = []

      // 头部：一句概况
      const dateStr = new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour12: false })
      const summary = `📡 创业雷达 · ${dateStr}`
      lines.push(summary)

      // 数据句
      let dataLine = `  捕获 ${signals.length} 条信号`
      if (highValue > 0) dataLine += `（${highValue} 条高价值）`
      dataLine += `，${opps.length} 个持续机会`
      if (topThemes.length > 0) {
        const names = topThemes.slice(0, 3).map((t: any) => THEME_CN[t.theme] || t.theme)
        dataLine += ` · 最热 ${names.join(' / ')}`
      }
      lines.push(dataLine)

      // 间隔行
      lines.push('')

      // ── 信号分布 ──
      if (themeDist.length > 0) {
        const parts = themeDist.slice(0, 5).map(([name, count]) => `${name} ${count}`)
        lines.push(`📊 信号分布  ${parts.join(' · ')}`)
      }

      // ── 机会榜 ──
      if (topOpps.length > 0) {
        lines.push('')
        lines.push(`💡 TOP ${topOpps.length} 机会`)
        for (const o of topOpps) {
          const type = TYPE_CN[o.type] || o.type || ''
          const title = (o.title || '').slice(0, 40)
          const score = o.avg_score || o.avg_pain || ''
          lines.push(`  ${title}`)
          const tags: string[] = []
          if (type) tags.push(type)
          if (score) tags.push(`评分 ${score}`)
          if (o.appearances > 1) tags.push(`${o.appearances} 次`)
          if (o.consecutive_days) tags.push(`连 ${o.consecutive_days} 天`)
          if (tags.length) lines.push(`  ${' '.repeat(2)}${tags.join('  ')}`)
        }
      }

      // ── 高价值信号概览 ──
      if (highValue > 0) {
        const hvSignals = signals.filter((s: any) => (s.score || 0) >= 7).slice(0, 3)
        lines.push('')
        lines.push(`🔥 高价值信号`)
        for (const s of hvSignals) {
          const theme = THEME_CN[s.theme] || s.theme || ''
          const raw = s.business_value ?? s.problem ?? ''
          const brief = String(raw).slice(0, 50)
          lines.push(`  ${theme ? `[${theme}] ` : ''}${brief}`)
        }
      }

      // ── 底部 ──
      lines.push('')
      lines.push(`💬 /radar 查看详情 · ${dateStr}`)

      return lines.join('\n')
    } catch (err: any) {
      log('WARN', 'remote_radar_fetch_failed', { error: err.message })
      return `📡 创业雷达 | 获取失败: ${err.message}`
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
