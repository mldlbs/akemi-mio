/**
 * PlanStartupRadarPlugin — 创业雷达 Telegram Bot 渐进式引入 插件
 *
 * 在 UserBehavior 上渐进引入「Plan:创业雷达 Telegram Bot 开发」的能力，
 * 以插件形式注入，不改造 UserBehavior 核心。
 *
 * 渐进式引入计划（与 Plan:实验42 对齐）：
 * - Phase 1 (当前): 旁路输出不做决策 (passive_monitor)
 *   → 订阅雷达扫描结果，记录观察日志，不修改任何决策
 * - Phase 2: 作为建议源影响部分决策 (suggestion_source)
 *   → 在 Evolution 前后注入雷达上下文，影响管道参数建议
 * - Phase 3: 替换 UserBehavior 核心模块 (core_replacement)
 *   → 雷达数据成为演化优先级的主要输入
 *
 * 注入方式：
 * - 作为 UserBehaviorLayer 的钩子注册
 * - 依赖 StartupRadarAdapter 获取扫描信号
 * - 不修改任何现有决策逻辑
 */
import { log } from '../../logger/Logger'
import { startupRadarAdapter } from '../../startup-radar/PlanStartupRadarAdapter'
import type { RadarScanResult } from '../../startup-radar/types'
import type { UserBehaviorFeature } from '../types'
import type {
  PreProcessContext,
  PostProcessContext,
  PostProcessResult,
} from '../types'
import {
  type StartupRadarPhase,
  type PlanStartupRadarConfig,
  type RadarScanObservation,
  type BehaviorRadarCorrelation,
  type StartupRadarReport,
  DEFAULT_STARTUP_RADAR_CONFIG,
} from './types'

// =============================================================================
// 常量
// =============================================================================

/** 日志标签 */
const LOG_TAG = 'plan_startup_radar'

/** 事件订阅清理函数类型 */
type DisposeFn = () => void

// =============================================================================
// PlanStartupRadarPlugin
// =============================================================================

export class PlanStartupRadarPlugin {
  // ==================== 配置 ====================
  private config: PlanStartupRadarConfig

  // ==================== 观察缓存 ====================
  private scanObservations: RadarScanObservation[] = []
  private correlations: BehaviorRadarCorrelation[] = []

  // ==================== 内部状态跟踪 ====================
  private startTime = Date.now()
  private lastScanResult: RadarScanResult | null = null

  // ==================== 事件订阅 ====================
  private disposables: DisposeFn[] = []

  // ==================== 统计 ====================
  private totalSignalCount = 0

  constructor(config?: Partial<PlanStartupRadarConfig>) {
    this.config = { ...DEFAULT_STARTUP_RADAR_CONFIG, ...config }
  }

  // ==================== 生命周期 ====================

  /**
   * 从 UserBehavior 的 feature flags 自动推导引入阶段。
   * 由注入方（UserBehaviorLayer）在 setStartupRadarPlugin 时调用。
   */
  autoDetectPhase(features: ReadonlySet<UserBehaviorFeature>): void {
    if (features.has('plan_startup_radar_replacement')) {
      this.config.phase = 'core_replacement'
    } else if (features.has('plan_startup_radar_suggestion')) {
      this.config.phase = 'suggestion_source'
    } else if (features.has('plan_startup_radar_passive')) {
      this.config.phase = 'passive_monitor'
    }
    // 没有匹配 flag 则保留默认值
  }

  /** 更新配置 */
  updateConfig(patch: Partial<PlanStartupRadarConfig>): void {
    this.config = { ...this.config, ...patch }
    log('INFO', `${LOG_TAG}_config_updated`, {
      phase: this.config.phase,
      debug: this.config.debug,
    })
  }

  /** 获取当前阶段 */
  getPhase(): StartupRadarPhase {
    return this.config.phase
  }

  /** 获取当前配置 */
  getConfig(): PlanStartupRadarConfig {
    return { ...this.config }
  }

