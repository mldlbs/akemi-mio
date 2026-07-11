/**
 * typehealth/index.ts — 类型健康模块导出
 */

export { DEFAULT_SCAN_CONFIG, getTargetCategories, LEARNING_TO_HEALTH_MAP } from './TypeHealthIssue'
export type {
  TypeHealthCategory,
  TypeHealthSeverity,
  TypeHealthIssue,
  TypeHealthScanConfig,
  TypeHealthSummary,
} from './TypeHealthIssue'

export { TypeHealthScanner, typeHealthScanner } from './TypeHealthScanner'
export { TypeHealthCollector } from './TypeHealthCollector'
export { TypeRefactorExecutor } from './TypeRefactorExecutor'
