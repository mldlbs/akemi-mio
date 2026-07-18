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

      const lines: string[] = [`📡 创业雷达速报`]
      lines.push(`━━━━━━━━━━━━━━━━━━━━`)

      // ── 数据概览 ──
      const totalSignals = signals.length
      const totalOpps = opps.length
      const topTheme = themes[0]
      const topThemeName = topTheme ? (THEME_CN[topTheme.theme] || topTheme.theme) : '—'
      const highValue = signals.filter((s: any) => (s.score || 0) >= 7).length

      const overviewBits: string[] = []
      if (totalSignals > 0) overviewBits.push(`${totalSignals} 条新信号`)
      if (totalOpps > 0) overviewBits.push(`${totalOpps} 个持续机会`)
      if (highValue > 0) overviewBits.push(`${highValue} 条高价值`)
      if (topThemeName !== '—') overviewBits.push(`最热: ${topThemeName}`)
      if (overviewBits.length > 0) {
        lines.push(`📊 本期监测到 ${overviewBits.join('，')}。`)
      }

      // ── 市场解读 ──
      if (themes.length > 0) {
        const hot = themes.slice(0, 4)
        const hotDesc = hot.map((t: any) => {
          const name = THEME_CN[t.theme] || t.theme
          return `${name}(${t.count} 条)`
        }).join('、')
        // 找最高 avg_score 的一些机会做解读
        const topByScore = [...opps].sort((a: any, b: any) => (b.avg_score || 0) - (a.avg_score || 0))
        const highlightOpp = topByScore[0]

        let insight = `本周热点领域: ${hotDesc}。`
        if (highlightOpp) {
          const theme = THEME_CN[highlightOpp.theme] || highlightOpp.theme
          const type = TYPE_CN[highlightOpp.type] || highlightOpp.type
          const title = (highlightOpp.title || '').slice(0, 50)
          insight += ` 其中值得关注的是「${title}」(${type}，评分 ${highlightOpp.avg_score})`
          if (highlightOpp.appearances > 1) insight += `，已累计出现 ${highlightOpp.appearances} 次`
          insight += '。'
        }
        lines.push(`🔍 ${insight}`)
      }

      // ── 高价值信号 ──
      const topSignals = signals
        .filter((s: any) => (s.score || 0) >= 6)
        .slice(0, 4)
      if (topSignals.length > 0) {
        lines.push(`━━━ 🔥 值得关注的信号 ━━━`)
        for (const s of topSignals) {
          const title = (s.problem || '').slice(0, 70)
          const theme = THEME_CN[s.theme] || s.theme || ''
          const tag = theme ? `[${theme}]` : ''
          lines.push(`  ${tag} ${title}`)
          const detail: string[] = []
          if (s.score) detail.push(`评分 ${s.score}`)
          if (s.source) detail.push(`来源 ${s.source}`)
          if (s.classification && s.classification !== 'feature_request') {
            detail.push(TYPE_CN[s.classification] || s.classification)
          }
          if (s.report_date) detail.push(s.report_date)
          if (detail.length) lines.push(`    ${detail.join(' | ')}`)
        }
      }

      // ── 机会榜 ──
      const topOpps = [...opps]
        .sort((a: any, b: any) => (b.avg_score || 0) - (a.avg_score || 0))
        .slice(0, 4)
      if (topOpps.length > 0) {
        lines.push(`━━━ 💡 机会榜 ━━━`)
        for (const o of topOpps) {
          const title = (o.title || '').slice(0, 60)
          const theme = THEME_CN[o.theme] || o.theme || ''
          const type = TYPE_CN[o.type] || o.type || ''
          lines.push(`  [${theme}] ${title}`)
          const detail: string[] = [`${type}`]
          if (o.avg_score) detail.push(`评分 ${o.avg_score}`)
          if (o.appearances > 1) detail.push(`${o.appearances} 次出现`)
          if (o.consecutive_days) detail.push(`连续 ${o.consecutive_days} 天`)
          lines.push(`    ${detail.join(' · ')}`)
        }
      }

      // ── 底部操作提示 ──
      lines.push(`━━━━━━━━━━━━━━━━━━━━`)
      lines.push(`⏰ ${new Date().toLocaleString('zh-CN', { hour12: false })}`)
      lines.push(`💬 发送 /radar 查看详情`)

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
