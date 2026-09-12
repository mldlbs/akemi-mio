/**
 * TtsExperimentHook — TTS 参数随机化实验钩子
 *
 * 职责：
 *   1. 在 TTS 合成前，以一定概率对参数注入受控随机偏移
 *   2. 标记输出为 experimental 或 baseline，供后续 A/B 分析
 *   3. 收集实验数据（试验参数 + 用户反馈）
 *   4. 提供 A/B 比较结果，供进化系统决策
 *
 * 设计原则：
 *   - 轻量级：纯数值运算，不阻塞合成流程
 *   - 渐进探索：偏移幅度受 randomizationMagnitude 控制，避免突变
 *   - 平衡探索/利用：60% 基线 + 40% 实验（可配置）
 *   - 实验标记通过 VoicePreferenceModel 的 metadata 传递
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { EmotionTtsParams } from './types'
import { voicePreferenceModel } from './VoicePreferenceModel'
import { ttsConfigManager } from './TtsConfigManager'

// ══════════════════════════════════════════
//  实验相关类型
// ══════════════════════════════════════════

/** 实验变体类型 */
export type ExperimentVariant = 'baseline' | 'experimental'

/** 单次参数实验记录 */
export interface ExperimentRecord {
  /** 输出 ID（关联 VoicePreferenceModel 的 TTS 输出记录） */
  outputId: string
  /** 实验变体 */
  variant: ExperimentVariant
  /** 使用的 TTS 参数 */
  params: EmotionTtsParams
  /** 基线参数（如果 experimental，记录本应使用的基线） */
  baselineParams?: EmotionTtsParams
  /** 实验参数组 ID（用于 grouping 同一轮实验） */
  experimentGroupId: string | null
  /** 时间戳 */
  timestamp: number
  /** 累计隐式反馈分数（实验结束后回填） */
  cumulativeScore: number
}

/** A/B 分组统计 */
export interface ABGroupStats {
  /** 变体名 */
  variant: ExperimentVariant
  /** 样本数 */
  count: number
  /** 平均隐式反馈分数 */
  meanScore: number
  /** 平均每样本 feedback 数 */
  avgFeedbackCount: number
}

/** A/B 比较结果 */
export interface ABComparisonResult {
  /** 实验组标识 */
  experimentGroupId: string
  /** 基线组统计 */
  baseline: ABGroupStats
  /** 实验组统计 */
  experimental: ABGroupStats
  /** 分数差异（experimental.meanScore - baseline.meanScore） */
  scoreDelta: number
  /** 是否有显著性差异（样本量阈值 + delta 绝对值阈值） */
  significant: boolean
  /** 分析时间戳 */
  timestamp: number
  /** 实验组是否优于基线 */
  experimentalWins: boolean | null
}

// ══════════════════════════════════════════
//  常量
// ══════════════════════════════════════════

/** 默认实验概率（实验变体的比例） */
const DEFAULT_EXPERIMENT_PROBABILITY = 0.4

/** 最小样本数，低于此值不做 A/B 比较 */
const MIN_SAMPLES_FOR_AB_TEST = 6

/** 最小分数差异阈值（绝对值），低于此值视为无差异 */
const MIN_SCORE_DELTA_THRESHOLD = 0.5

/** 实验分组 TTL（毫秒），超过此时间启动新实验组 */
const EXPERIMENT_GROUP_TTL_MS = 2 * 60 * 60 * 1000 // 2 小时

// ══════════════════════════════════════════
//  TtsExperimentHook
// ══════════════════════════════════════════

export class TtsExperimentHook {
  /** 是否启用实验 */
  private enabled = true

  /** 实验概率（0-1） */
  private experimentProbability = DEFAULT_EXPERIMENT_PROBABILITY

  /** 所有实验记录 */
  private records: ExperimentRecord[] = []

  /** 当前实验组 ID */
  private currentGroupId: string | null = null

  /** 当前实验组开始时间 */
  private groupStartTime = 0

  /** 实验组计数器 */
  private groupCounter = 0

  /** A/B 比较结果缓存 */
  private lastComparisonResult: ABComparisonResult | null = null

