/**
 * BehaviorAdjustmentJournal — 行为驱动调整记录日志
 *
 * 记录每次基于行为模式分析所做的系统参数调整及其观察效果。
 * 效果用于后续调整决策：如果某次调整带来负面效果（如用户使用率下降），
 * 下次周期应回滚或调整策略。
 *
 * 存储格式：
 * - 每个 adjustment 记录：调整 ID、时间、类型、调整前的参数、调整后的参数、
 *   分析时的模式状态、观察到的效果（后续填写）
 *
 * 持久化：
 * - 存储到 evolution_workspace/behavior_adjustments.json
 *
 * @module behavior
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { WORKSPACE } from '@akemi-mio/core/config'

// ══════════════════════════════════════════
// 类型定义
// ══════════════════════════════════════════

/** 调整类型 */
export type AdjustmentType =
  | 'tts_voice_soften' // 深夜切换柔和 TTS
  | 'tts_voice_restore' // 恢复 TTS 默认
  | 'memory_summary_enhance' // 重复问题增强 Memory 摘要
  | 'memory_summary_restore' // 恢复 Memory 摘要
  | 'response_warmth_increase' // 负面情感时增加回复温暖度
  | 'response_warmth_restore' // 恢复回复温暖度
  | 'other'

/** 调整时的上下文快照 */
export interface AdjustmentContext {
  /** 分析报告摘要 */
  reportSummary: string
  /** 深夜活跃占比 */
  lateNightRatio: number
  /** 负面情感占比 */
  negativeRatio: number
  /** 主导提问类型 */
  dominantQuestionType: string
  /** 重复话题 */
  repeatedTopics: string[]
}

/** 观察到的效果（后续回填） */
export interface AdjustmentEffect {
  /** 后续交互数（调整后） */
  followUpInteractions: number
  /** 后续负面情感计数 */
  followUpNegativeCount: number
  /** 后续深夜交互数 */
  followUpLateNightCount: number
  /** 是否观察到积极效果 */
  positiveEffect: boolean | null // null = 未知（数据不足）
  /** 效果描述 */
  description: string
  /** 记录时间戳 */
  recordedAt: number
}

/** 单次调整记录 */
export interface AdjustmentRecord {
  /** 唯一标识 */
  id: string
  /** 调整类型 */
  type: AdjustmentType
  /** 触发分析的时间戳 */
  triggeredAt: number
  /** 调整原因描述 */
  reason: string
  /** 调整参数摘要（如 "voice: zh-CN-XiaoxiaoNeural → zh-CN-XiaoshuangNeural"） */
  paramChange: string
  /** 调整时的上下文快照 */
  context: AdjustmentContext
  /** 效果观察（后续回填） */
  effect: AdjustmentEffect | null
  /** 是否已回滚 */
  rolledBack: boolean
  /** 回滚时间 */
  rolledBackAt?: number
}

/** 日志持久化格式 */
export interface AdjustmentJournalData {
  /** schema 版本 */
  version: number
  /** 最后更新时间 */
  lastUpdated: number
  /** 所有调整记录 */
  adjustments: AdjustmentRecord[]
  /** 当前生效中的调整 ID 列表（尚未回滚） */
  activeAdjustmentIds: string[]
}

// ══════════════════════════════════════════
// 常量
// ══════════════════════════════════════════

/** 日志文件路径 */
const JOURNAL_FILE = join(WORKSPACE.evolution, 'behavior_adjustments.json')

/** 最多保留的记录数 */
const MAX_RECORDS = 100

/** 效果观察的最小窗口：调整后至少需要这么多交互才能评估 */
const MIN_EFFECT_EVALUATION_INTERACTIONS = 5

// ══════════════════════════════════════════
// BehaviorAdjustmentJournal
// ══════════════════════════════════════════

export class BehaviorAdjustmentJournal {
  /** 内存中的数据 */
  private data: AdjustmentJournalData

  constructor() {
    this.data = this.load()
  }

  // ══════════════════════════════════════════
  //  公共 API
  // ══════════════════════════════════════════

