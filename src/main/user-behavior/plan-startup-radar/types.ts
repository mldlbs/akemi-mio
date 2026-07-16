/**
 * PlanStartupRadarPlugin — 创业雷达 Telegram Bot 渐进式引入 类型定义
 *
 * 渐进式引入计划（与 Plan:实验42 对齐）：
 * - Phase 1 (当前): 旁路输出不做决策 (passive_monitor)
 * - Phase 2: 作为建议源影响部分决策 (suggestion_source)
 * - Phase 3: 替换 UserBehavior 核心模块 (core_replacement)
 */

// ==================== 引入阶段 ====================

/** 引入阶段 */
export type StartupRadarPhase = 'passive_monitor' | 'suggestion_source' | 'core_replacement'

/** 阶段标签 */
export const STARTUP_RADAR_PHASE_LABELS: Record<StartupRadarPhase, string> = {
  passive_monitor: 'Phase 1: 旁路输出（观察+日志，不做决策）',
  suggestion_source: 'Phase 2: 建议源（影响部分决策）',
  core_replacement: 'Phase 3: 核心替换（替换 UserBehavior 决策模块）',
}

// ==================== 配置 ====================

export interface PlanStartupRadarConfig {
  /** 当前引入阶段 */
  phase: StartupRadarPhase
  /** 观察窗口大小（保留最近 N 条观察记录） */
  observationWindowSize: number
  /** 雷达扫描间隔 ms */
  scanIntervalMs: number
  /** Evolution 报告中最大信号引用数 */
  maxSignalsInReport: number
  /** 是否输出详细日志 */
  debug: boolean
}

export const DEFAULT_STARTUP_RADAR_CONFIG: PlanStartupRadarConfig = {
  phase: 'passive_monitor',
  observationWindowSize: 200,
  scanIntervalMs: 3_600_000, // 1 小时
  maxSignalsInReport: 5,
  debug: false,
}

// ==================== 观察记录类型 ====================

/** 雷达扫描周期观察记录 */
export interface RadarScanObservation {
  /** 观察时间戳 */
  timestamp: number
  /** 信号总数 */
  signalCount: number
  /** 紧急信号数 */
  hotCount: number
  /** 关注信号数 */
  warmCount: number
  /** 综合热度 */
  compositeHeatIndex: number
  /** 来源分布 */
  sourceDistribution: Record<string, number>
  /** 类别分布 */
  categoryDistribution: Record<string, number>
  /** 最高评分信号标题 */
  topSignalTitle: string | null
  /** 最高评分信号分数 */
  topSignalScore: number | null
}

/** 行为-雷达关联观察记录 */
export interface BehaviorRadarCorrelation {
  /** 观察时间戳 */
  timestamp: number
  /** 行为情境 (coding/browsing/resting) */
  behaviorContext: string
  /** 雷达信号类别 */
  radarCategory: string
  /** 匹配信号数 */
  signalCount: number
  /** 关联度评分 (0-1) */
  relevanceScore: number
}

// ==================== 报告 ====================

/** 创业雷达引入实验报告 */
export interface StartupRadarReport {
  /** 当前阶段 */
  phase: StartupRadarPhase
  /** 总扫描次数 */
  totalScans: number
  /** 雷达扫描观察记录 */
  scanObservations: RadarScanObservation[]
  /** 行为-雷达关联记录 */
  correlations: BehaviorRadarCorrelation[]
  /** 采集时段 */
  collectionWindow: { from: number; to: number }
  /** 报告生成时间 */
  generatedAt: number
  /** 简单总结 */
  summary: string
}