  // ── 生命周期控制 ──

  /** 启用/禁用参数实验 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    log('INFO', 'tts_experiment_hook_enabled', { enabled })
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /** 设置实验概率 */
  setExperimentProbability(prob: number): void {
    this.experimentProbability = Math.max(0, Math.min(1, prob))
  }

  /** 获取当前实验概率 */
  getExperimentProbability(): number {
    return this.experimentProbability
  }

  // ── 核心：参数随机化 ──

  /**
   * 在 TTS 合成前调用，决定是否注入随机化参数。
   *
   * @param baseParams 当前选择的 TTS 参数（情感/行为/情境综合后的）
   * @returns 最终使用的参数 + 实验变体标记
   */
  applyRandomization(baseParams: EmotionTtsParams): {
    params: EmotionTtsParams
    variant: ExperimentVariant
    baselineParams?: EmotionTtsParams
    experimentGroupId: string | null
  } {
    if (!this.enabled) {
      return {
        params: baseParams,
        variant: 'baseline',
        experimentGroupId: null,
      }
    }

    const cfg = ttsConfigManager.getConfig()
    if (!cfg.experimentationEnabled) {
      return {
        params: baseParams,
        variant: 'baseline',
        experimentGroupId: null,
      }
    }

    // 轮换实验组（每 2 小时或每 N 次输出）
    this.ensureExperimentGroup()

    // 决定是否为实验输出
    const isExperimental = Math.random() < this.experimentProbability

    if (!isExperimental) {
      return {
        params: baseParams,
        variant: 'baseline',
        experimentGroupId: this.currentGroupId,
      }
    }

    // ── 注入随机偏移 ──
    const magnitude = cfg.randomizationMagnitude
    const experimentalParams = this.generateRandomizedParams(baseParams, magnitude)

    return {
      params: experimentalParams,
      variant: 'experimental',
      baselineParams: baseParams,
      experimentGroupId: this.currentGroupId,
    }
  }

  /**
   * 在 TTS 输出记录后调用，关联实验记录。
   */
  recordExperiment(
    outputId: string,
    variant: ExperimentVariant,
    params: EmotionTtsParams,
    baselineParams?: EmotionTtsParams,
    experimentGroupId?: string | null,
  ): void {
    if (!this.enabled) return

    const record: ExperimentRecord = {
      outputId,
      variant,
      params: { ...params },
      baselineParams: baselineParams ? { ...baselineParams } : undefined,
      experimentGroupId: experimentGroupId ?? this.currentGroupId,
      timestamp: Date.now(),
      cumulativeScore: 0,
    }

    this.records.push(record)

    // 限制记录数
    if (this.records.length > 500) {
      this.records = this.records.slice(-500)
    }
  }

  /**
   * 回填一条实验记录的累计分数（由 ImplicitFeedbackTracker 回调）。
   */
  updateExperimentScore(outputId: string, cumulativeScore: number): void {
    const record = this.records.find((r) => r.outputId === outputId)
    if (record) {
      record.cumulativeScore = cumulativeScore
    }
  }

  // ── A/B 分析 ──

  /**
   * 对当前实验组的数据执行 A/B 比较。
   * 如果样本量不足，返回 null。
   */
  analyzeCurrentGroup(): ABComparisonResult | null {
    if (!this.currentGroupId) return null

    const groupRecords = this.records.filter((r) => r.experimentGroupId === this.currentGroupId)

    const baselineRecords = groupRecords.filter((r) => r.variant === 'baseline')
    const experimentalRecords = groupRecords.filter((r) => r.variant === 'experimental')

    if (baselineRecords.length < MIN_SAMPLES_FOR_AB_TEST && experimentalRecords.length < MIN_SAMPLES_FOR_AB_TEST) {
      return null
    }

    const baselineStats = this.computeGroupStats(baselineRecords)
    const experimentalStats = this.computeGroupStats(experimentalRecords)

    const scoreDelta = experimentalStats.meanScore - baselineStats.meanScore
    const significant =
      baselineRecords.length >= MIN_SAMPLES_FOR_AB_TEST &&
      experimentalRecords.length >= MIN_SAMPLES_FOR_AB_TEST &&
      Math.abs(scoreDelta) >= MIN_SCORE_DELTA_THRESHOLD

    const result: ABComparisonResult = {
      experimentGroupId: this.currentGroupId,
      baseline: baselineStats,
      experimental: experimentalStats,
      scoreDelta,
      significant,
      timestamp: Date.now(),
      experimentalWins: significant ? scoreDelta > 0 : null,
    }

    this.lastComparisonResult = result

    log('INFO', 'tts_experiment_ab_result', {
      groupId: this.currentGroupId,
      baselineN: baselineRecords.length,
      experimentalN: experimentalRecords.length,
      scoreDelta: scoreDelta.toFixed(2),
      significant,
      experimentalWins: result.experimentalWins,
    })

    return result
  }