  /**
   * 记录一次调整。
   */
  record(params: { type: AdjustmentType; reason: string; paramChange: string; context: AdjustmentContext }): string {
    const id = `adj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    const record: AdjustmentRecord = {
      id,
      type: params.type,
      triggeredAt: Date.now(),
      reason: params.reason,
      paramChange: params.paramChange,
      context: params.context,
      effect: null,
      rolledBack: false,
    }

    this.data.adjustments.push(record)
    this.data.activeAdjustmentIds.push(id)
    this.data.lastUpdated = Date.now()

    // 限制记录数
    if (this.data.adjustments.length > MAX_RECORDS) {
      this.data.adjustments = this.data.adjustments.slice(-MAX_RECORDS)
    }

    this.save()

    log('INFO', 'adjustment_recorded', {
      id,
      type: params.type,
      reason: params.reason.slice(0, 80),
    })

    return id
  }

  /**
   * 回填观察效果。
   * 在后续周期中调用，评估之前的调整是否产生了正面影响。
   */
  recordEffect(
    adjustmentId: string,
    params: {
      followUpInteractions: number
      followUpNegativeCount: number
      followUpLateNightCount: number
      description: string
    },
  ): boolean {
    const record = this.data.adjustments.find((a) => a.id === adjustmentId)
    if (!record) return false

    const positiveEffect =
      params.followUpInteractions >= MIN_EFFECT_EVALUATION_INTERACTIONS
        ? params.followUpNegativeCount <= 0 // 无新的负面情感视为积极
        : null // 数据不足，无法判断

    record.effect = {
      followUpInteractions: params.followUpInteractions,
      followUpNegativeCount: params.followUpNegativeCount,
      followUpLateNightCount: params.followUpLateNightCount,
      positiveEffect,
      description: params.description,
      recordedAt: Date.now(),
    }

    this.data.lastUpdated = Date.now()
    this.save()

    log('INFO', 'adjustment_effect_recorded', {
      id: adjustmentId,
      positive: positiveEffect,
      followUp: params.followUpInteractions,
    })

    return true
  }

  /**
   * 标记某次调整为已回滚。
   */
  markRolledBack(adjustmentId: string): boolean {
    const record = this.data.adjustments.find((a) => a.id === adjustmentId)
    if (!record) return false

    record.rolledBack = true
    record.rolledBackAt = Date.now()
    this.data.activeAdjustmentIds = this.data.activeAdjustmentIds.filter((id) => id !== adjustmentId)
    this.data.lastUpdated = Date.now()
    this.save()

    log('INFO', 'adjustment_rolled_back', { id: adjustmentId })
    return true
  }

  /**
   * 获取当前仍生效的调整。
   */
  getActiveAdjustments(): AdjustmentRecord[] {
    return this.data.activeAdjustmentIds
      .map((id) => this.data.adjustments.find((a) => a.id === id))
      .filter((r): r is AdjustmentRecord => r !== undefined)
  }

  /**
   * 获取所有调整记录（最新的在前）。
   */
  getAll(): AdjustmentRecord[] {
    return [...this.data.adjustments].reverse()
  }

  /**
   * 获取最近一次指定类型的调整。
   */
  getLastByType(type: AdjustmentType): AdjustmentRecord | undefined {
    return [...this.data.adjustments].reverse().find((a) => a.type === type)
  }

  /**
   * 获取调整统计。
   */
  getStats(): { total: number; active: number; byType: Record<string, number> } {
    const byType: Record<string, number> = {}
    for (const a of this.data.adjustments) {
      byType[a.type] = (byType[a.type] || 0) + 1
    }
    return {
      total: this.data.adjustments.length,
      active: this.data.activeAdjustmentIds.length,
      byType,
    }
  }

  // ══════════════════════════════════════════
  //  持久化
  // ══════════════════════════════════════════

  private load(): AdjustmentJournalData {
    try {
      if (existsSync(JOURNAL_FILE)) {
        const raw = readFileSync(JOURNAL_FILE, 'utf-8')
        const parsed = JSON.parse(raw) as AdjustmentJournalData
        if (parsed.version === 1 && Array.isArray(parsed.adjustments)) {
          return parsed
        }
        log('WARN', 'adjustment_journal_invalid_format', { path: JOURNAL_FILE })
      }
    } catch (err) {
      log('WARN', 'adjustment_journal_load_failed', { error: String(err) })
    }
    return this.createDefault()
  }

  private save(): void {
    try {
      const dir = join(WORKSPACE.evolution)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(JOURNAL_FILE, JSON.stringify(this.data, null, 2), 'utf-8')
    } catch (err) {
      log('WARN', 'adjustment_journal_save_failed', { error: String(err) })
    }
  }

  private createDefault(): AdjustmentJournalData {
    return {
      version: 1,
      lastUpdated: Date.now(),
      adjustments: [],
      activeAdjustmentIds: [],
    }
  }
}

// ══════════════════════════════════════════
// 全局单例
// ══════════════════════════════════════════

export const behaviorAdjustmentJournal = new BehaviorAdjustmentJournal()
