/**
 * RadarMemorySidecarPlugin — 创业雷达附图于 Memory 的边车插件
 *
 * ── 功能 ──
 *
 * 实现 ISidecarPlugin 接口，在 Memory 的请求管道中插入雷达特定的处理逻辑：
 *
 * 1. 监控层 — 监控 Memory 中与雷达相关的条目操作
 * 2. 缓存层 — 缓存雷达扫描信号数据（利用 MemorySidecar 的通用缓存）
 * 3. 过滤层 — 通过 RadarFeedbackService 的负面反馈跳过低质量源
 * 4. 转换层 — 转换记忆条目为雷达信号上下文格式
 *
 * ── 注册方式 ──
 *
 * 在 AppRuntime 中通过 MemorySidecar.registerPlugin() 注册：
 *
 *   import { RadarMemorySidecarPlugin } from '../startup-radar/RadarMemorySidecarPlugin'
 *   memorySidecar.registerPlugin(new RadarMemorySidecarPlugin({ radarFeedbackService }))
 *
 * ── 设计原则 ──
 *
 * 1. 无状态 — 不持有 Memory 状态，通过插件接口获取
 * 2. 薄层 — 仅做横切关注点，不重复 Memory 主逻辑
 * 3. 可移除 — 移除注册即可恢复纯 Memory 行为
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { startupRadarAdapter } from '@akemi-mio/intelligence-startup-radar/PlanStartupRadarAdapter'
import type { ISidecarPlugin, AddEntryContext, AddEntryResult, GetEntriesResult, GetFormattedContextResult } from '@akemi-mio/intelligence-memory/sidecar/types'
import type { MemoryEntry } from '@akemi-mio/intelligence-memory/types'

// ══════════════════════════════════════════
//  雷达反馈源的 Memory 条目前缀
// ══════════════════════════════════════════

const RADAR_FEEDBACK_PREFIX = '[radar_feedback:'
const RADAR_SCAN_PREFIX = '[radar_scan]'
const RADAR_SIGNAL_PREFIX = '📡'

// ══════════════════════════════════════════
//  配置
// ══════════════════════════════════════════

export interface RadarMemorySidecarPluginConfig {
  /** 是否启用调试日志 */
  debug?: boolean
}

const DEFAULT_CONFIG: Required<RadarMemorySidecarPluginConfig> = {
  debug: false,
}

// ══════════════════════════════════════════
//  RadarMemorySidecarPlugin
// ══════════════════════════════════════════

export class RadarMemorySidecarPlugin implements ISidecarPlugin {
  readonly name = 'radar-memory-sidecar'
  private config: Required<RadarMemorySidecarPluginConfig>

  /** 最近扫描的雷达信号摘要缓存（用于上下文注入） */
  private lastRadarContext: string | null = null
  private lastRadarContextTimestamp = 0
  private readonly RADAR_CONTEXT_TTL_MS = 5 * 60 * 1000 // 5 分钟

  constructor(config?: RadarMemorySidecarPluginConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.setupRadarSubscription()
  }

  /**
   * 订阅 StartupRadarAdapter 的扫描结果，
   * 缓存最近的雷达信号摘要用于后续上下文注入。
   */
  private setupRadarSubscription(): void {
    try {
      startupRadarAdapter.onSignalsReady((result) => {
        if (!result || result.totalSignals === 0) {
          this.lastRadarContext = null
          return
        }

        // 构建雷达信号摘要
        const lines: string[] = [
          '【创业雷达信号摘要】',
          `  共 ${result.totalSignals} 条信号（紧急 ${result.urgentCount} 条，热度 ${(result.compositeHeatIndex * 100).toFixed(0)}%）`,
        ]

        // 添加最高评分信号
        for (const signal of result.signals.slice(0, 3)) {
          const urgencyEmoji = signal.urgency === 'hot' ? '🔥' : signal.urgency === 'warm' ? '⚡' : '💤'
          lines.push(`  ${urgencyEmoji} [${signal.category}] ${signal.title.slice(0, 60)}`)
        }

        this.lastRadarContext = lines.join('\n')
        this.lastRadarContextTimestamp = Date.now()

        if (this.config.debug) {
          log('DEBUG', 'radar_sidecar_context_cached', {
            signals: result.totalSignals,
            urgent: result.urgentCount,
          })
        }
      })
    } catch {
      // StartupRadarAdapter 可能尚未初始化，静默处理
    }
  }

  // ══════════════════════════════════════════
  //  ISidecarPlugin 实现
  // ══════════════════════════════════════════

  /**
   * 预处理 addEntry — 过滤雷达反馈条目中的噪音。
   *
   * 过滤规则：
   * - 如果条目内容是雷达反馈且 confidence < 0.5，阻止写入 Memory
   * - 如果条目是雷达扫描日志且内容过短（< 20 字符），阻止写入
   */
  preAddEntry(ctx: AddEntryContext): AddEntryResult {
    // 低置信度的雷达反馈 → 过滤
    if (ctx.type === 'user_fact' && ctx.content.startsWith(RADAR_FEEDBACK_PREFIX) && ctx.confidence < 0.5) {
      this.logFilter('radar_feedback_low_confidence', ctx.content)
      return { proceed: false }
    }

    // 过短的雷达扫描日志 → 过滤
    if (ctx.content.startsWith(RADAR_SCAN_PREFIX) && ctx.content.length < 20) {
      this.logFilter('radar_scan_too_short', ctx.content)
      return { proceed: false }
    }

    return { proceed: true }
  }

