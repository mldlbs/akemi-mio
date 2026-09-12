/**
 * UserBehaviorLayer — Evolution 上层增强层
 *
 * 职责：
 * - 以装饰器模式包裹 SelfEvolutionService，不侵入其核心逻辑
 * - 在 Evolution 执行前后插入预处理/后处理钩子
 * - 通过 feature flag 控制各增强特性的启用/禁用
 * - 提供默认的增强行为实现
 *
 * 架构：
 *   UserBehaviorLayer
 *     ├── wraps SelfEvolutionService (decorator)
 *     ├── preProcess()  — 调用前预处理（可修改上下文/调整管道参数）
 *     ├── postProcess() — 调用后后处理（可增强报告/丰富指标）
 *     └── feature flags → 控制哪些钩子生效
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { SelfEvolutionService } from '@akemi-mio/evolution/SelfEvolutionService'
import type { PipelineMetrics } from '@akemi-mio/evolution/automation'
import type {
  UserBehaviorFeature,
  UserBehaviorFeatureMap,
  PreProcessContext,
  PostProcessContext,
  PostProcessResult,
  PreProcessHook,
  PostProcessHook,
  UserBehaviorConfig,
} from './types'
import { parseFeaturesFromEnv } from './types'
import { behaviorFeatureExtractor } from './BehaviorFeatureExtractor'
import { behaviorHeatmapService } from './BehaviorHeatmapService'
import { qualityMetricsTracker } from './QualityMetricsTracker'
import type { ModuleHeatmap, DegradationSignal } from './types'
import type { PlanExperiment42Plugin } from '@akemi-mio/evolution-plan-experiment'

const DEFAULT_CONFIG: Partial<UserBehaviorConfig> = {
  debug: false,
}

export class UserBehaviorLayer {
  /** 被包裹的 Evolution 实例 */
  readonly inner: SelfEvolutionService

  /** 启用的 feature 集合 */
  private features: UserBehaviorFeatureMap

  /** 配置 */
  private config: Required<Pick<UserBehaviorConfig, 'debug'>>

  /** 注册的预处理钩子（按注册顺序执行） */
  private preHooks: PreProcessHook[] = []

  /** 注册的后处理钩子（按注册顺序执行） */
  private postHooks: PostProcessHook[] = []

  /** Plan:实验42 插件（可选注入） */
  private experimentPlugin: PlanExperiment42Plugin | null = null

  /** 上一次后处理结果缓存（用于外部读取） */
  private lastPostResult: PostProcessResult | null = null

  constructor(inner: SelfEvolutionService, config?: UserBehaviorConfig) {
    this.inner = inner
    this.features = new Set(config?.features ?? parseFeaturesFromEnv())
    this.config = {
      debug: config?.debug ?? DEFAULT_CONFIG.debug ?? false,
    }

    if (config?.preHooks) this.preHooks.push(...config.preHooks)
    if (config?.postHooks) this.postHooks.push(...config.postHooks)

    if (this.features.size > 0) {
      log('INFO', 'user_behavior_active', {
        features: Array.from(this.features),
        preHooks: this.preHooks.length,
        postHooks: this.postHooks.length,
      })
    }
  }

  // ==================== Feature 查询 ====================

  /** 检查指定特性是否启用 */
  hasFeature(feature: UserBehaviorFeature): boolean {
    return this.features.has(feature)
  }

  /** 获取当前启用的特性列表 */
  getActiveFeatures(): UserBehaviorFeature[] {
    return Array.from(this.features)
  }

  /** 获取最后的后处理结果 */
  getLastPostProcessResult(): PostProcessResult | null {
    return this.lastPostResult
  }

  /** 检查是否有实验42相关的 feature flag 启用 */
  private hasAnyExperimentFlag(): boolean {
    return (
      this.features.has('plan_experiment_42_passive') ||
      this.features.has('plan_experiment_42_suggestion') ||
      this.features.has('plan_experiment_42_replacement')
    )
  }

  // ==================== 钩子注册 ====================

  /** 注册预处理钩子 */
  addPreHook(hook: PreProcessHook): void {
    this.preHooks.push(hook)
    log('INFO', 'user_behavior_pre_hook_added', { total: this.preHooks.length })
  }

  /** 注册后处理钩子 */
  addPostHook(hook: PostProcessHook): void {
    this.postHooks.push(hook)
    log('INFO', 'user_behavior_post_hook_added', { total: this.postHooks.length })
  }

  /** 注入 Plan:实验42 插件 */
  setExperimentPlugin(plugin: PlanExperiment42Plugin): void {
    this.experimentPlugin = plugin
    // 自动从当前 feature flags 推导实验阶段
    plugin.autoDetectPhase(this.features)
    log('INFO', 'user_behavior_exp42_plugin_attached', {
      phase: plugin.getPhase(),
      enabledFlag: Array.from(this.features).find((f) => f.startsWith('plan_experiment_42')),
    })
  }

  // ==================== 预处理 ====================

  /**
   * 在 Evolution 执行前调用。
   * 返回增强后的上下文（可被后续 hook 消费）。
   */
  async preProcess(ctx: PreProcessContext): Promise<PreProcessContext> {
    if (this.features.size === 0) return ctx

    let current = ctx
    for (const hook of this.preHooks) {
      try {
        current = await hook(current)
      } catch (err: any) {
        log('WARN', 'user_behavior_pre_hook_error', {
          error: err.message,
        })
        // 单个 hook 失败不阻断整体流程
      }
    }

    // ★ Plan:实验42 预处理钩子 — 旁路输出不做决策
    // TODO Phase 2/3: 合并 plugin 返回的增强上下文到 current
    if (this.experimentPlugin && this.hasAnyExperimentFlag()) {
      try {
        this.experimentPlugin.onPreProcess(current)
      } catch (err: any) {
        log('WARN', 'user_behavior_exp42_pre_error', { error: err.message })
      }
    }

    if (this.config.debug) {
      log('DEBUG', 'user_behavior_pre_process_done', {
        userActive: current.userActive,
        failures: current.consecutiveFailures,
      })
    }

    return current
  }

  // ==================== 后处理 ====================

  /**
   * 在 Evolution 执行后调用。
   * 返回增强后的结果。
   */
  async postProcess(ctx: PostProcessContext): Promise<PostProcessResult> {
    if (this.features.size === 0) {
      const empty: PostProcessResult = {}
      this.lastPostResult = empty
      return empty
    }

    let result: PostProcessResult = {}
    for (const hook of this.postHooks) {
      try {
        const partial = await hook(ctx)
        result = this.mergePostResults(result, partial)
      } catch (err: any) {
        log('WARN', 'user_behavior_post_hook_error', {
          error: err.message,
        })
      }
    }

    // ★ Plan:实验42 后处理钩子 — Phase 1 旁路输出不做决策
    // TODO Phase 2/3: 将 plugin 返回的 PostProcessResult 合并到 result 中
    if (this.experimentPlugin && this.hasAnyExperimentFlag()) {
      try {
        const pluginResult = this.experimentPlugin.onPostProcess(ctx)
        // Phase 1: 插件返回空 result，合并无副作用；Phase 2/3 时此处生效
        result = this.mergePostResults(result, pluginResult)
      } catch (err: any) {
        log('WARN', 'user_behavior_exp42_post_error', { error: err.message })
      }
    }

    this.lastPostResult = result

    if (this.config.debug) {
      log('DEBUG', 'user_behavior_post_process_done', {
        hasEnhancedSummary: !!result.enhancedSummary,
        extraKeys: result.extraData ? Object.keys(result.extraData) : [],
      })
    }

    return result
  }

  private mergePostResults(base: PostProcessResult, incoming: PostProcessResult): PostProcessResult {
    return {
      enhancedSummary: incoming.enhancedSummary ?? base.enhancedSummary,
      extraData: { ...(base.extraData ?? {}), ...(incoming.extraData ?? {}) },
      messages: [...(base.messages ?? []), ...(incoming.messages ?? [])],
    }
  }

  // ==================== 默认钩子实现 ====================

  /**
   * 默认预处理钩子：摘要增强。
   * 在 Evolution 周期中添加行为上下文到摘要文本。
   */
  static createSummaryEnhancePreHook(): PreProcessHook {
    return async (ctx) => {
      // 目前仅透传上下文，不做修改
      // 子类/自定义钩子可以在 ctx 上附加 data 供后处理消费
      return ctx
    }
  }

  /**
   * 默认后处理钩子：摘要增强。
   * 在管道指标基础上附加行为上下文信息。
   */
  static createSummaryEnhancePostHook(): PostProcessHook {
    return async (ctx) => {
      if (!ctx.success || !ctx.rawSummary) return {}

      const { rawMetrics } = ctx
      if (!rawMetrics || rawMetrics.totalCollected === 0) return {}

      const lines: string[] = [ctx.rawSummary]

      // 附加行为上下文（如果预处理有数据）
      if (ctx.preProcessData?.userSessionInfo) {
        lines.push('')
        lines.push(`📊 用户行为上下文：${ctx.preProcessData.userSessionInfo}`)
      }

      return { enhancedSummary: lines.join('\n') }
    }
  }

  /**
   * 后处理钩子：指标丰富。
   * 在 PipelineMetrics 基础上附加行为视角的评估。
   */
  static createMetricsEnrichPostHook(): PostProcessHook {
    return async (ctx) => {
      if (!ctx.success || !ctx.rawMetrics) return {}

      const { rawMetrics } = ctx

      // 计算修复率 / 采集率等行为分析指标
      const fixRate = rawMetrics.totalCollected > 0 ? ((rawMetrics.totalFixed / rawMetrics.totalCollected) * 100).toFixed(1) : 'N/A'

      return {
        extraData: {
          behaviorAnalyzed: {
            fixRate: `${fixRate}%`,
            pendingCount: rawMetrics.queueSize,
            sessionEffectiveness: fixRate !== 'N/A' ? (parseFloat(fixRate) >= 50 ? 'good' : 'needs_attention') : 'unknown',
          },
        },
        messages: fixRate !== 'N/A' ? [`行为分析：修复率 ${fixRate}（${parseFloat(fixRate) >= 50 ? '✅ 良好' : '⚠️ 偏低'}）`] : [],
      }
    }
  }

  /**
   * 后处理钩子：动态管道参数调整建议。
   * 根据历史执行效果给出 maxFixesPerCycle 调整建议。
   */
  static createDynamicTuningPostHook(): PostProcessHook {
    return async (ctx) => {
      if (!ctx.success || !ctx.rawMetrics) return {}

      const { rawMetrics } = ctx
      if (rawMetrics.totalCollected === 0) return {}

      const failureRate = rawMetrics.totalCollected > 0 ? rawMetrics.totalFailed / rawMetrics.totalCollected : 0

      // 失败率过高 → 建议降低并发修复数
      if (failureRate > 0.5 && rawMetrics.queueSize > 5) {
        return {
          extraData: {
            tuningSuggestion: {
              action: 'reduce_concurrency',
              reason: `修复失败率 ${(failureRate * 100).toFixed(0)}%，建议降低 maxFixesPerCycle`,
              suggestedMaxFixes: Math.max(1, Math.floor(rawMetrics.totalCollected / 3)),
            },
          },
          messages: [`⚙️ 调优建议：失败率偏高（${(failureRate * 100).toFixed(0)}%），建议降低单次修复数量`],
        }
      }

      return {}
    }
  }

  // ==================== 行为驱动优化钩子 ====================

  /**
   * 预处理钩子：行为特征提取。
   * 在 Evolution 周期前分析用户行为，将特征数据注入预处理上下文。
   */
  static createBehaviorFeaturePreHook(): PreProcessHook {
    return async (ctx) => {
      try {
        const features = behaviorFeatureExtractor.extract(48)
        if (!features.hasSufficientData) return ctx

        const enrichedCtx: PreProcessContext & { behaviorFeatures?: Record<string, unknown> } = {
          ...ctx,
          behaviorFeatures: {
            sequenceCount: features.frequentSequences.length,
            pauseCount: features.pausePoints.length,
            suggestionCount: features.suggestions.length,
            totalToolCalls: features.totalToolCalls,
            topSequence: features.frequentSequences[0]?.tools.join(' → ') || '',
            topPause: features.pausePoints[0]?.tool || '',
          },
        }

        return enrichedCtx
      } catch {
        return ctx
      }
    }
  }

  // ==================== 模块热力图钩子 ====================

  /**
   * 预处理钩子：模块热力图生成。
   * 在 Evolution 周期前分析最近工具调用，生成模块级使用/错误热力图，
   * 注入预处理上下文供后续阶段消费。
   *
   * 热力图数据用于：
   * - 高频模块 → 进化优先级提升
   * - 高错误模块 → 进化修复候选人
   * - 低频模块 → 进化频率降低
   *
   * 依赖 feature flag: module_heatmap
   */
  static createHeatmapPreHook(): PreProcessHook {
    return async (ctx) => {
      try {
        const heatmap = behaviorHeatmapService.generate(48)

        if (!heatmap.hasSufficientData) return ctx

        log('INFO', 'user_behavior_heatmap_generated', {
          hotModules: heatmap.hotModules.length,
          errorModules: heatmap.errorModules.length,
          coldModules: heatmap.coldModules.length,
          totalCalls: heatmap.totalToolCalls,
        })

        // 通过扩展属性注入热力图数据（SelfEvolutionService 中通过 `as any` 读取）
        const enrichedCtx = ctx as any
        enrichedCtx.heatmap = heatmap
        enrichedCtx.heatmapSummary = behaviorHeatmapService.formatHeatmapSummary(heatmap)

        return enrichedCtx as typeof ctx
      } catch {
        return ctx
      }
    }
  }

  /**
   * 预处理钩子：冷模块降频标记。
   * 检查热力图中的低频模块，生成"跳过冷模块分析"标记，
   * 供 SelfEvolutionService 在管道执行前决策。
   *
   * 依赖 feature flag: cold_module_dampening
   */
  static createColdModuleDampeningPreHook(): PreProcessHook {
    return async (ctx) => {
      try {
        const enrichedCtx = ctx as any
        const heatmap: ModuleHeatmap | undefined = enrichedCtx.heatmap

        if (!heatmap || !heatmap.hasSufficientData) return ctx

        // 提取应降频的冷模块列表
        const coldModules = heatmap.coldModules.map((e) => e.module)
        if (coldModules.length === 0) return ctx

        log('INFO', 'user_behavior_cold_modules_detected', {
          coldModules,
          count: coldModules.length,
        })

        // 注入冷模块列表，供管道 Collector/Executor 跳过
        enrichedCtx.coldModules = coldModules
        enrichedCtx.shouldDampenColdModules = true

        return enrichedCtx as typeof ctx
      } catch {
        return ctx
      }
    }
  }

  /**
   * 后处理钩子：热力图增强报告。
   * 在 Evolution 周期后，如果热力图数据可用，附加热力图摘要。
   *
   * 依赖 feature flag: module_heatmap
   */
  static createHeatmapPostHook(): PostProcessHook {
    return async (ctx) => {
      try {
        const preData = ctx.preProcessData
        const heatmap: ModuleHeatmap | undefined = preData?.heatmap as any

        if (!heatmap || !heatmap.hasSufficientData) return {}

        const summary = behaviorHeatmapService.formatHeatmapSummary(heatmap)

        const enhancedSummary = ctx.rawSummary ? `${ctx.rawSummary}\n\n---\n${summary}` : summary

        return {
          enhancedSummary,
          extraData: {
            heatmapSnapshot: {
              hotModules: heatmap.hotModules.map((m) => m.module),
              errorModules: heatmap.errorModules.map((m) => ({ module: m.module, errors: m.errorCount })),
              coldModules: heatmap.coldModules.map((m) => m.module),
              totalCalls: heatmap.totalToolCalls,
            },
          },
          messages:
            heatmap.hotModules.length > 0
              ? [
                  `🔥 模块热力图：${heatmap.hotModules.length} 个高频模块，${heatmap.errorModules.length} 个高错误模块，${heatmap.coldModules.length} 个低频模块`,
                ]
              : [],
        }
      } catch {
        return {}
      }
    }
  }

  /**
   * 后处理钩子：热力图驱动优先级总结。
   * 在 Evolution 周期后，输出关于进化重点的简短建议。
   *
   * 依赖 feature flag: heatmap_driven_priority
   */
  static createHeatmapPriorityPostHook(): PostProcessHook {
    return async (ctx) => {
      try {
        const preData = ctx.preProcessData
        const heatmap: ModuleHeatmap | undefined = preData?.heatmap as any

        if (!heatmap || !heatmap.hasSufficientData) return {}

        const suggestions: string[] = []

        if (heatmap.hotModules.length > 0) {
          const top = heatmap.hotModules[0]
          suggestions.push(`本周期进化重点推荐：「${top.module}」模块（${top.usageCount} 次调用，${top.description}）`)
        }

        if (heatmap.errorModules.length > 0) {
          const worst = heatmap.errorModules[0]
          const rate = ((worst.errorCount / Math.max(worst.usageCount, 1)) * 100).toFixed(0)
          suggestions.push(`错误修复优先级：「${worst.module}」模块（错误率 ${rate}%）`)
        }

        if (suggestions.length === 0) return {}

        return {
          enhancedSummary: ctx.rawSummary ? `${ctx.rawSummary}\n\n📊 ${suggestions.join('；')}` : suggestions.join('；'),
          messages: suggestions,
        }
      } catch {
        return {}
      }
    }
  }
  /**
   * 在 Evolution 周期后附加行为分析结果。
   */
  static createBehaviorAnalysisPostHook(): PostProcessHook {
    return async (ctx) => {
      if (!ctx.success) return {}

      try {
        const features = behaviorFeatureExtractor.extract(48)
        if (!features.hasSufficientData) return {}

        const lines: string[] = []

        // 高频序列报告
        if (features.frequentSequences.length > 0) {
          const topSeq = features.frequentSequences.slice(0, 3)
          lines.push('📊 行为驱动优化分析：')
          lines.push('')
          lines.push('高频路径：')
          for (const seq of topSeq) {
            lines.push(`  · ${seq.tools.join(' → ')}（${seq.frequency} 次，${seq.optimizationHint}）`)
          }
        }

        // 停顿点报告
        if (features.pausePoints.length > 0) {
          lines.push('')
          lines.push('响应优化点：')
          for (const pp of features.pausePoints.slice(0, 3)) {
            lines.push(`  · ${pp.tool}：平均等待 ${(pp.avgWaitMs / 1000).toFixed(1)}s（${pp.frequency} 次）`)
          }
        }

        // 优化建议摘要
        if (features.suggestions.length > 0) {
          lines.push('')
          lines.push('优化建议：')
          for (const sug of features.suggestions.slice(0, 3)) {
            const tag =
              sug.type === 'preload_module'
                ? '📦'
                : sug.type === 'optimize_response'
                  ? '⚡'
                  : sug.type === 'add_cache'
                    ? '💾'
                    : sug.type === 'improve_error'
                      ? '🛡️'
                      : '🔧'
            lines.push(`  ${tag} ${sug.title}（${sug.expectedBenefit}）`)
          }
        }

        if (lines.length > 0) {
          const enhancedSummary = ctx.rawSummary ? `${ctx.rawSummary}\n\n---\n${lines.join('\n')}` : lines.join('\n')

          return {
            enhancedSummary,
            extraData: {
              behaviorAnalysis: {
                sequencesFound: features.frequentSequences.length,
                pausePointsFound: features.pausePoints.length,
                suggestionsGenerated: features.suggestions.length,
              },
            },
            messages: features.suggestions.length > 0 ? [`🧠 行为分析：发现 ${features.suggestions.length} 个优化机会`] : [],
          }
        }

        return {}
      } catch {
        return {}
      }
    }
  }

  // ===========================================================================
  // 质量指标追踪钩子
  // ===========================================================================

  /**
   * 预处理钩子：质量指标趋势注入。
   * 在 Evolution 周期开始前，读取最近的质量指标趋势数据，
   * 将降级信号注入预处理上下文，供后续分析消费。
   *
   * 依赖 feature flag: quality_metrics
   */
  static createQualityMetricsPreHook(): PreProcessHook {
    return async (ctx) => {
      try {
        const latest = qualityMetricsTracker.getLatestSnapshot()
        if (!latest) return ctx

        const enrichedCtx = ctx as any
        enrichedCtx.qualityMetrics = {
          healthScore: latest.healthScore,
          healthScoreDelta: latest.healthScoreDelta,
          isDegraded: latest.isDegraded,
          degradationSignals: latest.degradationSignals.map((s) => ({
            metric: s.metricName,
            severity: s.severity,
            description: s.description,
          })),
          metrics: latest.metrics.map((m) => ({
            name: m.name,
            value: m.value,
            trend: m.trend,
            degraded: m.degraded,
          })),
          totalToolCalls: latest.totalToolCalls,
          hasPersistentDowntrend: qualityMetricsTracker.hasPersistentDowntrend(3),
        }

        log('INFO', 'quality_metrics_pre_hook', {
          healthScore: latest.healthScore,
          degraded: latest.isDegraded,
          persistentDowntrend: qualityMetricsTracker.hasPersistentDowntrend(3),
          signals: latest.degradationSignals.length,
        })

        return enrichedCtx as typeof ctx
      } catch {
        return ctx
      }
    }
  }

  /**
   * 后处理钩子：质量指标快照记录。
   * 在 Evolution 周期结束后，记录新的质量指标快照，
   * 用于下一周期的趋势对比。
   *
   * 依赖 feature flag: quality_metrics
   */
  static createQualityMetricsPostHook(): PostProcessHook {
    return async (ctx) => {
      try {
        if (!ctx.success) return {}

        const snapshot = qualityMetricsTracker.recordSnapshot()
        const lines: string[] = []

        // 健康评分报告
        const healthEmoji = snapshot.healthScore >= 80 ? '🟢' : snapshot.healthScore >= 50 ? '🟡' : '🔴'
        lines.push(`${healthEmoji} 质量指标健康评分: ${snapshot.healthScore.toFixed(0)}/100`)

        if (snapshot.healthScoreDelta !== 0) {
          const arrow = snapshot.healthScoreDelta > 0 ? '↑' : '↓'
          lines.push(`   变化: ${arrow} ${Math.abs(snapshot.healthScoreDelta).toFixed(1)} 分`)
        }

        // 降级信号报告
        if (snapshot.isDegraded && snapshot.degradationSignals.length > 0) {
          lines.push('')
          lines.push('⚠️ 检测到质量降级信号：')
          for (const signal of snapshot.degradationSignals) {
            const changePct = Math.abs(Math.round(signal.delta * 100))
            lines.push(`  · ${signal.description}（${changePct}%）`)
            if (signal.relatedModules.length > 0) {
              lines.push(`    关联模块: ${signal.relatedModules.join(', ')}`)
            }
            lines.push(`    建议优化: ${signal.suggestedOptimizationType}`)
          }
        }

        // 持续下降警告
        if (qualityMetricsTracker.hasPersistentDowntrend(3)) {
          lines.push('')
          lines.push('⚠️ 连续 3 个周期健康评分下降，建议人工介入检查系统状态。')
        }

        // 趋势摘要
        const decliningMetrics = snapshot.metrics.filter((m) => m.trend === 'declining').map((m) => m.name)
        if (decliningMetrics.length > 0) {
          lines.push('')
          lines.push(`📉 劣化指标: ${decliningMetrics.join(', ')}`)
        }
        const improvingMetrics = snapshot.metrics.filter((m) => m.trend === 'improving').map((m) => m.name)
        if (improvingMetrics.length > 0) {
          lines.push(`📈 改善指标: ${improvingMetrics.join(', ')}`)
        }

        const qualitySummary = lines.join('\n')
        const enhancedSummary = ctx.rawSummary ? `${ctx.rawSummary}\n\n---\n${qualitySummary}` : qualitySummary

        return {
          enhancedSummary,
          extraData: {
            qualityMetrics: {
              healthScore: snapshot.healthScore,
              healthScoreDelta: snapshot.healthScoreDelta,
              isDegraded: snapshot.isDegraded,
              totalMetrics: snapshot.metrics.length,
              degradationSignals: snapshot.degradationSignals.length,
              callsInWindow: snapshot.totalToolCalls,
            },
          },
          messages: snapshot.isDegraded
            ? [
                `📊 质量指标: 评分 ${snapshot.healthScore.toFixed(0)}/100 ${snapshot.healthScoreDelta < 0 ? '↓' : '↑'} — ${snapshot.degradationSignals.length} 个降级信号`,
              ]
            : [`📊 质量指标: 评分 ${snapshot.healthScore.toFixed(0)}/100`],
        }
      } catch {
        return {}
      }
    }
  }

  /**
   * 公共方法：直接触发质量指标快照记录并返回降级信号。
   * 供 SelfEvolutionService 在管道执行前主动调用。
   */
  captureQualityMetrics(): {
    snapshot: ReturnType<typeof qualityMetricsTracker.recordSnapshot> | null
    signals: DegradationSignal[]
  } | null {
    if (!this.features.has('quality_metrics')) return null
    try {
      const snapshot = qualityMetricsTracker.recordSnapshot()
      return {
        snapshot,
        signals: snapshot.degradationSignals,
      }
    } catch {
      return null
    }
  }

  /** 获取质量指标追踪器实例 */
  getQualityMetricsTracker(): typeof qualityMetricsTracker {
    return qualityMetricsTracker
  }
}
