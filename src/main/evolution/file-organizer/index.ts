/**
 * 自进化文件整理引擎 — 模块入口
 *
 * 基于进化系统的自适应文件整理模块。
 * Evolution 周期性扫描工作区文件并自动归类，
 * 同时根据用户行为（撤销移动、重新归类）实时调整规则。
 *
 * 语音辅助整理：
 * - FileOrganizationIntentExtractor: LLM 解析语音命令
 * - VoiceFileOrganizerBridge: ASR + 意图 + 文件整理桥接
 */

export { GenePool } from './GenePool'
export { FileScanner, fileScanner } from './FileScanner'
export { FeedbackTracker, feedbackTracker } from './FeedbackTracker'
export { FileOrganizerCollector } from './FileOrganizerCollector'
export { FileOrganizerExecutor } from './FileOrganizerExecutor'
export { FileOrganizationIntentExtractor } from './FileOrganizationIntentExtractor'
export { VoiceFileOrganizerBridge, voiceFileOrganizerBridge } from './VoiceFileOrganizerBridge'

// 构建时初始化基因池单例
export { genePool } from './GenePool'

export type {
  FileFeatures,
  OrganizerRule,
  RuleCondition,
  RuleAction,
  GenePoolData,
  FileMoveRecord,
  EvolutionConfig,
  ConditionType,
  ConditionOperator,
  ActionType,
} from './types'

export { DEFAULT_EVOLUTION_CONFIG, createDefaultRules } from './types'
