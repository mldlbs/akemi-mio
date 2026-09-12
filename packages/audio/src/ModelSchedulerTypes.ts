/**
 * ModelSchedulerTypes — 个性化语音模型自适应调度器类型定义
 *
 * 职责：
 *   定义 ModelScheduler 所需的所有类型，包括使用记录、时段统计、
 *   预测结果、用户锁定状态等。
 *
 * 设计原则：
 *   - 与 existing types.ts 中已有的 DayPeriod、UserContext 等类型互通
 *   - 持久化结构支持 JSON 序列化（不包含函数/类引用）
 *   - 所有时间相关字段使用 Unix 毫秒时间戳
 */

import type { DayPeriod } from './types'

// ══════════════════════════════════════════
//  时段槽位定义
// ══════════════════════════════════════════

/** 时间段槽位标识符 — 由 dayPeriod 和 dayOfWeek 组合 */
export type TimeSlotKey = string // 格式: "afternoon_tue", "late_night_sat"

/** 星期（0=周日, 6=周六） */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** 星期简称映射 */
export const DAY_OF_WEEK_SHORT: Record<DayOfWeek, string> = {
  0: 'sun',
  1: 'mon',
  2: 'tue',
  3: 'wed',
  4: 'thu',
  5: 'fri',
  6: 'sat',
}

/** 星期中文名 */
export const DAY_OF_WEEK_CN: Record<DayOfWeek, string> = {
  0: '周日',
  1: '周一',
  2: '周二',
  3: '周三',
  4: '周四',
  5: '周五',
  6: '周六',
}

// ══════════════════════════════════════════
//  使用记录
// ══════════════════════════════════════════

/** 模型切换/使用的来源 */
export type ModelSelectionSource =
  | 'auto' // 自动（默认/TAG 映射）
  | 'manual' // 用户手动切换
  | 'scheduler' // ModelScheduler 自动预测切换
  | 'override' // 显式在请求中指定

/** 单条模型使用记录 */
export interface ModelUsageLogEntry {
  /** 时间戳 */
  timestamp: number
  /** 使用的模型名 */
  model: string
  /** 星期几 */
  dayOfWeek: DayOfWeek
  /** 小时（0-23） */
  hour: number
  /** 时段分类 */
  dayPeriod: DayPeriod
  /** 槽位键 */
  slotKey: TimeSlotKey
  /** 使用来源 */
  source: ModelSelectionSource
  /** 隐式反馈分数（初始0，后续可更新：+1=重听, -1=跳过） */
  feedbackScore: number
  /** 请求ID（用于关联 ImplicitFeedbackTracker） */
  requestId?: string
}

// ══════════════════════════════════════════
//  时段统计
// ══════════════════════════════════════════

/** 单个模型的时段统计 */
export interface ModelSlotStat {
  /** 使用次数 */
  count: number
  /** 加权分数（含反馈调整） */
  weightedScore: number
  /** 用户手动选择的次数（更强信号） */
  manualSelections: number
}

/** 时段槽位的完整统计 */
export interface SlotStats {
  /** 各模型的使用统计 */
  modelStats: Record<string, ModelSlotStat>
  /** 该槽位总使用次数 */
  totalUsage: number
  /** 最后更新时间 */
  lastUpdated: number
}

// ══════════════════════════════════════════
//  预测结果
// ══════════════════════════════════════════

/** 预测结果 */
export interface ModelPrediction {
  /** 建议的模型名 */
  recommendedModel: string
  /** 置信度 0-1 */
  confidence: number
  /** 基于规则的推荐 */
  ruleBasedRecommendation: string
  /** 基于学习的推荐 */
  learnedRecommendation: string | null
  /** 当前槽位 */
  slotKey: TimeSlotKey
  /** 当前时段 */
  dayPeriod: DayPeriod
  /** 当前星期 */
  dayOfWeek: DayOfWeek
  /** 预测理由 */
  reason: string
}

// ══════════════════════════════════════════
//  配置
// ══════════════════════════════════════════

/** ModelScheduler 配置 */
export interface ModelSchedulerConfig {
  /** 是否启用自动调度 */
  enabled: boolean
  /** 自动切换的置信度阈值（0-1，低于此值不自动切换） */
  autoSwitchConfidenceThreshold: number
  /** 规则推荐权重（0-1，剩余为学习权重） */
  ruleWeight: number
  /** 训练所需的最小样本数 */
  minSamplesForLearning: number
  /** 持久化文件路径 */
  persistencePath: string
  /** 最大保留日志条数 */
  maxLogEntries: number
  /** 模型变更冷却时间（毫秒），防止频繁切换 */
  switchCooldownMs: number
  /** 模型切换后合成延迟豁免时间（毫秒），首次合成延迟不计入负面评价 */
  warmUpPeriodMs: number
}

/** 默认配置 */
export const DEFAULT_MODEL_SCHEDULER_CONFIG: ModelSchedulerConfig = {
  enabled: true,
  autoSwitchConfidenceThreshold: 0.6,
  ruleWeight: 0.2,
  minSamplesForLearning: 5,
  persistencePath: '',
  maxLogEntries: 2000,
  switchCooldownMs: 300000, // 5 分钟
  warmUpPeriodMs: 60000, // 1 分钟
}

// ══════════════════════════════════════════
//  持久化结构
// ══════════════════════════════════════════

