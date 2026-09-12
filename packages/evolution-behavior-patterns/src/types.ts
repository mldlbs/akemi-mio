/**
 * Behavior Pattern Tool Chain Pre-orchestration — 类型定义
 *
 * ## 体系说明
 * 本模块通过挖掘用户工具调用序列中的频繁模式，实现智能预编排：
 * 1. PatternMiner — PrefixSpan 算法挖掘频繁序列
 * 2. BehaviorPatternStore — 模式存储与管理
 * 3. PreOrchestrationEngine — 上下文匹配、预编排、确认执行
 *
 * @module behavior
 */

// ══════════════════════════════════════════
//  核心模式定义
// ══════════════════════════════════════════

/** 模式中单步的工具调用 */
export interface PatternStep {
  /** 工具名称 */
  toolName: string
  /**
   * 参数模板：支持两种格式
   * - 字面值 `"fixed-value"` — 直接使用
   * - 变量引用 `"${varName}"` — 从当前上下文提取
   * - 模板字符串 `"prefix-${varName}-suffix"` — 插值填充
   */
  paramTemplate: Record<string, string>
  /** 该步骤的意图说明（用于用户确认展示） */
  description: string
  /** 该步骤是否可跳过 */
  optional: boolean
}

/** 挖掘出的行为模式 */
export interface BehaviorPattern {
  /** 模式唯一标识 */
  id: string
  /** 模式名称（自动生成或用户编辑） */
  name: string
  /** 工具调用序列（有序） */
  steps: PatternStep[]
  /** 简化工具名序列（用于快速匹配，如 ["grep", "read_file", "edit_file"]） */
  toolSignature: string[]
  /** 该模式的触发工具（序列的第一个工具） */
  triggerTool: string
  /** 模式出现的频率 */
  frequency: number
  /** 支持度（出现次数 / 总窗口数） */
  support: number
  /** 置信度（模式完成后成功比例） */
  confidence: number
  /** 平均完成耗时（毫秒） */
  avgDurationMs: number
  /** 关联的意图分类标签 */
  associatedCategories: string[]
  /** 关联的关键词（用于上下文匹配） */
  associatedKeywords: string[]
  /** 是否启用预编排 */
  enabled: boolean
  /** 用户确认阈值：confidence 低于此值时需用户确认 */
  confirmationThreshold: number
  /** 模式创建时间 */
  createdAt: number
  /** 最后匹配时间 */
  lastMatchedAt: number
  /** 用户编辑的历史备注 */
  notes: string
}

// ══════════════════════════════════════════
//  匹配与编排
// ══════════════════════════════════════════

/** 上下文匹配结果 */
export interface PatternMatchResult {
  /** 匹配到的模式 */
  pattern: BehaviorPattern
  /** 匹配分数 (0-1) */
  score: number
  /** 匹配原因描述 */
  matchReason: string
  /** 从当前上下文提取的参数变量 */
  extractedVars: Record<string, string>
  /** 已匹配的步骤索引（当前已执行到的位置） */
  matchedStepIndex: number
  /** 剩余的待执行步骤 */
  remainingSteps: PatternStep[]
}

/** 预编排计划 */
export interface PreOrchestrationPlan {
  /** 计划唯一标识 */
  id: string
  /** 来源模式 */
  pattern: BehaviorPattern
  /** 匹配结果 */
  matchResult: PatternMatchResult
  /** 待执行的步骤（参数已预填充） */
  pendingSteps: ResolvedStep[]
  /** 计划创建时间 */
  createdAt: number
  /** 计划状态 */
  status: 'pending_confirmation' | 'confirmed' | 'executing' | 'completed' | 'cancelled' | 'failed'
  /** 执行历史 */
  executionLog: ExecutionEntry[]
}

/** 参数已解析的待执行步骤 */
export interface ResolvedStep {
  /** 步骤在模式中的索引 */
  stepIndex: number
  /** 工具名称 */
  toolName: string
  /** 已解析的参数（变量替换后） */
  resolvedArgs: Record<string, any>
  /** 当前步骤状态 */
  status: 'pending' | 'running' | 'success' | 'skipped' | 'failed'
  /** 执行结果 */
  result?: string
  /** 耗时 */
  durationMs?: number
  /** 错误信息 */
  error?: string
}

/** 执行记录条目 */
export interface ExecutionEntry {
  stepIndex: number
  toolName: string
  status: ResolvedStep['status']
  durationMs: number
  timestamp: number
  result?: string
  error?: string
}

// ══════════════════════════════════════════
//  挖掘相关
// ══════════════════════════════════════════

/** PrefixSpan 挖掘配置 */
export interface MiningConfig {
  /** 最小支持度阈值（绝对次数） */
  minSupport: number
  /** 最大模式长度 */
  maxPatternLength: number
  /** 挖掘窗口：最多读取近 N 条记录 */
  windowSize: number
  /** 最小置信度 */
  minConfidence: number
  /** 挖掘间隔（毫秒） */
  miningIntervalMs: number
}

/** 挖掘结果汇总 */
export interface MiningResult {
  /** 挖掘出的新模式数 */
  newPatterns: number
  /** 更新的已有模式数 */
  updatedPatterns: number
  /** 总模式数 */
  totalPatterns: number
  /** 处理的总记录数 */
  processedRecords: number
  /** 挖掘耗时（毫秒） */
  durationMs: number
  /** 挖掘时间 */
  minedAt: number
}

/** 日志中单条工具调用记录（供 PrefixSpan 消费的简化格式） */
export interface ToolCallLogEntry {
  /** 会话/链 ID（用于区分不同用户意图） */
  sessionId: string
  /** 工具名 */
  toolName: string
  /** 调用参数 */
  args: Record<string, any>
  /** 是否成功 */
  success: boolean
  /** 耗时 */
  durationMs: number
  /** 时间戳 */
  timestamp: number
}

// ══════════════════════════════════════════
//  默认配置
// ══════════════════════════════════════════

export const DEFAULT_MINING_CONFIG: MiningConfig = {
  minSupport: 3,
  maxPatternLength: 6,
  windowSize: 2000,
  minConfidence: 0.5,
  miningIntervalMs: 30 * 60 * 1000, // 30 分钟
}

export const DEFAULT_CONFIRMATION_THRESHOLD = 0.7

export const STORAGE_PATH = '.claude/behavior_patterns.json'
