/**
 * FusionEngine — ASR 多路径结果融合引擎
 *
 * 职责：
 * 从多个并行的 ASR 解码器结果中，通过动态加权融合算法输出最优转录文本。
 *
 * 融合策略：
 * 1. weighted_vote（默认）：基于文本相似度分组，每组按（解码器权重 × 置信度）加权投票
 * 2. best_confidence：直接选择置信度最高的解码器结果
 * 3. single：仅有一个解码器活跃时退化为此模式
 *
 * 动态权重调整：
 * - 每次调用后根据历史准确率更新各解码器的融合权重
 * - 权重公式: w_i = baseWeight_i × historicalAccuracy_i^decayFactor
 * - 故障解码器权重自动降低（直至从活跃列表移除）
 *
 * 风险注意：
 * - 融合算法不当可能降低准确率（如低质量解码器拉低高质量结果）
 * - 本引擎通过置信度阈值和衰减因子控制此风险
 */

import { log } from '../../logger/Logger'
import type {
  DecoderConfig,
  DecoderHealth,
  DecoderResult,
  FusionMethod,
  MultiPathFusionConfig,
  MultiPathFusionResult,
} from './types'
import { DEFAULT_FUSION_CONFIG } from './types'

// ══════════════════════════════════════════
//  文本相似度工具
// ══════════════════════════════════════════

/** 编辑距离（Levenshtein），用于测量文本相似度 */
function levenshteinDistance(a: string, b: string): number {
  const alen = a.length
  const blen = b.length
  if (alen === 0) return blen
  if (blen === 0) return alen

  const matrix: number[] = new Array(blen + 1)
  for (let j = 0; j <= blen; j++) matrix[j] = j

  for (let i = 1; i <= alen; i++) {
    let prev = i
    for (let j = 1; j <= blen; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const val = Math.min(
        prev + 1,
        matrix[j] + 1,
        matrix[j - 1] + cost,
      )
      matrix[j - 1] = prev
      prev = val
    }
    matrix[blen] = prev
  }

  return matrix[blen]
}

/** 文本相似度 (0–1)，1 = 完全相同 */
function textSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (!a || !b) return 0
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  return 1 - levenshteinDistance(a, b) / maxLen
}

// ══════════════════════════════════════════
//  解码器权重跟踪
// ══════════════════════════════════════════

interface DecoderWeightState {
  name: string
  baseWeight: number
  dynamicWeight: number
  confidenceBias: number
  historicalAccuracy: number
  lastUpdated: number
}

// ══════════════════════════════════════════
//  FusionEngine
// ══════════════════════════════════════════

export class FusionEngine {
  private config: MultiPathFusionConfig
  /** 各解码器的权重跟踪表 */
  private weightTable = new Map<string, DecoderWeightState>()

  constructor(config?: Partial<MultiPathFusionConfig>) {
    this.config = { ...DEFAULT_FUSION_CONFIG, ...config }
  }

  // ══════════════════════════════════════
  //  公共 API
  // ══════════════════════════════════════

  /**
   * 更新融合配置。
   */
  updateConfig(partial: Partial<MultiPathFusionConfig>): void {
    this.config = { ...this.config, ...partial }
  }

  /**
   * 获取当前融合配置。
   */
  getConfig(): MultiPathFusionConfig {
    return { ...this.config }
  }

  /**
   * 注册或更新一个解码器的权重与配置。
   * 在 MultiPathDecoderManager 添加解码器时调用。
   */
  registerDecoder(config: DecoderConfig): void {
    this.weightTable.set(config.name, {
      name: config.name,
      baseWeight: config.initialWeight,
      dynamicWeight: config.initialWeight,
      confidenceBias: config.confidenceBias,
      historicalAccuracy: 1.0,
      lastUpdated: Date.now(),
    })
  }

  /**
   * 从权重表中移除解码器。
   * 在解码器崩溃/死亡时调用。
   */
  unregisterDecoder(name: string): void {
    this.weightTable.delete(name)
  }

