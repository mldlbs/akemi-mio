/**
 * CI/CD Orchestrator 类型定义
 *
 * 定义 Evolution 计划步骤与 MCP CI/CD 工具之间的映射契约。
 */

// ==============================================================================
// CI/CD 操作类型
// ==============================================================================

/** 支持的 CI/CD 操作枚举 */
export type CicdAction = 'typecheck' | 'lint' | 'test' | 'build' | 'build_docs' | 'deploy_preview' | 'quality_gate' | 'unknown'

// ==============================================================================
// 计划步骤映射
// ==============================================================================

/** 计划步骤到 CI/CD 操作的映射配置 */
export interface StepMapping {
  /** 匹配计划步骤描述的关键词列表 */
  keywords: string[]
  /** 对应 CI/CD 操作 */
  action: CicdAction
  /** 映射的 MCP 工具名 */
  toolName: string
  /** 操作描述 */
  description: string
}

// ==============================================================================
// 执行结果
// ==============================================================================

/** CI/CD 操作执行结果 */
export interface CicdStepResult {
  /** 原始计划步骤描述 */
  stepDescription: string
  /** 映射到的 CI/CD 操作 */
  action: CicdAction
  /** MCP 工具名 */
  toolName: string
  /** 执行是否成功（MCP 调用层面） */
  success: boolean
  /** 检查是否通过（与 success 不同：调用成功但检查可能不通过） */
  passed: boolean
  /** 可读摘要 */
  summary: string
  /** 原始 MCP 工具返回的 JSON */
  rawResult?: Record<string, any>
  /** 执行耗时 */
  durationMs: number
  /** 错误信息 */
  error?: string
}

/** 完整 CI/CD 周期的执行报告 */
export interface CicdCycleReport {
  /** 周期开始时间 */
  startedAt: number
  /** 周期结束时间 */
  completedAt: number
  /** 总耗时 */
  totalDurationMs: number
  /** 各步骤执行结果 */
  steps: CicdStepResult[]
  /** 是否全部通过 */
  allPassed: boolean
  /** 失败步骤列表 */
  failures: CicdStepResult[]
  /** 是否需要回滚 */
  needsRollback: boolean
}

// ==============================================================================
// 配置
// ==============================================================================

export interface CicdOrchestratorConfig {
  /** 是否在计划步骤执行前运行 quality_gate */
  runQualityGateBeforeSteps?: boolean
  /** quality_gate 权重：只有当类型检查通过后才执行后续步骤 */
  qualityGateRequired?: boolean
  /** 自动部署：如果所有步骤通过，是否执行 deploy_preview */
  autoDeployOnSuccess?: boolean
  /** 部署标签前缀 */
  deployTagPrefix?: string
  /** 最大并行检查数 */
  maxParallelChecks?: number
}
