/**
 * RadarLedFeatureController — 反 UserBehavior 原型（反转 A2 + C3）
 *
 * ══════════════════════════════════════════════════════════════════════
 *  反转方向 A2: 雷达分析引擎动态决定 UserBehavior feature flags
 * ══════════════════════════════════════════════════════════════════════
 *
 * 当前（反转前）：
 *   UserBehavior 通过 USER_BEHAVIOR_FEATURES 环境变量静态决定特性开关
 *   → UserBehavior 决策，雷达执行
 *
 * 反转后（本原型）：
 *   雷达分析引擎（RadarMetricsMonitor + RadarFeedbackService）产出
 *   系统状态评估 → 动态推荐 UserBehavior 特性 → UserBehavior 按推荐生效
 *   → 雷达分析引擎决策，UserBehavior 执行
 *
 * ══════════════════════════════════════════════════════════════════════
 *  反转方向 C3: 雷达采集结果作为行为分析的输入
 * ══════════════════════════════════════════════════════════════════════
 *
 * 当前（反转前）：
 *   UserBehavior 基于内部工具调用数据（heatmap、n-gram）驱动优化
 *
 * 反转后（本原型）：
 *   雷达采集外部情报（HackerNews/GitHub Trending 等技术趋势）+ 用户对
 *   雷达结果的反馈 → 决定 UserBehavior 应该关注哪些模块 — 形成
 *   "外部情报 → 定向行为分析 → 精准优化" 链路
 *
 * ══════════════════════════════════════════════════════════════════════
 *  设计目标
 * ══════════════════════════════════════════════════════════════════════
 *
 * 1. 非侵入：与现有 UserBehaviorLayer 完全兼容，不修改其核心逻辑
 * 2. 两级控制：env var = 白名单（允许范围），雷达推荐 = 动态子集
 * 3. 可观测：所有推荐决策均有日志记录，可追溯
 * 4. 可降级：雷达不可用时回退到原始 env var 行为
 *
 * @module user-behavior
 */

import { log } from '../logger/Logger'
import type { UserBehaviorLayer } from './UserBehaviorLayer'
import type { UserBehaviorFeature } from './types'
import { parseFeaturesFromEnv } from './types'

// =============================================================================
// 类型定义
// =============================================================================

/**
 * 雷达分析产出的系统状态快照。
 * 这是「反转决策」的核心数据结构 — 雷达不再是数据提供者，
 * 而是状态评估者。
 */
export interface RadarSystemAssessment {
  /** 各模块的外部关注度（从雷达扫描的技术趋势中提取） */
  externalAttention: Record<string, number>
  /** 用户对雷达结果的满意度（来自 RadarFeedbackService） */
  userSatisfaction: Record<string, number>
  /** 采集器健康度（来自 RadarMetricsMonitor） */
  collectorHealth: {
    overallSuccessRate: number
    unhealthyCollectors: string[]
    healthyCollectors: string[]
  }
  /** 外部趋势热点列表 */
  trendingTopics: string[]
  /** 系统是否处于稳定状态 */
  systemStable: boolean
  /** 评估时间戳 */
  timestamp: number
}

/**
 * 雷达驱动的特性指令。
 * 每个指令包含推荐强度和理由，供 UserBehaviorLayer 消费。
 */
export interface RadarFeatureDirective {
  /** 推荐的 feature */
  feature: UserBehaviorFeature
  /** 推荐强度 0~1（0=关闭，1=强烈推荐开启） */
  strength: number
  /** 理由说明 */
  reason: string
  /** 数据来源 */
  source: 'radar_metrics' | 'radar_feedback' | 'radar_trend' | 'system_health'
}

/**
 * 特性推荐结果 — 雷达分析引擎的最终输出
 */
export interface FeatureRecommendation {
  /** 应开启的特性列表 */
  enabledFeatures: UserBehaviorFeature[]
  /** 完整指令详情（含理由） */
  directives: RadarFeatureDirective[]
  /** 评估依据 */
  assessment: RadarSystemAssessment
  /** 是否发生变更 */
  changed: boolean
}

/**
 * 雷达服务依赖抽象。
 * 实际运行时使用全局单例，测试时可 mock。
 */
export interface RadarServiceDeps {
  getMetricsMonitorAssessment?: () => RadarMetricsAssessment
  getFeedbackSatisfaction?: () => Record<string, number>
  getTrendingTopics?: () => string[]
  isAvailable: () => boolean
}

