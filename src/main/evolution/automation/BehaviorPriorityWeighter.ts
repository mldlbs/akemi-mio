/**
 * BehaviorPriorityWeighter — 行为驱动的进化优先级加权器
 *
 * 职责：
 * 1. 将 BehaviorHeatmapService 生成的模块热力图转换为每模块优先级权重
 * 2. 对权重应用 EMA（指数移动平均）平滑，防止短期波动导致进化方向不稳定
 * 3. 权重用于 ProblemQueue.sort() 中修正问题优先级排序
 *
 * 权重策略：
 * - 高频模块（hot）:   权重 1.5x — 用户最常使用的功能区域，进化优先优化
 * - 高错误模块（error）: 权重 1.3x — 用户高频出错区域，进化优先修复
 * - 低频模块（cold）:   权重 0.5x — 用户很少使用，降低进化投入
 * - 普通模块:          权重 1.0x — 按默认优先级处理
 *
 * 平滑机制：
 *   权重 = α × 当前热力图权重 + (1-α) × 历史权重
 *   α = 0.3（默认），响应趋势的同时有效过滤短期噪声。
 *   α 可随数据量自适应调整：数据量越少，α 越低（更保守）。
 */

import { log } from '../../logger/Logger'
import type { ModuleHeatmap, ModuleHeatmapEntry } from '../../user-behavior/types'

// ════════════════════════════════════════════════════════════════
//  常量
// ════════════════════════════════════════════════════════════════

/** 高频模块权重乘数 */
const HOT_MODULE_WEIGHT = 1.5

/** 高错误模块权重乘数（与 hot 权重取最大值） */
const ERROR_MODULE_WEIGHT = 1.3

/** 低频模块权重乘数（低于 1 表示降低优先级） */
const COLD_MODULE_WEIGHT = 0.5

/** 普通模块默认权重 */
const NORMAL_WEIGHT = 1.0

/** EMA 平滑因子 α 默认值 */
const DEFAULT_ALPHA = 0.3

/** 最小 α（数据稀疏时使用） */
const MIN_ALPHA = 0.1

/** 最大 α（数据充足时使用） */
const MAX_ALPHA = 0.5

/** 数据充足阈值（工具调用数 >= 此值视为数据充足） */
const SUFFICIENT_DATA_THRESHOLD = 100

/** 权重历史持久化键名 */
const WEIGHT_HISTORY_KEY = 'behavior_priority_weights'

// ════════════════════════════════════════════════════════════════
//  类型
// ════════════════════════════════════════════════════════════════

/** 模块 → 优先级权重的映射 */
export type BehaviorWeightMap = Record<string, number>

/** 加权器状态（包含历史权重快照，用于 EMA 计算） */
export interface WeighterState {
  /** 当前权重（EMA 平滑后） */
  current: BehaviorWeightMap
  /** 上次计算的原始（未平滑）权重 */
  lastRaw: BehaviorWeightMap
  /** 上次更新时的总调用数，用于自适应 α */
  lastTotalCalls: number
  /** 更新时间戳 */
  updatedAt: number
}

// ════════════════════════════════════════════════════════════════
//  行为优先级加权器
// ════════════════════════════════════════════════════════════════

export class BehaviorPriorityWeighter {
  /** 内部状态（含 EMA 历史） */
  private state: WeighterState = {
    current: {},
    lastRaw: {},
    lastTotalCalls: 0,
    updatedAt: 0,
  }

  /** 是否已初始化（至少有一次有效计算） */
  private initialized = false

  // ════════════════════════════════════════════════════════════════
  //  公共 API
  // ════════════════════════════════════════════════════════════════

  /**
   * 从热力图计算模块优先级权重。
   *
   * @param heatmap 模块热力图（由 BehaviorHeatmapService.generate() 生成）
   * @returns 模块 → 权重的映射，每次调用返回平滑后的结果
   */
  compute(heatmap: ModuleHeatmap): BehaviorWeightMap {
    // 1. 计算当前周期的原始（未平滑）权重
    const rawWeights = this.computeRawWeights(heatmap)

    // 2. 自适应 α：数据越多 α 越高（信任当前数据更多）
    const alpha = this.computeAdaptiveAlpha(heatmap.totalToolCalls)

    // 3. EMA 平滑
    const smoothed = this.smoothWeights(rawWeights, alpha)

    // 4. 更新内部状态
    this.state = {
      current: smoothed,
      lastRaw: rawWeights,
      lastTotalCalls: heatmap.totalToolCalls,
      updatedAt: Date.now(),
    }
    this.initialized = true

    log('INFO', 'behavior_priority_weights_computed', {
      modules: Object.keys(smoothed).length,
      alpha: alpha.toFixed(2),
      top: this.getTopModules(smoothed, 3),
      totalCalls: heatmap.totalToolCalls,
    })

    return smoothed
  }

  /**
   * 获取当前已平滑的权重快照。
   * 如果尚未计算，返回空映射。
   */
  getCurrentWeights(): BehaviorWeightMap {
    return { ...this.state.current }
  }

  /**
   * 获取加权器的状态快照（可用于持久化/恢复）。
   */
  getState(): WeighterState {
    return {
      current: { ...this.state.current },
      lastRaw: { ...this.state.lastRaw },
      lastTotalCalls: this.state.lastTotalCalls,
      updatedAt: this.state.updatedAt,
    }
  }

  /**
   * 从持久化的状态恢复加权器。
   */
  restoreState(state: WeighterState): void {
    this.state = {
      current: { ...state.current },
      lastRaw: { ...state.lastRaw },
      lastTotalCalls: state.lastTotalCalls,
      updatedAt: state.updatedAt,
    }
    this.initialized = Object.keys(state.current).length > 0
    log('INFO', 'behavior_priority_weighter_restored', {
      modules: Object.keys(state.current).length,
      updatedAt: state.updatedAt,
    })
  }