  /**
   * 分析所有历史实验组的汇总结果。
   * 返回所有已完成的、有意义的比较结果。
   */
  analyzeAllGroups(): ABComparisonResult[] {
    // 按 experimentGroupId 分组
    const groupMap = new Map<string, ExperimentRecord[]>()
    for (const record of this.records) {
      if (!record.experimentGroupId) continue
      const group = groupMap.get(record.experimentGroupId) || []
      group.push(record)
      groupMap.set(record.experimentGroupId, group)
    }

    const results: ABComparisonResult[] = []

    for (const [groupId, groupRecords] of groupMap.entries()) {
      const baselineRecords = groupRecords.filter((r) => r.variant === 'baseline')
      const experimentalRecords = groupRecords.filter((r) => r.variant === 'experimental')

      if (baselineRecords.length < MIN_SAMPLES_FOR_AB_TEST || experimentalRecords.length < MIN_SAMPLES_FOR_AB_TEST) {
        continue
      }

      const baselineStats = this.computeGroupStats(baselineRecords)
      const experimentalStats = this.computeGroupStats(experimentalRecords)
      const scoreDelta = experimentalStats.meanScore - baselineStats.meanScore
      const significant = Math.abs(scoreDelta) >= MIN_SCORE_DELTA_THRESHOLD

      results.push({
        experimentGroupId: groupId,
        baseline: baselineStats,
        experimental: experimentalStats,
        scoreDelta,
        significant,
        timestamp: Date.now(),
        experimentalWins: significant ? scoreDelta > 0 : null,
      })
    }

    return results
  }

  /**
   * 获取最近一次 A/B 比较结果（供进化系统消费）。
   */
  getLastComparisonResult(): ABComparisonResult | null {
    return this.lastComparisonResult
  }

  // ── 实验记录访问 ──

  /** 获取所有实验记录 */
  getRecords(): ExperimentRecord[] {
    return [...this.records]
  }

  /** 获取当前实验组的记录 */
  getCurrentGroupRecords(): ExperimentRecord[] {
    if (!this.currentGroupId) return []
    return this.records.filter((r) => r.experimentGroupId === this.currentGroupId)
  }

  /** 获取当前实验组的 ID */
  getCurrentGroupId(): string | null {
    return this.currentGroupId
  }

  /** 获取实验记录数 */
  getRecordCount(): number {
    return this.records.length
  }

  /** 强制开始新的实验组 */
  startNewGroup(): string {
    this.groupCounter++
    this.currentGroupId = `tts_exp_${Date.now()}_${this.groupCounter}`
    this.groupStartTime = Date.now()
    log('INFO', 'tts_experiment_new_group', { groupId: this.currentGroupId })
    return this.currentGroupId
  }

  /** 重置所有实验数据 */
  reset(): void {
    this.records = []
    this.currentGroupId = null
    this.groupStartTime = 0
    this.lastComparisonResult = null
    log('INFO', 'tts_experiment_hook_reset')
  }

  // ── 私有方法 ──