  /**
   * 获取解码器的当前融合权重。
   */
  getDecoderWeight(name: string): number {
    return this.weightTable.get(name)?.dynamicWeight ?? 0
  }

  /**
   * 获取所有注册解码器的权重快照（用于调试/日志）。
   */
  getWeightTable(): Array<{ name: string; baseWeight: number; dynamicWeight: number; accuracy: number }> {
    return Array.from(this.weightTable.values()).map((w) => ({
      name: w.name,
      baseWeight: w.baseWeight,
      dynamicWeight: w.dynamicWeight,
      accuracy: w.historicalAccuracy,
    }))
  }

  /**
   * 核心融合方法。
   *
   * @param results         所有解码器的本次结果（包括成功和失败）
   * @param decoderHealths  各解码器的健康状态快照（用于获取 historicalAccuracy）
   * @returns               融合后的最优输出
   */
  fuse(
    results: DecoderResult[],
    decoderHealths: DecoderHealth[],
  ): MultiPathFusionResult {
    const t0 = Date.now()
    const successful = results.filter((r) => r.success && r.text.trim().length > 0)
    const activeDecoderCount = decoderHealths.filter((h) => h.active).length
    const totalDecoderCount = decoderHealths.length
    const degraded = results.some((r) => !r.success)

    // ── 更新权重表 ──
    this.updateWeights(results, decoderHealths)

    // ── 确定融合方法 ──
    let fusionMethod: FusionMethod
    if (successful.length <= 1) {
      fusionMethod = 'single'
    } else {
      fusionMethod = 'weighted_vote'
    }

    // ── 执行融合 ──
    const fusionResult = this.executeFusion(successful, fusionMethod)

    const fusionLatencyMs = Date.now() - t0

    log('DEBUG', 'multipath_fusion_completed', {
      method: fusionMethod,
      successful_decoders: successful.map((r) => r.name).join(','),
      active_count: activeDecoderCount,
      total_count: totalDecoderCount,
      degraded,
      result_text: fusionResult.text.slice(0, 40),
      confidence: fusionResult.confidence.toFixed(3),
      latency_ms: fusionLatencyMs,
    })

    return {
      ...fusionResult,
      decoderResults: results,
      fusionMethod,
      activeDecoderCount,
      totalDecoderCount,
      degraded,
      fusionLatencyMs,
    }
  }

  // ══════════════════════════════════════
  //  权重更新
  // ══════════════════════════════════════

  private updateWeights(results: DecoderResult[], healths: DecoderHealth[]): void {
    for (const result of results) {
      const state = this.weightTable.get(result.name)
      if (!state) continue

      const health = healths.find((h) => h.name === result.name)
      const historicalAccuracy = health?.historicalAccuracy ?? 1.0
      state.historicalAccuracy = historicalAccuracy
      state.lastUpdated = Date.now()

      // 动态权重 = baseWeight × accuracy^decayFactor
      // 当 accuracy 接近 0 时权重快速衰减
      const effectiveAccuracy = Math.max(0.05, historicalAccuracy)
      const decayFactor = this.config.historyDecayFactor
      state.dynamicWeight = state.baseWeight * Math.pow(effectiveAccuracy, 1 - decayFactor)

      // 失败结果额外惩罚
      if (!result.success) {
        state.dynamicWeight *= 0.5
      }

      // 钳制到合理范围
      state.dynamicWeight = Math.max(0.05, Math.min(3.0, state.dynamicWeight))
    }

    // 移除死亡解码器（consecutiveFailures 过大或 state=crashed）
    for (const [name, state] of this.weightTable) {
      const health = healths.find((h) => h.name === name)
      if (health && (health.state === 'dead' || health.state === 'crashed')) {
        state.dynamicWeight = 0
      }
    }
  }

  // ══════════════════════════════════════
  //  融合执行
  // ══════════════════════════════════════

