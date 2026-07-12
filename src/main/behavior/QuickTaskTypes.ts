/**
 * QuickTaskTypes — 快捷任务类型定义
 *
 * 定义快捷任务（QuickTask）的数据结构，用于将高频行为模式
 * 打包为可一键执行/编辑的任务脚本（TaskScript）。
 *
 * 与 BehaviorSequenceLearner 的关系：
 * - BehaviorSequenceLearner 负责从 __behaviorToolRecords 提取 2-4 步序列
 * - QuickTaskService 在此基础上增加推荐、灵敏度控制、用户反馈等上层逻辑
 * - QuickTask 是面向用户的最终表现形式
 */

// =============================================================================
// 快捷任务定义
// =============================================================================

/** 快捷任务中的单个步骤 */
export interface QuickTaskStep {
  /** 工具名 */
  tool: string
  /** 步骤描述（中文，如 "打开邮箱"） */
  label: string
  /** 执行参数（可选） */
  args?: Record<string, unknown>
}

/** 快捷任务状态 */
export type QuickTaskStatus = 'pending' | 'active' | 'dismissed' | 'executed'

/** 快捷任务推荐级别 */
export type RecommendationLevel = 'suggested' | 'auto' | 'suppressed'

/**
 * QuickTask — 快捷任务
 *
 * 代表一个从用户行为中学习到的高频操作序列，
 * 打包为可一键执行的脚本。
 */
export interface QuickTask {
  /** 唯一 ID */
  id: string
  /** 任务标题（如 "晨间启动"） */
  title: string
  /** 任务描述 */
  description: string
  /** 执行步骤序列 */
  steps: QuickTaskStep[]
  /** 原始工具名序列（用于去重和溯源） */
  toolSequence: string[]
  /** 该序列在分析窗口内的出现次数 */
  frequency: number
  /** 置信度 0-1 */
  confidence: number
  /** 推荐级别 */
  recommendationLevel: RecommendationLevel
  /** 当前状态 */
  status: QuickTaskStatus
  /** 首次被推荐的时刻 */
  firstRecommendedAt: number
  /** 最近活跃时刻（最近一次模式出现） */
  lastActiveAt: number
  /** 被执行的次数（累计） */
  executionCount: number
  /** 被忽略/关闭的次数（累计） */
  dismissCount: number
}

// =============================================================================
// 快捷任务推荐状态
// =============================================================================

/** 用户对某个推荐的反饋 */
export interface QuickTaskFeedback {
  taskId: string
  action: 'executed' | 'dismissed' | 'edited' | 'snoozed'
  timestamp: number
}

// =============================================================================
// 服务配置
// =============================================================================

export interface QuickTaskConfig {
  /** 分析窗口大小（最近 N 次工具调用） */
  analysisWindow: number
  /** 最小序列长度 */
  minSequenceLength: number
  /** 最大序列长度 */
  maxSequenceLength: number
  /** 连续调用判定阈值（ms） */
  sequenceGapMs: number
  /** 高频序列最小出现次数 */
  minFrequency: number
  /** 灵敏读阈值（0-100），越高越容易推荐 */
  sensitivityThreshold: number
  /** 自动推荐间隔（ms），默认 30 分钟 */
  autoRecommendIntervalMs: number
  /** 同一个任务的最大推荐次数（超过后抑制） */
  maxRecommendationsPerTask: number
  /** 抑制周期（ms），被关闭后多久不再推荐 */
  suppressDurationMs: number
}

export const DEFAULT_QUICK_TASK_CONFIG: QuickTaskConfig = {
  analysisWindow: 106,
  minSequenceLength: 2,
  maxSequenceLength: 4,
  sequenceGapMs: 30_000,
  minFrequency: 3,
  sensitivityThreshold: 60,
  autoRecommendIntervalMs: 30 * 60 * 1000,
  maxRecommendationsPerTask: 5,
  suppressDurationMs: 7 * 24 * 60 * 60 * 1000, // 7 天
}

// =============================================================================
// 服务状态快照
// =============================================================================

export interface QuickTaskServiceSnapshot {
  totalTasksLearned: number
  activeRecommendations: number
  suppressedTasks: number
  totalExecuted: number
  sensitivityThreshold: number
  lastAnalysisAt: number | null
  activeTasks: QuickTask[]
  config: QuickTaskConfig
}

// =============================================================================
// IPC 事件载荷
// =============================================================================

/** quick_task:recommend IPC 事件载荷 */
export interface QuickTaskRecommendPayload {
  tasks: QuickTask[]
  timestamp: number
}

/** quick_task:update IPC 事件载荷 */
export interface QuickTaskUpdatePayload {
  task: QuickTask
  action: QuickTaskFeedback['action']
  timestamp: number
}
