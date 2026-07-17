/**
 * 自进化合并引擎 — 类型定义
 *
 * 用于自动化 radar-bot 到 telegram-bot 的合并过程。
 * 遵循现有 SignalCollector / FixExecutor 契约。
 */

// ═══════════════════════════════════════════
// 合并缺口类型
// ═══════════════════════════════════════════

/** 合并缺口分类 */
export type MergeGapType =
  | 'route_missing'         // 路由表中缺少分类入口
  | 'event_handler_missing' // 缺少事件订阅处理
  | 'periodic_task_missing' // 缺少定时扫描任务
  | 'function_integration'  // 函数调用未集成
  | 'type_alignment'        // 类型定义不匹配
  | 'safety_check_missing'  // 缺少安全检查（timeout/res.ok 等）
  | 'dependency_missing'    // 缺少必要依赖

/** 源模块类型 */
export type SourceModule = 'startup-radar' | 'radar-tools' | 'radar-memory' | 'telegram-service' | 'outbox-worker' | 'message-gateway'

/** 扫描到的函数/能力点 */
export interface ScannedFunction {
  name: string
  module: SourceModule
  file: string
  line: number
  description: string
  category: 'fetch' | 'format' | 'push' | 'analyze' | 'route' | 'event' | 'schedule'
  dependencies: string[]
  alreadyIntegrated: boolean
}

/** 合并缺口 */
export interface MergeGap {
  id: string
  type: MergeGapType
  description: string
  sourceModule: SourceModule
  targetFile: string
  priority: number // 1-5, 5=最高
  estimatedChanges: string[]
  context: string
}

// ═══════════════════════════════════════════
// 合并计划
// ═══════════════════════════════════════════

export type MergePlanStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'no_gaps'

export interface MergePlan {
  id: string
  gaps: MergeGap[]
  createdAt: number
  status: MergePlanStatus
  summary: string
}

// ═══════════════════════════════════════════
// 扫描结果
// ═══════════════════════════════════════════

export interface MergeScanResult {
  scannedFunctions: ScannedFunction[]
  gaps: MergeGap[]
  scanTimestamp: number
  sourceModules: SourceModule[]
  integrationScore: number // 0-100, 越高表示越已集成
}

// ═══════════════════════════════════════════
// 补丁执行状态
// ═══════════════════════════════════════════

export type PatchStatus = 'pending' | 'applied' | 'verified' | 'rollback' | 'failed'

export interface MergePatch {
  gapId: string
  targetFile: string
  patchContent: string
  description: string
  status: PatchStatus
  verifiedAt?: number
  commitHash?: string
}

// ═══════════════════════════════════════════
// 安全扫描结果
// ═══════════════════════════════════════════

export type SecuritySeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export interface SecurityFinding {
  type: string
  severity: SecuritySeverity
  description: string
  file: string
  line?: number
  recommendation: string
}

export interface SecurityScanResult {
  passed: boolean
  findings: SecurityFinding[]
  criticalCount: number
  highCount: number
}

// ═══════════════════════════════════════════
// 合并引擎状态
// ═══════════════════════════════════════════

export interface MergeEngineStatus {
  lastScanAt: number
  lastMergeAt: number
  totalGapsFound: number
  totalGapsFixed: number
  totalGapsFailed: number
  currentPlan: MergePlan | null
  isRunning: boolean
}
