/**
 * TtsCleanupDualModeTypes — TTS/Plan:清理工作区 双模切换类型定义
 *
 * 定义「TTS」和「Plan:清理工作区 - 整理文件目录」两种模式
 * 的接口、工作条件、状态快照和切换决策类型。
 *
 * TTS 模式：正常语音交互，系统以语音输出为主
 * Plan:清理工作区 模式：系统执行工作区整理/文件目录组织
 *
 * 架构模式：与 DualModeTypes（user-behavior ↔ plan-typescript）一致，
 * 但独立管理避免混合两种正交的双模系统。
 */

import type { WorkspaceStats } from '../workspace-cleanup/types'

// =============================================================================
// 模式标识
// =============================================================================

/** 支持的双模模式 */
export type TtsCleanupModeType =
  /** 正常 TTS 语音交互模式 */
  | 'tts'
  /** 工作区清理计划模式 */
  | 'plan-cleanup'

/** 模式的可读名称 */
export const TTS_CLEANUP_MODE_LABELS: Record<TtsCleanupModeType, string> = {
  'tts': 'TTS 语音交互模式',
  'plan-cleanup': '工作区清理计划模式',
}

// =============================================================================
// 工作条件规格
// =============================================================================

/** 输入特征描述 */
export interface CleanupInputCharacteristics {
  /** 用户活跃状态分布（active/idle/away → 期望占比） */
  activityStateDistribution: Record<string, number>
  /** 典型交互频率范围（次/分钟） */
  interactionRateRange: [number, number]
  /** 典型空闲时间范围 ms */
  idleTimeRange: [number, number]
  /** 文件杂度阈值（根目录松散文件数） */
  maxRootLevelFiles: number
  /** 空目录容忍上限 */
  maxEmptyDirs: number
  /** 是否需要有活跃对话 */
  expectsActiveConversation: boolean
  /** 是否允许后台文件操作 */
  allowsBackgroundFileOps: boolean
}

/** 负载范围 */
export interface CleanupLoadRange {
  /** 最小负载（交互/分钟） */
  minInteractionsPerMin: number
  /** 最大负载（交互/分钟） */
  maxInteractionsPerMin: number
  /** 推荐并发任务数 */
  recommendedConcurrency: number
  /** TTS 队列深度容忍上限 */
  maxTtsQueueDepth: number
}

/** 响应时间要求 */
export interface CleanupResponseTimeRequirement {
  /** 语音合成最大延迟 ms */
  ttsLatencyMaxMs: number
  /** 模式切换最大时间 ms */
  modeSwitchMaxMs: number
  /** 工作区扫描间隔 ms */
  scanIntervalMs: number
  /** 特性可用性目标（0-1） */
  availabilityTarget: number
}

/** 模式的最优工作条件描述 */
export interface TtsCleanupModeWorkingConditions {
  /** 输入特征 */
  inputCharacteristics: CleanupInputCharacteristics
  /** 负载范围 */
  loadRange: CleanupLoadRange
  /** 响应时间要求 */
  responseTime: CleanupResponseTimeRequirement
  /** 自然语言描述：最佳使用场景 */
  bestWhenDescription: string
  /** 自然语言描述：不适合的场景 */
  notIdealWhenDescription: string
}

// =============================================================================
// 模式状态快照（用于切换时的保存/恢复）
// =============================================================================

/** 切换时保存的模式状态快照 */
export interface TtsCleanupModeStateSnapshot {
  /** 模式标识 */
  mode: TtsCleanupModeType
  /** 模式开始时间戳 */
  startedAt: number
  /** 快照创建时间 */
  savedAt: number
  /** 模式已持续时长 ms（保存时刻） */
  durationMs: number
  /** 工作区统计快照 */
  workspaceStats: WorkspaceStats | null
  /** TTS 队列深度快照 */
  ttsQueueDepth: number
  /** 扩展元数据 */
  metadata: Record<string, unknown>
}

// =============================================================================
// 切换决策
// =============================================================================

/** 切换原因分类 */
export type TtsCleanupSwitchReason =
  /** 用户长时间空闲（>= 5min） */
  | 'user_idle_long'
  /** 用户恢复活跃 */
  | 'user_became_active'
  /** 文件杂度超过阈值 */
  | 'file_clutter_high'
  /** 工作区整理完成 */
  | 'cleanup_completed'
  /** 有新对话开始 */
  | 'conversation_started'
  /** TTS 队列过深 */
  | 'tts_queue_deep'
  /** 手动覆盖 */
  | 'manual_override'
  /** 系统启动 */
  | 'startup'
  /** 文件系统状态变化 */
  | 'filesystem_change'