/** 持久化的 ModelScheduler 数据 */
export interface ModelSchedulerPersistedData {
  /** 数据版本 */
  version: number
  /** 使用日志 */
  usageLogs: ModelUsageLogEntry[]
  /** 时段统计 */
  slotStats: Record<TimeSlotKey, SlotStats>
  /** 用户是否锁定了模型 */
  locked: boolean
  /** 锁定的模型名（locked=true 时有效） */
  lockedModel: string | null
  /** 是否启用 */
  enabled: boolean
  /** 已学习到的槽位数 */
  learnedSlots: number
  /** 总预测次数 */
  totalPredictions: number
  /** 被接受的预测次数（用户未手动改回） */
  acceptedPredictions: number
  /** 最近一次切换的时间戳 */
  lastSwitchTimestamp: number
  /** 最后更新 */
  lastUpdated: number
}

// ══════════════════════════════════════════
//  运行时状态
// ══════════════════════════════════════════

/** ModelScheduler 运行时状态（供 IPC/UI 查询） */
export interface ModelSchedulerState {
  /** 是否启用 */
  enabled: boolean
  /** 是否锁定 */
  locked: boolean
  /** 锁定模型（如已锁定） */
  lockedModel: string | null
  /** 当前预测 */
  currentPrediction: ModelPrediction | null
  /** 当前活跃模型 */
  currentModel: string
  /** 日志条目数 */
  logCount: number
  /** 已学习的槽位数 */
  learnedSlots: number
  /** 总预测次数 */
  totalPredictions: number
  /** 接受率 */
  acceptanceRate: number
  /** 距上次切换的毫秒数（-1 若无切换） */
  msSinceLastSwitch: number
  /** 是否处于冷却中 */
  inCooldown: boolean
}

// ══════════════════════════════════════════
//  IPC 事件名
// ══════════════════════════════════════════

export const MODEL_SCHEDULER_IPC = {
  GET_STATE: 'tts:modelScheduler:getState',
  SET_ENABLED: 'tts:modelScheduler:setEnabled',
  LOCK_MODEL: 'tts:modelScheduler:lock',
  UNLOCK: 'tts:modelScheduler:unlock',
  GET_PREDICTION: 'tts:modelScheduler:getPrediction',
  GET_USAGE_LOGS: 'tts:modelScheduler:getUsageLogs',
  RESET_DATA: 'tts:modelScheduler:reset',
  UPDATE_CONFIG: 'tts:modelScheduler:updateConfig',
  FORCE_SWITCH: 'tts:modelScheduler:forceSwitch',
  GET_SLOT_STATS: 'tts:modelScheduler:getSlotStats',
  APPLY_PREDICTION: 'tts:modelScheduler:applyPrediction',
} as const

// ══════════════════════════════════════════
//  规则映射
// ══════════════════════════════════════════

/**
 * 时段 → 推荐模型的规则映射。
 *
 * 设计原则（与 ContextualTtsAdvisor/DAY_PERIOD_TTS_MAP 一致）：
 *   morning   → huayan-medium（活力、标准）
 *   afternoon → huayan-medium（标准、高效）
 *   evening   → ling_ling-medium（柔和、放松）
 *   late_night → ling_ling-medium（轻柔、舒适）
 */
export const DAY_PERIOD_MODEL_MAP: Record<DayPeriod, string> = {
  morning: 'zh_CN-huayan-medium',
  afternoon: 'zh_CN-huayan-medium',
  evening: 'zh_CN-ling_ling-medium',
  late_night: 'zh_CN-ling_ling-medium',
}

/** 规则推荐置信度 */
export const DAY_PERIOD_CONFIDENCE: Record<DayPeriod, number> = {
  morning: 0.5,
  afternoon: 0.3,
  evening: 0.6,
  late_night: 0.8,
}

/**
 * 星期 → 推荐模型的规则映射。
 * 工作日偏向标准/高效模型，周末偏向柔和/放松模型。
 */
export const DAY_OF_WEEK_MODEL_MAP: Record<DayOfWeek, string> = {
  0: 'zh_CN-ling_ling-medium', // 周日 → 柔和
  1: 'zh_CN-huayan-medium', // 周一 → 标准
  2: 'zh_CN-huayan-medium', // 周二 → 标准
  3: 'zh_CN-huayan-medium', // 周三 → 标准
  4: 'zh_CN-huayan-medium', // 周四 → 标准
  5: 'zh_CN-ling_ling-medium', // 周五 → 柔和（接近周末）
  6: 'zh_CN-ling_ling-medium', // 周六 → 柔和
}

// ══════════════════════════════════════════
//  工具函数
// ══════════════════════════════════════════

/** 根据日期构建槽位键 */
export function buildTimeSlotKey(dayPeriod: DayPeriod, dayOfWeek: DayOfWeek): TimeSlotKey {
  const dayShort = DAY_OF_WEEK_SHORT[dayOfWeek]
  return `${dayPeriod}_${dayShort}`
}

/** 获取当前时间的时段 */
export function getCurrentDayPeriod(): DayPeriod {
  const hour = new Date().getHours()
  if (hour >= 23 || hour < 6) return 'late_night'
  if (hour >= 6 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 18) return 'afternoon'
  return 'evening'
}

/** 获取当前星期 */
export function getCurrentDayOfWeek(): DayOfWeek {
  return new Date().getDay() as DayOfWeek
}

/** 获取当前槽位键 */
export function getCurrentSlotKey(): TimeSlotKey {
  return buildTimeSlotKey(getCurrentDayPeriod(), getCurrentDayOfWeek())
}