  /**
   * 启动插件：订阅创业雷达扫描结果并开始观察
   *
   * Phase 1: 仅观察和日志，不做任何决策影响
   */
  start(): void {
    if (this.disposables.length > 0) {
      log('WARN', `${LOG_TAG}_already_started`)
      return
    }

    this.startTime = Date.now()

    // 订阅雷达扫描结果（来自 StartupRadarAdapter）
    this.disposables.push(
      startupRadarAdapter.onSignalsReady((result: RadarScanResult) => {
        this.onRadarScanResult(result)
      }),
    )

    log('INFO', `${LOG_TAG}_started`, {
      phase: this.config.phase,
      debug: this.config.debug,
    })
  }

  /** 停止插件：清理事件订阅和缓存 */
  stop(): void {
    for (const dispose of this.disposables) {
      try {
        dispose()
      } catch {
        // 静默清理
      }
    }
    this.disposables = []
    this.lastScanResult = null

    log('INFO', `${LOG_TAG}_stopped`, {
      observations: {
        scans: this.scanObservations.length,
        correlations: this.correlations.length,
      },
    })
  }

  /** 重置观察缓存（保留配置和订阅） */
  resetObservations(): void {
    this.scanObservations = []
    this.correlations = []
    this.totalSignalCount = 0
    log('INFO', `${LOG_TAG}_observations_reset`)
  }

  // ==================== UserBehaviorLayer 钩子 ====================

  /**
   * 预处理钩子 — 在 Evolution 管道执行前调用
   *
   * Phase 1 行为：记录当前雷达扫描状态，仅做旁路日志输出
   * Phase 2 行为：在 ctx 上附加雷达信号上下文，供管道消费
   */
  onPreProcess(ctx: PreProcessContext): PreProcessContext {
    if (this.config.phase !== 'passive_monitor' && this.config.phase !== 'suggestion_source') {
      return ctx
    }

    try {
      const snapshot = this.lastScanResult
      if (!snapshot || snapshot.totalSignals === 0) return ctx

      const signalSummary = `雷达: ${snapshot.totalSignals} 条信号 (🔥${snapshot.urgentCount} 紧急, 热度 ${(snapshot.compositeHeatIndex * 100).toFixed(0)}%)`

      // Phase 1: 仅输出旁路日志，不修改 ctx
      log('INFO', `${LOG_TAG}_pre_process_passive`, {
        phase: this.config.phase,
        signalSummary,
        topSignals: snapshot.signals.slice(0, 3).map((s) => `${s.category}:${s.title.slice(0, 40)}`),
      })

      if (this.config.debug) {
        log('DEBUG', `${LOG_TAG}_pre_ctx_detail`, {
          scanTimestamp: snapshot.timestamp,
          sourceDistribution: snapshot.sourceDistribution,
          categoryDistribution: snapshot.categoryDistribution,
        })
      }

      // Phase 2: 在 ctx 上附加雷达信号数据（供后续决策消费）
      if (this.config.phase === 'suggestion_source') {
        const enrichedCtx = ctx as Record<string, unknown>
        enrichedCtx._startupRadarSignals = snapshot.signals.slice(0, this.config.maxSignalsInReport)
        enrichedCtx._startupRadarHeatIndex = snapshot.compositeHeatIndex

        log('INFO', `${LOG_TAG}_pre_process_suggestion`, {
          injectedSignals: Math.min(snapshot.totalSignals, this.config.maxSignalsInReport),
          heatIndex: snapshot.compositeHeatIndex,
        })
      }
    } catch (err: any) {
      log('WARN', `${LOG_TAG}_pre_process_error`, { error: err.message })
    }

    return ctx
  }