/** 简化的雷达指标评估（避免直接依赖 RadarMetricsMonitor 类型） */
export interface RadarMetricsAssessment {
  overallSuccessRate: number
  unhealthyCollectors: string[]
  healthyCollectors: string[]
}

// =============================================================================
// 默认策略 — 从雷达指标到 UserBehavior feature 的映射规则
// =============================================================================

/**
 * Feature 推荐策略规则表。
 * 每条规则定义一个条件（基于雷达评估）和对应的 feature 推荐。
 */
interface FeatureRule {
  /** 规则标识 */
  id: string
  /** 目标 feature */
  feature: UserBehaviorFeature
  /** 条件评估函数：返回推荐强度 0~1 */
  evaluate: (assessment: RadarSystemAssessment) => number
  /** 理由模板 */
  reasonTemplate: (strength: number, assessment: RadarSystemAssessment) => string
  /** 来源标签 */
  source: RadarFeatureDirective['source']
}

const FEATURE_RULES: FeatureRule[] = [
  // ── 基于雷达指标（RadarMetricsMonitor）─
  {
    id: 'metrics_enrich_by_health',
    feature: 'metrics_enrich',
    evaluate: (a) => {
      // 系统不稳定时增强指标采集
      if (a.collectorHealth.healthyCollectors.length + a.collectorHealth.unhealthyCollectors.length === 0) return 0.0
      const ratio = a.collectorHealth.healthyCollectors.length /
        (a.collectorHealth.healthyCollectors.length + a.collectorHealth.unhealthyCollectors.length)
      // 不稳定系统 → 需要更丰富指标来诊断
      return Math.min(1, (1 - ratio) * 2)
    },
    reasonTemplate: (_s, a) => {
      const total = a.collectorHealth.healthyCollectors.length + a.collectorHealth.unhealthyCollectors.length
      if (total === 0) return '无采集器数据，保守开启指标增强'
      const unhealthyRatio = a.collectorHealth.unhealthyCollectors.length / total
      return `Radar 检测到 ${Math.round(unhealthyRatio * 100)}% 采集器异常，需增强指标采集以辅助诊断`
    },
    source: 'radar_metrics',
  },
  {
    id: 'dynamic_tuning_by_health',
    feature: 'dynamic_pipeline_tuning',
    evaluate: (a) => {
      // 健康度低于 0.7 时推荐动态调参
      if (a.collectorHealth.overallSuccessRate >= 0.7) return 0.0
      return 1 - a.collectorHealth.overallSuccessRate
    },
    reasonTemplate: (_s, a) => {
      const pct = Math.round(a.collectorHealth.overallSuccessRate * 100)
      return `整体采集成功率 ${pct}%，需动态调整管道参数`
    },
    source: 'radar_metrics',
  },

  // ── 基于用户反馈（RadarFeedbackService）─
  {
    id: 'post_analyze_by_satisfaction',
    feature: 'post_analyze',
    evaluate: (a) => {
      const satValues = Object.values(a.userSatisfaction)
      if (!satValues.length) return 0.0
      const avgSat = satValues.reduce((sum, v) => sum + v, 0) / satValues.length
      // 满意度低 → 需要更多后处理分析来诊断原因
      return Math.min(1, Math.max(0, 0.5 - avgSat) * 2)
    },
    reasonTemplate: (_s, a) => {
      const satValues = Object.values(a.userSatisfaction)
      const avgSat = satValues.length > 0 ? (satValues.reduce((sum, v) => sum + v, 0) / satValues.length) : 0
      return `用户满意度偏低（均分 ${avgSat.toFixed(2)}），需增强后处理分析`
    },
    source: 'radar_feedback',
  },
  {
    id: 'behavior_driven_by_feedback',
    feature: 'behavior_driven_optimization',
    evaluate: (a) => {
      // 外部关注度高 → 行为驱动优化有价值
      const attValues = Object.values(a.externalAttention)
      if (!attValues.length) return 0.3 // 无外部数据时保守开启
      const maxAtt = Math.max(...attValues)
      return Math.min(1, maxAtt)
    },
    reasonTemplate: (s) =>
      `外部雷达扫描显示模块关注度峰值 ${Math.round(s * 100)}%，行为驱动优化可针对性改进`,
    source: 'radar_feedback',
  },

  // ── 基于外部趋势（radar_scan）─
  {
    id: 'heatmap_by_trend',
    feature: 'module_heatmap',
    evaluate: (a) => {
      // 外部有趋势热点 → 热力图可结合内外信号
      return a.trendingTopics.length > 0 ? 0.8 : 0.2
    },
    reasonTemplate: (_s, a) =>
      `雷达扫描到 ${a.trendingTopics.length} 个外部趋势热点，热力图可结合内外信号优化进化方向`,
    source: 'radar_trend',
  },
  {
    id: 'cold_module_by_trend',
    feature: 'cold_module_dampening',
    evaluate: (a) => {
      // 外部有明确趋势 → 冷模块更应降频，集中资源在热点上
      return a.trendingTopics.length > 2 ? 0.9 : 0.3
    },
    reasonTemplate: (_s, a) =>
      `外部趋势丰富（${a.trendingTopics.length} 个），应集中进化资源在热点模块上`,
    source: 'radar_trend',
  },

  // ── 基于系统健康度（综合）─
  {
    id: 'pre_collect_by_stability',
    feature: 'pre_collect_filter',
    evaluate: (a) => {
      // 系统不稳定 → 预处理过滤可减少噪声
      return a.systemStable ? 0.0 : 0.7
    },
    reasonTemplate: () => `系统不稳定，预处理过滤可减少管道执行噪声`,
    source: 'system_health',
  },
  {
    id: 'feedback_loop_by_health',
    feature: 'mcp_feedback_loop',
    evaluate: (a) => {
      // 健康度一般但非极差 → 反馈回路最有用
      const rate = a.collectorHealth.overallSuccessRate
      if (rate > 0.9) return 0.2 // 已经很好，不需调整
      if (rate < 0.3) return 0.6 // 很差，需要反馈但可能效果有限
      return 0.8 // 中等健康 → 反馈回路最有价值
    },
    reasonTemplate: (_s, a) => {
      const pct = Math.round(a.collectorHealth.overallSuccessRate * 100)
      return `采集成功率 ${pct}%，反馈回路可在中等健康区间发挥最大价值`
    },
    source: 'system_health',
  },
  {
    id: 'damping_by_health',
    feature: 'feedback_loop_damping',
    evaluate: (a) => {
      // 系统波动大 → 需阻尼防止震荡
      const unhealthy = a.collectorHealth.unhealthyCollectors.length
      return unhealthy > 2 ? 0.8 : 0.2
    },
    reasonTemplate: (_s, a) =>
      `${a.collectorHealth.unhealthyCollectors.length} 个采集器异常，需阻尼防止参数震荡`,
    source: 'system_health',
  },
]

