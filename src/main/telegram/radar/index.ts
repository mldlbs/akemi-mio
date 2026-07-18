/**
 * 雷达推送规则管理 — 模块入口
 *
 * ## 使用方式
 *
 * ```typescript
 * import { radarPushRuleStore, radarPushScheduler, radarNaturalLanguageParser } from './telegram/radar'
 *
 * // 初始化存储
 * radarPushRuleStore.initialize()
 *
 * // 启动调度器
 * radarPushScheduler.start()
 *
 * // 解析用户输入
 * const intent = radarNaturalLanguageParser.parse('每天上午8点 北京 AI创业')
 * ```
 *
 * ## 文件清单
 *
 * - types.ts              — 数据类型定义
 * - RadarPushRuleStore.ts — SQLite 持久化 CRUD
 * - RadarNaturalLanguageParser.ts — 自然语言时间解析
 * - RadarPushScheduler.ts — 定时检查 + 触发推送
 */

export { RadarPushRuleStore, radarPushRuleStore } from './RadarPushRuleStore'
export { RadarNaturalLanguageParser, radarNaturalLanguageParser } from './RadarNaturalLanguageParser'
export { RadarPushScheduler, radarPushScheduler } from './RadarPushScheduler'

export type {
  RadarPushRule,
  PushFrequency,
  PushPeriod,
  ParsedRuleIntent,
  PushRuleOperationResult,
  PushRuleListResult,
} from './types'

export { MAX_PUSH_RULES, PUSH_RULES_TABLE } from './types'
