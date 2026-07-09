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

import { log } from '../logger/Logger'
import type { SelfEvolutionService } from '../evolution/SelfEvolutionService'
import type { PipelineMetrics } from '../evolution/automation'
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
      const fixRate = rawMetrics.totalCollected > 0
        ? ((rawMetrics.totalFixed / rawMetrics.totalCollected) * 100).toFixed(1)
        : 'N/A'

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

      const failureRate = rawMetrics.totalCollected > 0
        ? rawMetrics.totalFailed / rawMetrics.totalCollected
        : 0

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

  /**
   * 后处理钩子：行为优化分析。
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
            const tag = sug.type === 'preload_module' ? '📦' :
              sug.type === 'optimize_response' ? '⚡' :
              sug.type === 'add_cache' ? '💾' :
              sug.type === 'improve_error' ? '🛡️' : '🔧'
            lines.push(`  ${tag} ${sug.title}（${sug.expectedBenefit}）`)
          }
        }

        if (lines.length > 0) {
          const enhancedSummary = ctx.rawSummary
            ? `${ctx.rawSummary}\n\n---\n${lines.join('\n')}`
            : lines.join('\n')

          return {
            enhancedSummary,
            extraData: {
              behaviorAnalysis: {
                sequencesFound: features.frequentSequences.length,
                pausePointsFound: features.pausePoints.length,
                suggestionsGenerated: features.suggestions.length,
              },
            },
            messages: features.suggestions.length > 0
              ? [`🧠 行为分析：发现 ${features.suggestions.length} 个优化机会`]
              : [],
          }
        }

        return {}
      } catch {
        return {}
      }
    }
  }
}