/** 切换决策 */
export interface TtsCleanupSwitchDecision {
  /** 当前模式 */
  fromMode: TtsCleanupModeType
  /** 目标模式 */
  toMode: TtsCleanupModeType
  /** 切换原因 */
  reason: TtsCleanupSwitchReason
  /** 决策置信度 0-1 */
  confidence: number
  /** 触发条件的具体指标 */
  triggerMetrics: {
    /** 用户活跃状态 */
    activityState: string
    /** 空闲时长 ms */
    idleTimeMs: number
    /** 最近交互频率（次/分钟） */
    interactionRate: number
    /** 根目录松散文件数 */
    rootLevelFileCount: number
    /** 空目录数 */
    emptyDirCount: number
    /** 总文件数 */
    totalFileCount: number
    /** TTS 队列深度 */
    ttsQueueDepth: number
  }
  /** 建议的切换延迟 ms（用于防抖） */
  debounceMs: number
}

// =============================================================================
// 模式规格全集
// =============================================================================

/** 双模模式的工作条件规格定义 */
export const TTS_CLEANUP_MODE_SPECIFICATIONS: Record<TtsCleanupModeType, TtsCleanupModeWorkingConditions> = {
  'tts': {
    inputCharacteristics: {
      activityStateDistribution: {
        active: 0.7,
        idle: 0.25,
        away: 0.05,
      },
      interactionRateRange: [5, 60],
      idleTimeRange: [0, 300_000],
      maxRootLevelFiles: 10,
      maxEmptyDirs: 5,
      expectsActiveConversation: true,
      allowsBackgroundFileOps: false,
    },
    loadRange: {
      minInteractionsPerMin: 1,
      maxInteractionsPerMin: 60,
      recommendedConcurrency: 1,
      maxTtsQueueDepth: 10,
    },
    responseTime: {
      ttsLatencyMaxMs: 500,
      modeSwitchMaxMs: 300,
      scanIntervalMs: 60_000,
      availabilityTarget: 0.99,
    },
    bestWhenDescription:
      '用户活跃交谈、工作区相对整洁时，TTS 模式提供低延迟、高质量的语音反馈，适合日常持续交互。',
    notIdealWhenDescription:
      '工作区大量松散文件或用户长时间离开时，TTS 模式不会利用空闲时间进行文件整理；高负载文件操作期间 TTS 延迟可能升高。',
  },
  'plan-cleanup': {
    inputCharacteristics: {
      activityStateDistribution: {
        active: 0.1,
        idle: 0.5,
        away: 0.4,
      },
      interactionRateRange: [0, 5],
      idleTimeRange: [300_000, 3_600_000],
      maxRootLevelFiles: 3,
      maxEmptyDirs: 2,
      expectsActiveConversation: false,
      allowsBackgroundFileOps: true,
    },
    loadRange: {
      minInteractionsPerMin: 0,
      maxInteractionsPerMin: 5,
      recommendedConcurrency: 1,
      maxTtsQueueDepth: 0,
    },
    responseTime: {
      ttsLatencyMaxMs: 3000,
      modeSwitchMaxMs: 500,
      scanIntervalMs: 30_000,
      availabilityTarget: 0.95,
    },
    bestWhenDescription:
      '用户离开或长时间空闲、工作区松散文件和空目录较多时，Plan:清理工作区模式自动执行文件整理和目录组织，利用空闲时间维护工作区整洁。',
    notIdealWhenDescription:
      '用户正在积极交互时不应执行文件清理操作，以免占用磁盘 I/O 影响 TTS 响应速度；文件清理完成后应自动切回 TTS 模式。',
  },
}

// =============================================================================
// 事件负载类型
// =============================================================================

/** TTS/Cleanup 双模切换事件载荷 */
export interface TtsCleanupDualModeSwitchEvent {
  fromMode: TtsCleanupModeType
  toMode: TtsCleanupModeType
  reason: TtsCleanupSwitchReason
  confidence: number
  snapshot: TtsCleanupModeStateSnapshot | null
  timestamp: number
}