// =============================================================================
// RadarLedFeatureController
// =============================================================================

/**
 * RadarLedFeatureController — 雷达主导的 Feature 选择控制器
 *
 * 工作原理：
 * 1. 收集雷达系统评估数据（指标、反馈、趋势）
 * 2. 对每条 FeatureRule 评估条件，得出推荐强度
 * 3. 强度 >= 阈值（默认 0.5）的 feature 被推荐开启
 * 4. 与环境变量白名单取交集：仅开启两者都允许的 feature
 * 5. 将最终结果应用到 UserBehaviorLayer
 *
 * 使用方式：
 * ```ts
 * const controller = new RadarLedFeatureController(userBehaviorLayer)
 * const result = await controller.evaluateAndApply()
 * if (result.changed) {
 *   log('INFO', 'radar_led_features_updated', { ... })
 * }
 * ```
 */
export class RadarLedFeatureController {
  /** 阈值：推荐强度 >= 此值才视为应开启 */
  private readonly THRESHOLD = 0.5

  private layer: UserBehaviorLayer | null = null
  private deps: RadarServiceDeps
  private lastRecommendation: FeatureRecommendation | null = null
  private envWhitelist: Set<UserBehaviorFeature>

  constructor(
    deps?: RadarServiceDeps,
    envWhitelist?: UserBehaviorFeature[],
  ) {
    this.deps = deps ?? {
      isAvailable: () => false,
    }
    // 读取环境变量作为白名单（两级控制的上限）
    this.envWhitelist = new Set(envWhitelist ?? parseFeaturesFromEnv())
  }

  /** 绑定 UserBehaviorLayer 实例 */
  bindLayer(layer: UserBehaviorLayer): void {
    this.layer = layer
    log('INFO', 'radar_led_controller_bound', {
      envWhitelist: Array.from(this.envWhitelist),
    })
  }

  /** 获取最后一次推荐结果 */
  getLastRecommendation(): FeatureRecommendation | null {
    return this.lastRecommendation
  }

  /** 获取环境变量白名单 */
  getEnvWhitelist(): UserBehaviorFeature[] {
    return Array.from(this.envWhitelist)
  }