  private executeFusion(
    successful: DecoderResult[],
    method: FusionMethod,
  ): Pick<MultiPathFusionResult, 'text' | 'confidence' | 'primaryEngine'> {
    if (successful.length === 0) {
      return {
        text: '',
        confidence: 0,
        primaryEngine: 'none',
      }
    }

    switch (method) {
      case 'best_confidence':
        return this.fuseByBestConfidence(successful)

      case 'single':
        return this.fuseSingle(successful[0])

      case 'weighted_vote':
      default:
        return this.fuseByWeightedVote(successful)
    }
  }

  /**
   * 加权投票融合 — 核心算法。
   *
   * 1. 计算每对结果之间的文本相似度，将高度相似的结果聚类
   * 2. 每类的总分 = sum(decoderWeight × confidence × historicalAccuracy)
   * 3. 选择总分最高的类作为输出
   * 4. 输出文本 = 该类中加权置信度最高的解码器的文本
   * 5. 最终置信度 = 该类总分 / 该类总权重
   */
  private fuseByWeightedVote(
    results: DecoderResult[],
  ): Pick<MultiPathFusionResult, 'text' | 'confidence' | 'primaryEngine'> {
    const SIMILARITY_THRESHOLD = 0.7
    const n = results.length

    // 构建相似度矩阵（仅计算 n*(n-1)/2 对）
    const clusters: Array<{ indices: number[]; totalWeight: number; weightedScore: number }> = []
    const assigned = new Set<number>()

    for (let i = 0; i < n; i++) {
      if (assigned.has(i)) continue

      const cluster = { indices: [i], totalWeight: 0, weightedScore: 0 }
      assigned.add(i)

      for (let j = i + 1; j < n; j++) {
        if (assigned.has(j)) continue

        const sim = textSimilarity(results[i].text, results[j].text)
        if (sim >= SIMILARITY_THRESHOLD) {
          cluster.indices.push(j)
          assigned.add(j)
        }
      }

      clusters.push(cluster)
    }

    // 计算每个聚类的加权总分
    for (const cluster of clusters) {
      for (const idx of cluster.indices) {
        const r = results[idx]
        const w = this.getDecoderWeight(r.name)
        cluster.totalWeight += w
        cluster.weightedScore += w * r.confidence
      }
    }

    // 按加权总分降序排列
    clusters.sort((a, b) => b.weightedScore - a.weightedScore)

    const winningCluster = clusters[0]
    if (!winningCluster || winningCluster.indices.length === 0) {
      return this.fuseByBestConfidence(results)
    }

    // 在获胜类中选择置信度最高的解码器文本作为输出
    let bestResult = results[winningCluster.indices[0]]
    for (let k = 1; k < winningCluster.indices.length; k++) {
      const candidate = results[winningCluster.indices[k]]
      if (candidate.confidence > bestResult.confidence) {
        bestResult = candidate
      }
    }

    // 最终置信度 = 加权分数 / 总权重（归一化到 0–1）
    const finalConfidence =
      winningCluster.totalWeight > 0
        ? Math.min(1, winningCluster.weightedScore / winningCluster.totalWeight)
        : bestResult.confidence

    return {
      text: bestResult.text,
      confidence: finalConfidence,
      primaryEngine: bestResult.name,
    }
  }

  /**
   * 最佳置信度策略：选择置信度最高的解码器结果。
   */
  private fuseByBestConfidence(
    results: DecoderResult[],
  ): Pick<MultiPathFusionResult, 'text' | 'confidence' | 'primaryEngine'> {
    const sorted = [...results].sort((a, b) => {
      const wa = this.getDecoderWeight(a.name) * a.confidence
      const wb = this.getDecoderWeight(b.name) * b.confidence
      return wb - wa
    })

    const best = sorted[0]
    return {
      text: best.text,
      confidence: best.confidence,
      primaryEngine: best.name,
    }
  }

  /**
   * 单解码器策略：直接返回唯一结果。
   */
  private fuseSingle(
    result: DecoderResult,
  ): Pick<MultiPathFusionResult, 'text' | 'confidence' | 'primaryEngine'> {
    return {
      text: result.text,
      confidence: result.confidence,
      primaryEngine: result.name,
    }
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

export const fusionEngine = new FusionEngine()
