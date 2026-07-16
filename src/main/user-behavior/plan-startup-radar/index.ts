/**
 * Plan:创业雷达 Telegram Bot — UserBehavior 渐进式引入
 *
 * 渐进式引入计划（与 Plan:实验42 对齐）：
 * - Phase 1 (当前): 旁路输出不做决策 (passive_monitor)
 * - Phase 2: 作为建议源影响部分决策 (suggestion_source)
 * - Phase 3: 替换 UserBehavior 核心模块 (core_replacement)
 */

export { PlanStartupRadarPlugin } from './PlanStartupRadarPlugin'

export type {
  StartupRadarPhase,
  PlanStartupRadarConfig,
  RadarScanObservation,
  BehaviorRadarCorrelation,
  StartupRadarReport,
} from './types'

export {
  STARTUP_RADAR_PHASE_LABELS,
  DEFAULT_STARTUP_RADAR_CONFIG,
} from './types'
