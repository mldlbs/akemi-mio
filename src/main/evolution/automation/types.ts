/**
 * 自动化管道 — 核心类型
 *
 * 整个管道的契约定义。
 * 所有 Collector 实现该接口，ProblemQueue 消费 ProduceProblem，
 * Executor 消费 AssignedProblem。
 */

// ── 问题来源类型 ──
export type ProblemSource = 'tsc' | 'test' | 'lint' | 'log' | 'git' | 'runtime' | 'feature' | 'behavior' | 'tool' | 'tts' | 'file_organizer' | 'cicd' | 'memory' | 'agent' | 'blog' | 'evidence'

// ── 问题严重度 ──
export type Severity = 'error' | 'warning' | 'info'

// ── Evidence 问题类型 ──
export type EvidenceProblemType = 'critical_regression' | 'capability_regression' | 'performance' | 'info'

// ── 一个被检测到的具体问题 ──
export interface Problem {
  id: string
  source: ProblemSource
  severity: Severity
  title: string
  description: string
  file?: string
  line?: number
  /** 预估修复成本（字符数），用于排期 */
  estimatedCostChars: number
  /** 该问题最近一次出现时间戳 */
  lastSeen: number
  /** 出现次数（去重后的累计） */
  occurrenceCount: number
  /** 问题快照（足够让 Claude Code 理解和修复的上下文） */
  context: {
    /** 原始错误文本 */
    raw: string
    /** 文件内容片段（相关行） */
    snippet?: string
    /** 额外元数据 */
    metadata?: Record<string, string>
  }
  /** Evidence 专有：关联的 RegressionReport ID */
  evidenceRef?: string
  /** Evidence 专有：退化类型分类 */
  evidenceType?: EvidenceProblemType
  /** Evidence 专有：置信度 [0, 1] */
  confidence?: number
  /** Evidence 专有：受影响的 ThinkingPattern */
  affectedCapability?: string
}

// ── 分配给 Executor 的问题 ──
export interface AssignedProblem extends Problem {
  attempt: number
  assignedAt: number
}

// ── 执行结果 ──
export interface FixResult {
  problemId: string
  success: boolean
  summary: string
  durationMs: number
  /** 产生的 diff / commit hash */
  output?: string
  error?: string
}

// ── Collector 接口 ──
export interface SignalCollector {
  readonly name: string
  readonly source: ProblemSource
  /** 采集一次，返回发现的问题列表 */
  collect(): Promise<Problem[]>
  /** 采集器是否需要运行（跳过条件） */
  shouldRun(): boolean
}

// ── Executor 接口 ──
export interface FixExecutor {
  readonly name: string
  /** 执行一个问题的修复 */
  execute(problem: AssignedProblem): Promise<FixResult>
  /** 当前是否可用（不忙） */
  isAvailable(): boolean
  /** 支持的来源类型 */
  supportedSources: ProblemSource[]
  /** 单次执行超时 */
  timeoutMs: number
}

// ── Pipeline 统计 ──
export interface PipelineStats {
  totalCollected: number
  totalFixed: number
  totalFailed: number
  totalSkipped: number
  avgDurationMs: number
  lastRunAt: number
  bySource: Record<ProblemSource, { collected: number; fixed: number; failed: number }>
}

// ═══════════════════════════════════════════
//  推理链类型（ASR 引导 Plan 的中间步骤链）
// ═══════════════════════════════════════════

/** 推理链中单个步骤的状态 */
export type ReasoningStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'

/** 推理链中的单个中间步骤 */
export interface ReasoningStep {
  /** 步骤标识（格式: step_{index}_{timestamp}） */
  id: string
  /** 步骤序号（从 0 开始） */
  index: number
  /** 步骤描述 */
  description: string
  /** 步骤详细说明（executor 填充的上下文） */
  detail?: string
  /** 当前状态 */
  status: ReasoningStepStatus
  /** 执行结果文本 */
  result?: string
  /** 执行耗时（毫秒） */
  durationMs?: number
  /** 该步骤产生的输出（如补丁 ID、快照 ID） */
  output?: Record<string, string>
}

/** 完整的推理链（包含中间步骤集合） */
export interface ReasoningChain {
  /** 关联的问题 ID */
  problemId: string
  /** 推理链标题 */
  title: string
  /** 步骤列表 */
  steps: ReasoningStep[]
  /** 创建时间戳 */
  createdAt: number
  /** 完成时间戳 */
  completedAt?: number
  /** 最终结论摘要 */
  conclusion?: string
  /** 是否全部成功 */
  allSucceeded: boolean
}
