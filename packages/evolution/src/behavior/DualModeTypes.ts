/**
 * DualModeTypes — 双模切换系统类型定义
 *
 * 定义 "UserBehavior" 和 "Plan:TypeScript 高级类型学习计划" 两种模式
 * 的接口、工作条件、状态快照和切换决策类型。
 */

import type { UserBehaviorState } from './UserBehaviorService'
import type { DevPlan } from '@akemi-mio/evolution/types'

// =============================================================================
// 模式标识
// =============================================================================

/** 支持的双模模式 */
export type ModeType = 'user-behavior' | 'plan-typescript'

/** 模式的可读名称 */
export const MODE_LABELS: Record<ModeType, string> = {
  'user-behavior': '用户行为模式',
  'plan-typescript': 'TypeScript 高级类型学习计划模式',
}

// =============================================================================
// 工作条件规格
// =============================================================================

/** 输入特征描述 */
export interface InputCharacteristics {
  /** 典型窗口类别分布（类别 → 期望占比） */
  appCategoryDistribution: Record<string, number>
  /** 典型交互频率范围（次/分钟） */
  interactionRateRange: [number, number]
  /** 典型空闲时间范围 ms */
  idleTimeRange: [number, number]
  /** 是否期望单一应用主导 */
  expectsSingleAppFocus: boolean
  /** 期望的行为模式 */
  expectedBehaviorMode: string
  /** 窗口标题关键词（为空则不检查） */
  titleKeywords: string[]
}

/** 负载范围 */
export interface LoadRange {
  /** 最小负载（交互/分钟） */
  minInteractionsPerMin: number
  /** 最大负载（交互/分钟） */
  maxInteractionsPerMin: number
  /** 推荐并发任务数 */
  recommendedConcurrency: number
}

/** 响应时间要求 */
export interface ResponseTimeRequirement {
  /** 状态更新最大延迟 ms */
  stateUpdateMaxMs: number
  /** 模式切换最大时间 ms */
  modeSwitchMaxMs: number
  /** 特性可用性目标（0-1） */
  availabilityTarget: number
}

/** 模式的最优工作条件描述 */
export interface ModeWorkingConditions {
  /** 输入特征 */
  inputCharacteristics: InputCharacteristics
  /** 负载范围 */
  loadRange: LoadRange
  /** 响应时间要求 */
  responseTime: ResponseTimeRequirement
  /** 自然语言描述：最佳使用场景 */
  bestWhenDescription: string
  /** 自然语言描述：不适合的场景 */
  notIdealWhenDescription: string
}

// =============================================================================
// 模式状态快照（用于切换时的保存/恢复）
// =============================================================================

/** 切换时保存的模式状态快照 */
export interface ModeStateSnapshot {
  /** 模式标识 */
  mode: ModeType
  /** 模式开始时间戳 */
  startedAt: number
  /** 快照创建时间 */
  savedAt: number
  /** 模式已持续时长 ms（保存时刻） */
  durationMs: number
  /** UserBehavior 状态快照（切换前冻结） */
  behaviorState: UserBehaviorState | null
  /** 当前活跃计划快照（Plan 模式时） */
  activePlan: {
    id: string
    title: string
    steps: Array<{ description: string; status: string }>
    priority?: number
  } | null
  /** 行为状态机内部阈值快照 */
  adaptiveThresholds: {
    idleThresholdMs: number
    focusThresholdMs: number
    multitaskingSwitchCount: number
  } | null
  /** 扩展元数据 */
  metadata: Record<string, unknown>
}

// =============================================================================
// 切换决策
// =============================================================================

/** 切换原因分类 */
export type SwitchReason =
  | 'plan_activated' // 类型学习计划被激活
  | 'plan_completed' // 计划完成
  | 'plan_abandoned' // 计划放弃
  | 'context_mismatch' // 当前上下文不再匹配模式条件
  | 'context_match' // 当前上下文匹配新模式条件
  | 'user_idle_too_long' // 用户长时间空闲
  | 'user_became_active' // 用户恢复活跃
  | 'threshold_adaptation' // 自适应阈值触发切换
  | 'focus_lost' // 失去专注上下文
  | 'manual_override' // 手动覆盖
  | 'startup' // 系统启动