  /**
   * 后处理钩子 — 在 Evolution 管道执行后调用
   *
   * Phase 1 行为：记录执行结果与雷达信号的关联分析，仅做旁路日志输出
   * Phase 2 行为：在 PostProcessResult 中附加雷达增强摘要
   */
  onPostProcess(ctx: PostProcessContext): PostProcessResult {
    if (this.config.phase !== 'passive_monitor' && this.config.phase !== 'suggestion_source') {
      return { enhancedSummary: undefined }
    }

    try {
      const snapshot = this.lastScanResult
      if (!snapshot || snapshot.totalSignals === 0) return { enhancedSummary: undefined }

      // Phase 1: 仅日志，不修改结果
      log('INFO', `${LOG_TAG}_post_process_passive`, {
        phase: this.config.phase,
        totalSignals: snapshot.totalSignals,
        urgentCount: snapshot.urgentCount,
        compositeHeatIndex: snapshot.compositeHeatIndex,
        success: ctx.success,
        durationMs: ctx.durationMs,
      })

      if (this.config.debug) {
        log('DEBUG', `${LOG_TAG}_post_ctx_detail`, {
          hasMetrics: !!ctx.rawMetrics,
          rawSummaryLen: ctx.rawSummary.length,
          categoryDistribution: snapshot.categoryDistribution,
        })
      }

      // Phase 2: 附加雷达增强的摘要建议
      if (this.config.phase === 'suggestion_source') {
        const radarSummary = this.buildRadarSummary(snapshot)
        if (radarSummary) {
          return {
            enhancedSummary: ctx.rawSummary
              ? `${ctx.rawSummary}\n\n---\n${radarSummary}`
              : radarSummary,
            extraData: {
              startupRadar: {
                totalSignals: snapshot.totalSignals,
                urgentCount: snapshot.urgentCount,
                compositeHeatIndex: snapshot.compositeHeatIndex,
                topCategories: Object.entries(snapshot.categoryDistribution)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 3)
                  .map(([cat]) => cat),
              },
            },
            messages: snapshot.urgentCount > 0
              ? [`📡 创业雷达: ${snapshot.totalSignals} 条新信号 (${snapshot.urgentCount} 条紧急)`]
              : [`📡 创业雷达: ${snapshot.totalSignals} 条新信号`],
          }
        }
      }

      return { enhancedSummary: undefined }
    } catch (err: any) {
      log('WARN', `${LOG_TAG}_post_process_error`, { error: err.message })
      return { enhancedSummary: undefined }
    }
  }

  // ==================== 事件处理 ====================

  /**
   * 处理雷达扫描完成事件
   *
   * 记录扫描结果，更新统计缓存，生成观察记录
   */
  private onRadarScanResult(result: RadarScanResult): void {
    this.lastScanResult = result
    this.totalSignalCount += result.totalSignals

    const observation: RadarScanObservation = {
      timestamp: Date.now(),
      signalCount: result.totalSignals,
      hotCount: result.signals.filter((s) => s.urgency === 'hot').length,
      warmCount: result.signals.filter((s) => s.urgency === 'warm').length,
      compositeHeatIndex: result.compositeHeatIndex,
      sourceDistribution: result.sourceDistribution,
      categoryDistribution: result.categoryDistribution,
      topSignalTitle: result.signals[0]?.title ?? null,
      topSignalScore: result.signals[0]?.compositeScore ?? null,
    }

    this.scanObservations.push(observation)
    this.trimCache(this.scanObservations)

    // Phase 1: 仅日志
    if (this.config.phase === 'passive_monitor') {
      log('INFO', `${LOG_TAG}_scan_observed`, {
        signalCount: result.totalSignals,
        urgentCount: result.urgentCount,
        heatIndex: result.compositeHeatIndex.toFixed(3),
        topCategory: Object.entries(result.categoryDistribution)
          .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown',
      })
    }

    if (this.config.debug) {
      log('DEBUG', `${LOG_TAG}_scan_detail`, {
        sources: Object.keys(result.sourceDistribution),
        categories: Object.keys(result.categoryDistribution),
        topSignal: result.signals[0]
          ? `${result.signals[0].category}:${result.signals[0].title.slice(0, 60)}`
          : 'none',
      })
    }
  }

  // ==================== 报告生成 ====================

  /**
   * 生成实验报告
   *
   * 包含当前阶段的所有观察记录和统计数据
   */
  generateReport(): StartupRadarReport {
    const allTs = this.scanObservations.map((o) => o.timestamp)
    const collectionWindow: StartupRadarReport['collectionWindow'] =
      allTs.length > 0
        ? { from: Math.min(...allTs), to: Math.max(...allTs) }
        : { from: this.startTime, to: Date.now() }

    // 构建摘要文本
    const summaryLines: string[] = [
      `【创业雷达】UserBehavior 渐进式引入 Phase ${this.config.phase === 'passive_monitor' ? '1' : this.config.phase === 'suggestion_source' ? '2' : '3'} 报告`,
      ``,
      `采集窗口: ${new Date(collectionWindow.from).toISOString()} ~ ${new Date(collectionWindow.to).toISOString()}`,
      `运行时长: ${Math.round((Date.now() - this.startTime) / 60000)} 分钟`,
      ``,
      `📊 观察统计:`,
      `  - 雷达扫描: ${this.scanObservations.length} 次`,
      `  - 累计信号: ${this.totalSignalCount} 条`,
      `  - 行为关联: ${this.correlations.length} 次`,
      ``,
    ]

    if (this.scanObservations.length > 0) {
      const avgSignals = this.scanObservations.reduce((s, o) => s + o.signalCount, 0) / this.scanObservations.length
      const avgHeat =
        this.scanObservations.reduce((s, o) => s + o.compositeHeatIndex, 0) / this.scanObservations.length

      summaryLines.push(`📈 信号统计:`,
        `  - 平均每轮信号数: ${avgSignals.toFixed(1)}`,
        `  - 平均热度: ${(avgHeat * 100).toFixed(0)}%`,
        `  - 总紧急信号: ${this.scanObservations.reduce((s, o) => s + o.hotCount, 0)}`,
      )
      summaryLines.push(``)

      // 来源分布汇总
      const sourceAgg: Record<string, number> = {}
      for (const obs of this.scanObservations) {
        for (const [src, cnt] of Object.entries(obs.sourceDistribution)) {
          sourceAgg[src] = (sourceAgg[src] ?? 0) + cnt
        }
      }
      const topSources = Object.entries(sourceAgg).sort((a, b) => b[1] - a[1]).slice(0, 5)
      if (topSources.length > 0) {
        summaryLines.push(`🌐 来源分布:`,
          ...topSources.map(([src, cnt]) => `  - ${src}: ${cnt} 条`),
        )
      }
    }

    return {
      phase: this.config.phase,
      totalScans: this.scanObservations.length,
      scanObservations: [...this.scanObservations],
      correlations: [...this.correlations],
      collectionWindow,
      generatedAt: Date.now(),
      summary: summaryLines.join('\n'),
    }
  }

  /**
   * 获取 Plan 决策差异率（当前阶段统计）
   */
  getAvgHeatIndex(): number {
    if (this.scanObservations.length === 0) return 0
    return this.scanObservations.reduce((s, o) => s + o.compositeHeatIndex, 0) / this.scanObservations.length
  }

  // ==================== 内部工具 ====================

  /**
   * 从雷达扫描结果构建增强摘要。
   * 在 Phase 2 时追加到 PostProcessResult.enhancedSummary。
   */
  private buildRadarSummary(result: RadarScanResult): string | null {
    if (result.totalSignals === 0) return null

    const lines: string[] = ['📡 **创业雷达信号摘要**']

    // 紧急信号
    const hotSignals = result.signals.filter((s) => s.urgency === 'hot')
    if (hotSignals.length > 0) {
      lines.push('')
      lines.push(`🔥 紧急信号 (${hotSignals.length}):`)
      for (const s of hotSignals.slice(0, 3)) {
        lines.push(`  · ${s.title.slice(0, 60)}`)
      }
    }

    // 关注信号
    const warmSignals = result.signals.filter((s) => s.urgency === 'warm')
    if (warmSignals.length > 0 && hotSignals.length < 3) {
      const warmCount = Math.min(warmSignals.length, 3 - hotSignals.length)
      if (warmCount > 0) {
        lines.push('')
        lines.push(`⚡ 关注信号 (${warmCount}):`)
        for (const s of warmSignals.slice(0, warmCount)) {
          lines.push(`  · ${s.title.slice(0, 60)}`)
        }
      }
    }

    // 类别分布
    const cats = Object.entries(result.categoryDistribution)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
    if (cats.length > 0) {
      lines.push('')
      const catLabels: Record<string, string> = {
        market_trend: '市场趋势',
        competitor: '竞品动态',
        funding: '投融资',
        technology: '技术突破',
        policy: '政策法规',
        talent: '人才流动',
        consumer_demand: '消费需求',
      }
      lines.push(`📂 热点类别: ${cats.map(([c, n]) => `${catLabels[c] ?? c}=${n}`).join(', ')}`)
    }

    return lines.join('\n')
  }

  /**
   * 裁剪观察缓存，防止内存泄漏
   */
  private trimCache<T>(arr: T[]): void {
    if (arr.length > this.config.observationWindowSize) {
      arr.splice(0, arr.length - this.config.observationWindowSize)
    }
  }
}