  /**
   * 主入口：收集雷达评估 → 生成推荐 → 应用到 Layer。
   *
   * 这是「反转」的核心流程：
   * 不再是 UserBehavior 按静态配置决策，而是雷达分析引擎
   * 实时评估系统状态后动态决定 feature 开关。
   *
   * @returns 推荐结果（含是否发生变更）
   */
  async evaluateAndApply(): Promise<FeatureRecommendation> {
    // ── 步骤 1：收集雷达系统评估数据 ──
    const assessment = await this.collectAssessment()

    if (!this.deps.isAvailable()) {
      log('INFO', 'radar_led_controller_unavailable', {
        reason: 'Radar 服务暂不可用，回退到环境变量配置',
      })
      // 雷达不可用 → 回退到原始 env var 行为
      const fallback: FeatureRecommendation = {
        enabledFeatures: Array.from(this.envWhitelist),
        directives: [],
        assessment,
        changed: false,
      }
      this.lastRecommendation = fallback
      return fallback
    }

    // ── 步骤 2：评估所有 feature 规则 ──
    const directives: RadarFeatureDirective[] = FEATURE_RULES.map((rule) => {
      const strength = rule.evaluate(assessment)
      return {
        feature: rule.feature,
        strength,
        reason: strength >= this.THRESHOLD
          ? rule.reasonTemplate(strength, assessment)
          : `强度不足（${strength.toFixed(2)}），跳过`,
        source: rule.source,
      }
    })

    // ── 步骤 3：过滤出推荐开启的 feature ──
    const radarRecommended = directives
      .filter((d) => d.strength >= this.THRESHOLD)
      .map((d) => d.feature)

    // ── 步骤 4：与环境变量白名单取交集 ──
    // 两级控制：env var 是允许范围，雷达推荐是动态子集
    // feature 必须在两者中都出现才生效
    const enabledFeatures: UserBehaviorFeature[] = this.envWhitelist.size > 0
      ? radarRecommended.filter((f) => this.envWhitelist.has(f))
      : radarRecommended

    // 如果环境变量有值但雷达无推荐，保留 env var 的原始行为（安全降级）
    const finalFeatures = enabledFeatures.length > 0
      ? enabledFeatures
      : this.envWhitelist.size > 0
        ? Array.from(this.envWhitelist)
        : []

    // ── 步骤 5：比较是否有变更 ──
    const previous = this.lastRecommendation
    const changed = !previous || !this.featureSetsEqual(
      new Set(previous.enabledFeatures),
      new Set(finalFeatures),
    )

    const recommendation: FeatureRecommendation = {
      enabledFeatures: finalFeatures,
      directives,
      assessment,
      changed,
    }

    this.lastRecommendation = recommendation

    // ── 步骤 6：应用到 UserBehaviorLayer — 反转的生效点 ──
    if (this.layer) {
      // 目标: 让 layer 的动态特性集合与雷达推荐同步
      // 当前 UserBehaviorLayer 没有 setActiveFeatures() 方法，
      // 但可以通过重新设置 feature flags 的方式实现
      // 这里使用类型断言来访问私有 members，以最小化对现有代码的侵入
      this.applyToLayer(finalFeatures)
    }

    if (changed) {
      log('INFO', 'radar_led_features_updated', {
        enabled: finalFeatures,
        totalRules: FEATURE_RULES.length,
        passedThreshold: radarRecommended.length,
        envWhitelistActive: this.envWhitelist.size > 0,
      })
    }

    return recommendation
  }

  /**
   * 收集雷达系统评估数据。
   *
   * 如果 Radar 服务（MetricMonitor / FeedbackService）不可用，
   * 返回中性评估（systemStable=true，无额外数据），
   * 确保下游规则处理能安全降级。
   */
  private async collectAssessment(): Promise<RadarSystemAssessment> {
    const assessment: RadarSystemAssessment = {
      externalAttention: {},
      userSatisfaction: {},
      collectorHealth: {
        overallSuccessRate: 1.0,
        unhealthyCollectors: [],
        healthyCollectors: [],
      },
      trendingTopics: [],
      systemStable: true,
      timestamp: Date.now(),
    }

    try {
      // 从依赖注入获取雷达数据（实际外部服务的调用在此抽象）
      if (this.deps.getMetricsMonitorAssessment) {
        const metrics = this.deps.getMetricsMonitorAssessment()
        assessment.collectorHealth.overallSuccessRate = metrics.overallSuccessRate
        assessment.collectorHealth.unhealthyCollectors = metrics.unhealthyCollectors
        assessment.collectorHealth.healthyCollectors = metrics.healthyCollectors
        assessment.systemStable = metrics.unhealthyCollectors.length === 0
      }

      if (this.deps.getFeedbackSatisfaction) {
        assessment.userSatisfaction = this.deps.getFeedbackSatisfaction()
      }

      if (this.deps.getTrendingTopics) {
        assessment.trendingTopics = this.deps.getTrendingTopics()
      }

      // 外部关注度：从用户满意度和趋势热点的交集推算
      // 满意度低的 source 对应模块获得更高"关注"
      const attSources = [
        ...assessment.collectorHealth.unhealthyCollectors,
        ...assessment.trendingTopics.slice(0, 5),
      ]
      for (const src of attSources) {
        assessment.externalAttention[src] = (assessment.externalAttention[src] ?? 0) + 0.5
      }
    } catch (err: any) {
      log('WARN', 'radar_led_assessment_error', {
        error: err.message,
        usingDefault: true,
      })
    }

    return assessment
  }