  /**
   * 确保当前实验组有效：如果无当前组或已过期，创建新组。
   */
  private ensureExperimentGroup(): void {
    if (!this.currentGroupId) {
      this.startNewGroup()
      return
    }

    // 每 2 小时轮换实验组
    if (Date.now() - this.groupStartTime > EXPERIMENT_GROUP_TTL_MS) {
      // 先分析当前组
      this.analyzeCurrentGroup()
      // 启动新组
      this.startNewGroup()
    }
  }

  /**
   * 在基线参数上注入受控随机偏移。
   *
   * 偏移范围：
   *   - rate: ±magnitude%（相对于 magnitude 的百分比）
   *   - pitch: ±magnitude/3 Hz（音调偏移幅度约为 magnitude 的 1/3）
   *   - voice: 5% 概率切换一个相近音色
   */
  private generateRandomizedParams(base: EmotionTtsParams, magnitude: number): EmotionTtsParams {
    const rateVal = parseInt(base.rate.replace(/[^0-9-]/g, '')) || 10
    const pitchVal = parseInt(base.pitch.replace(/[^0-9-]/g, '')) || 8

    // 随机偏移 rate（±magnitude%，但不超过 ±25% 绝对范围）
    const rateOffset = (Math.random() * 2 - 1) * magnitude
    const newRate = Math.max(-20, Math.min(30, rateVal + rateOffset))

    // 随机偏移 pitch（±magnitude/3 Hz，但不超过 ±10Hz 绝对范围）
    const pitchOffset = (Math.random() * 2 - 1) * (magnitude / 3)
    const newPitch = Math.max(-10, Math.min(15, pitchVal + pitchOffset))

    // 极低概率切换音色（5%）
    let newVoice = base.voice
    if (Math.random() < 0.05) {
      newVoice = this.getAlternateVoice(base.voice)
    }

    return {
      voice: newVoice,
      rate: `${newRate >= 0 ? '+' : ''}${Math.round(newRate)}%`,
      pitch: `${newPitch >= 0 ? '+' : ''}${Math.round(newPitch)}Hz`,
      label: `实验·${this.classifyExperimentLabel(newRate, newPitch)}`,
    }
  }

  /**
   * 获取备选音色。
   * 在已知的 zh-CN 音色中轮换，与原始音色不同。
   */
  private getAlternateVoice(currentVoice: string): string {
    const voices = [
      'zh-CN-XiaoxiaoNeural',
      'zh-CN-XiaoyiNeural',
      'zh-CN-YunyangNeural',
      'zh-CN-YunxiNeural',
      'zh-CN-YunjianNeural',
      'zh-CN-XiaohanNeural',
      'zh-CN-XiaomengNeural',
      'zh-CN-XiaomoNeural',
      'zh-CN-XiaoruiNeural',
      'zh-CN-XiaoshuangNeural',
    ]
    const filtered = voices.filter((v) => v !== currentVoice)
    return filtered[Math.floor(Math.random() * filtered.length)]
  }

  /**
   * 根据随机化后的参数生成人类可读的实验标签。
   */
  private classifyExperimentLabel(rate: number, pitch: number): string {
    const rateLabel = rate > 12 ? '快语速' : rate < 0 ? '慢语速' : '适中速'
    const pitchLabel = pitch > 8 ? '高音调' : pitch < 0 ? '低音调' : '中音调'
    return `${rateLabel}+${pitchLabel}`
  }

  /**
   * 计算一组实验记录的组统计。
   */
  private computeGroupStats(records: ExperimentRecord[]): ABGroupStats {
    if (records.length === 0) {
      return { variant: 'baseline', count: 0, meanScore: 0, avgFeedbackCount: 0 }
    }

    const totalScore = records.reduce((sum, r) => sum + r.cumulativeScore, 0)
    const totalFeedback = records.reduce((sum, r) => {
      const rec = voicePreferenceModel.getHistory().find((h) => h.outputId === r.outputId)
      return sum + (rec ? rec.actions.length : 0)
    }, 0)

    return {
      variant: records[0].variant,
      count: records.length,
      meanScore: records.length > 0 ? totalScore / records.length : 0,
      avgFeedbackCount: records.length > 0 ? totalFeedback / records.length : 0,
    }
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例 */
export const ttsExperimentHook = new TtsExperimentHook()