  /** 加权器是否已初始化 */
  isInitialized(): boolean {
    return this.initialized
  }

  /** 重置加权器状态 */
  reset(): void {
    this.state = {
      current: {},
      lastRaw: {},
      lastTotalCalls: 0,
      updatedAt: 0,
    }
    this.initialized = false
    log('INFO', 'behavior_priority_weighter_reset')
  }

  // ════════════════════════════════════════════════════════════════
  //  内部方法
  // ════════════════════════════════════════════════════════════════

  /**
   * 从热力图计算原始（未平滑）权重。
   *
   * 策略规则：
   * 1. 高频模块 → 1.5x 权重（提升问题优先级，用户常用功能）
   * 2. 高错误模块 → 1.3x 权重（修复问题优先级高）
   *    如果同时是高频模块，取最大值（不叠加，避免过度优化单一功能）
   * 3. 低频模块 → 0.5x 权重（降低优先级，节省计算资源）
   * 4. 普通模块 → 1.0x 权重
   */
  private computeRawWeights(heatmap: ModuleHeatmap): BehaviorWeightMap {
    const weights: BehaviorWeightMap = {}

    if (!heatmap.hasSufficientData) return weights

    // 构建热模块集合
    const hotSet = new Set(heatmap.hotModules.map((e) => e.module))
    // 构建错误模块集合（排除已是热模块的，避免叠加）
    const errorSet = new Set(
      heatmap.errorModules
        .filter((e) => !hotSet.has(e.module))
        .map((e) => e.module),
    )
    // 构建冷模块集合
    const coldSet = new Set(heatmap.coldModules.map((e) => e.module))

    // 为所有出现过的模块设置权重
    const allModules = new Set<string>()
    for (const entry of heatmap.entries) {
      allModules.add(entry.module)
    }

    for (const module of allModules) {
      if (hotSet.has(module)) {
        weights[module] = HOT_MODULE_WEIGHT
      } else if (errorSet.has(module)) {
        weights[module] = ERROR_MODULE_WEIGHT
      } else if (coldSet.has(module)) {
        weights[module] = COLD_MODULE_WEIGHT
      } else {
        weights[module] = NORMAL_WEIGHT
      }
    }

    // 进一步细化：在 hot/error 内部根据使用量或错误率分配权重
    this.refineHotWeights(weights, heatmap.hotModules)
    this.refineErrorWeights(weights, heatmap.errorModules)

    return weights
  }

  /**
   * 细化高频模块权重：使用量越大权重略高（在 1.5 基础上 +0~0.3）。
   */
  private refineHotWeights(weights: BehaviorWeightMap, hotModules: ModuleHeatmapEntry[]): void {
    if (hotModules.length === 0) return
    const maxUsage = hotModules[0].usageCount
    for (const entry of hotModules) {
      // 相对比例（0~0.3 的加成）
      const bonus = maxUsage > 0 ? (entry.usageCount / maxUsage) * 0.3 : 0
      weights[entry.module] = Math.min(HOT_MODULE_WEIGHT + bonus, 1.8) // 上限 1.8
    }
  }

  /**
   * 细化高错误模块权重：错误率越高权重越高（在 1.3 基础上 +0~0.2）。
   */
  private refineErrorWeights(weights: BehaviorWeightMap, errorModules: ModuleHeatmapEntry[]): void {
    for (const entry of errorModules) {
      const bonus = entry.errorRate * 0.2
      // 如果该模块已有 hot 权重（更高），保留 hot 权重
      const existing = weights[entry.module] ?? NORMAL_WEIGHT
      weights[entry.module] = Math.max(existing, Math.min(ERROR_MODULE_WEIGHT + bonus, 1.5))
    }
  }

  /**
   * 自适应 α 计算：数据量越多 α 越大（更信任当前数据）。
   * 数据稀疏时 α 较小（更依赖历史，避免权重跳跃）。
   */
  private computeAdaptiveAlpha(totalCalls: number): number {
    if (totalCalls <= 0) return MIN_ALPHA

    const ratio = Math.min(totalCalls / SUFFICIENT_DATA_THRESHOLD, 1)
    const alpha = MIN_ALPHA + ratio * (MAX_ALPHA - MIN_ALPHA)

    return Math.round(alpha * 10) / 10 // 保留一位小数
  }

  /**
   * EMA 平滑：当前权重 = α × 原始权重 + (1-α) × 历史权重。
   * 对首次出现的模块，直接将原始权重作为当前权重（无历史依赖）。
   */
  private smoothWeights(rawWeights: BehaviorWeightMap, alpha: number): BehaviorWeightMap {
    const smoothed: BehaviorWeightMap = {}

    const allModules = new Set([
      ...Object.keys(rawWeights),
      ...Object.keys(this.state.current),
    ])

    for (const module of allModules) {
      const raw = rawWeights[module] ?? NORMAL_WEIGHT
      const prev = this.state.current[module]

      if (prev === undefined) {
        // 新出现的模块：直接使用原始权重
        smoothed[module] = raw
      } else {
        // EMA 平滑
        smoothed[module] = alpha * raw + (1 - alpha) * prev
      }
    }

    return smoothed
  }

  /**
   * 获取权重最高的几个模块（用于日志/调试）。
   */
  private getTopModules(weights: BehaviorWeightMap, n: number): string[] {
    return Object.entries(weights)
      .sort(([, a], [, b]) => b - a)
      .slice(0, n)
      .map(([module, weight]) => `${module}:${weight.toFixed(2)}x`)
  }
}

/** 模块级单例 */
export const behaviorPriorityWeighter = new BehaviorPriorityWeighter()