/** 切换决策 */
export interface SwitchDecision {
  /** 当前模式 */
  fromMode: ModeType
  /** 目标模式 */
  toMode: ModeType
  /** 切换原因 */
  reason: SwitchReason
  /** 决策置信度 0-1 */
  confidence: number
  /** 触发条件的具体指标 */
  triggerMetrics: {
    activityState: string
    appCategory: string
    behaviorMode: string
    idleTimeMs: number
    interactionRate: number
    hasActivePlan: boolean
    planTitle?: string
  }
  /** 建议的切换延迟 ms（用于防抖） */
  debounceMs: number
}

// =============================================================================
// 模式规格全集
// =============================================================================

/** 双模模式的工作条件规格定义 */
export const MODE_SPECIFICATIONS: Record<ModeType, ModeWorkingConditions> = {
  'user-behavior': {
    inputCharacteristics: {
      appCategoryDistribution: {
        code: 0.3,
        browser: 0.3,
        communication: 0.2,
        media: 0.1,
        other: 0.1,
      },
      interactionRateRange: [5, 60],
      idleTimeRange: [0, 300_000],
      expectsSingleAppFocus: false,
      expectedBehaviorMode: 'multitasking',
      titleKeywords: [],
    },
    loadRange: {
      minInteractionsPerMin: 1,
      maxInteractionsPerMin: 60,
      recommendedConcurrency: 3,
    },
    responseTime: {
      stateUpdateMaxMs: 300,
      modeSwitchMaxMs: 500,
      availabilityTarget: 0.99,
    },
    bestWhenDescription: '用户正常多任务操作、切换窗口、浏览网页、通讯交互。行为状态机持续跟踪窗口类别和空闲状态，快速响应交互变化。',
    notIdealWhenDescription: '用户进行深度专注学习（如编码练习）时，频繁的状态更新可能造成干扰；在长空闲时段后恢复时可能有短暂的状态滞后。',
  },
  'plan-typescript': {
    inputCharacteristics: {
      appCategoryDistribution: {
        code: 0.7,
        browser: 0.2,
        communication: 0.05,
        media: 0.0,
        other: 0.05,
      },
      interactionRateRange: [1, 20],
      idleTimeRange: [10_000, 600_000],
      expectsSingleAppFocus: true,
      expectedBehaviorMode: 'focus',
      titleKeywords: [
        'typescript',
        'type',
        'ts',
        '.ts',
        '.tsx',
        '学习',
        'study',
        'tutorial',
        '高级类型',
        'conditional',
        'infer',
        'mapped',
        'template literal',
        'utility types',
      ],
    },
    loadRange: {
      minInteractionsPerMin: 0,
      maxInteractionsPerMin: 20,
      recommendedConcurrency: 1,
    },
    responseTime: {
      stateUpdateMaxMs: 1000,
      modeSwitchMaxMs: 200,
      availabilityTarget: 0.95,
    },
    bestWhenDescription:
      '用户在前台打开 TypeScript 文件或教程，行为模式为专注（focus），有活跃的 TypeScript 高级类型学习计划时，系统应降低打扰、延后非关键通知并加深学习资源推送的密度。',
    notIdealWhenDescription: '用户未在进行 TypeScript 相关工作时强制激活会导致上下文错配；多任务高负载期间不应切换到此模式。',
  },
}

// =============================================================================
// 事件负载类型
// =============================================================================

/** dual-mode 切换事件载荷 */
export interface DualModeSwitchEvent {
  fromMode: ModeType
  toMode: ModeType
  reason: SwitchReason
  confidence: number
  snapshot: ModeStateSnapshot | null
  timestamp: number
}