  /**
   * 后处理 getEntries — 过滤和转换 Memory 条目。
   *
   * 1. 过滤掉正面反馈率低的雷达源条目
   * 2. 标记雷达信号条目以便识别
   */
  postGetEntries(entries: MemoryEntry[]): MemoryEntry[] {
    if (entries.length === 0) return entries

    // 只对 user_fact 类型的条目做过滤
    const radarFeedbackEntries = entries.filter((e) => e.type === 'user_fact' && e.content.startsWith(RADAR_FEEDBACK_PREFIX))

    if (radarFeedbackEntries.length === 0) return entries

    // 统计各源的负面反馈计数
    const sourceNegativeCount = new Map<string, number>()
    const sourceTotalCount = new Map<string, number>()

    for (const e of radarFeedbackEntries) {
      const source = this.extractSourceFromRadarEntry(e.content)
      if (!source) continue

      sourceTotalCount.set(source, (sourceTotalCount.get(source) || 0) + 1)

      // 负面反馈类型：error, outdated, irrelevant
      const isNegative = /feedback:(error|outdated|irrelevant)/.test(e.content)
      if (isNegative) {
        sourceNegativeCount.set(source, (sourceNegativeCount.get(source) || 0) + 1)
      }
    }

    // 找出负面比例超过 30% 的源
    const skipSources = new Set<string>()
    for (const [source, total] of sourceTotalCount) {
      const negative = sourceNegativeCount.get(source) || 0
      if (total > 0 && negative / total >= 0.3) {
        skipSources.add(source)
      }
    }

    if (skipSources.size === 0) return entries

    // 过滤掉被跳过源的反馈条目
    const filtered = entries.filter((e) => {
      if (e.type !== 'user_fact' || !e.content.startsWith(RADAR_FEEDBACK_PREFIX)) return true
      const source = this.extractSourceFromRadarEntry(e.content)
      return !source || !skipSources.has(source)
    })

    if (filtered.length !== entries.length && this.config.debug) {
      log('DEBUG', 'radar_sidecar_filtered_entries', {
        before: entries.length,
        after: filtered.length,
        skippedSources: [...skipSources],
      })
    }

    return filtered
  }

  /**
   * 预处理 getFormattedContext — 注入雷达信号上下文。
   *
   * 如果 StartupRadarAdapter 有缓存的扫描结果，注入到 Memory 上下文中。
   */
  preGetFormattedContext(): GetFormattedContextResult {
    // 检查雷达上下文是否仍然有效
    if (this.lastRadarContext && Date.now() - this.lastRadarContextTimestamp < this.RADAR_CONTEXT_TTL_MS) {
      // 不拦截（proceed=true），让 Memory 主逻辑继续执行
      // 雷达上下文通过 postGetFormattedContext 追加
      return { proceed: true }
    }

    return { proceed: true }
  }

  /**
   * 后处理 getFormattedContext — 追加雷达信号上下文到末尾。
   */
  postGetFormattedContext(context: string): string {
    if (!this.lastRadarContext) return context

    // 检查雷达上下文是否仍然有效
    if (Date.now() - this.lastRadarContextTimestamp > this.RADAR_CONTEXT_TTL_MS) {
      return context
    }

    // 追加雷达信号摘要到上下文的最后
    return context ? `${context}\n\n${this.lastRadarContext}` : this.lastRadarContext
  }

  /**
   * 后处理 addFact — 监控雷达相关的事实添加。
   */
  postAddFact(content: string, _confidence: number): void {
    // 记录雷达反馈的添加
    if (content.startsWith(RADAR_FEEDBACK_PREFIX)) {
      log('INFO', 'radar_sidecar_feedback_recorded', {
        preview: content.slice(0, 80),
      })
    }
  }

  // ══════════════════════════════════════════
  //  内部方法
  // ══════════════════════════════════════════

  /**
   * 从雷达反馈条目内容中提取来源名称。
   * 格式: [radar_feedback:hackernews] 反馈:error — ...
   */
  private extractSourceFromRadarEntry(content: string): string | null {
    const match = content.match(/^\[radar_feedback:([^\]]+)\]/)
    return match ? match[1] : null
  }

  private logFilter(reason: string, content: string): void {
    if (this.config.debug) {
      log('DEBUG', 'radar_sidecar_filtered', {
        reason,
        preview: content.slice(0, 60),
      })
    }
  }

  /** 手动更新雷达上下文（供外部调用） */
  setRadarContext(context: string | null): void {
    this.lastRadarContext = context
    this.lastRadarContextTimestamp = context ? Date.now() : 0
  }
}