  /**
   * 将最终 feature 列表应用到 UserBehaviorLayer。
   *
   * 由于 UserBehaviorLayer 当前使用 `private features` 存储，
   * 以最轻微的方式（类型断言 + 重新初始化）实现动态更新。
   */
  private applyToLayer(features: UserBehaviorFeature[]): void {
    if (!this.layer) return

    try {
      // 通过类型断言访问 private features 字段
      // 这是最小侵入方案：不修改 UserBehaviorLayer 类定义
      const layer = this.layer as any
      if (layer.features instanceof Set) {
        layer.features = new Set(features)
        log('INFO', 'radar_led_layer_features_applied', {
          count: features.length,
        })
      }
    } catch (err: any) {
      log('WARN', 'radar_led_apply_error', {
        error: err.message,
      })
    }
  }

  private featureSetsEqual(a: ReadonlySet<UserBehaviorFeature>, b: ReadonlySet<UserBehaviorFeature>): boolean {
    if (a.size !== b.size) return false
    for (const item of a) {
      if (!b.has(item)) return false
    }
    return true
  }
}

// =============================================================================
// 单例 & 工厂函数
// =============================================================================

/**
 * 创建预配置的 RadarLedFeatureController 实例。
 *
 * 如果 Radar 全局单例可用，自动连接；否则运行在只读模式（不产生推荐）。
 */
export function createRadarLedController(
  layer?: UserBehaviorLayer,
): RadarLedFeatureController {
  const deps: RadarServiceDeps = {
    isAvailable: () => {
      // 检查雷达相关全局单例是否可用（运行时动态检测）
      // 采用安全的方式：不直接 import 避免循环依赖
      return false // 默认不可用，需要显式注入真实依赖
    },
  }

  const controller = new RadarLedFeatureController(deps)
  if (layer) controller.bindLayer(layer)
  return controller
}

// =============================================================================
// 运行时集成辅助 — 在 Evolution 周期中注入
// =============================================================================

/**
 * Radar-led Evolution 预处理钩子。
 *
 * 这是反转流程的执行入口：
 * 1. 雷达分析引擎先评估系统状态
 * 2. 动态决定 UserBehavior 特性
 * 3. UserBehavior 按雷达推荐执行
 *
 * 用法（在 SelfEvolutionService 中）：
 * ```ts
 * import { radarLedPreProcess } from './user-behavior/RadarLedFeatureController'
 *
 * // 在执行 pipeline 前调用
 * const recommendation = await radarLedPreProcess(controller)
 * ```
 */
export async function radarLedPreProcess(
  controller: RadarLedFeatureController,
): Promise<FeatureRecommendation> {
  return controller.evaluateAndApply()
}

// =============================================================================
// Adapter: 将 RadarMetricsMonitor 的输出适配为 RadarServiceDeps
// =============================================================================

/**
 * 将 RadarMetricsMonitor 适配为 RadarServiceDeps 接口。
 *
 * 此函数是「反转」的关键桥梁 — 它将原本独立运行的
 * RadarMetricsMonitor 的输出接入 feature 决策链路。
 */
export function adaptRadarMetricsToDeps(
  getAssessment: () => RadarMetricsAssessment | null,
): Partial<RadarServiceDeps> {
  return {
    getMetricsMonitorAssessment: () => {
      const assessment = getAssessment()
      if (!assessment) {
        return {
          overallSuccessRate: 1.0,
          unhealthyCollectors: [],
          healthyCollectors: [],
        }
      }
      return assessment
    },
  }
}
