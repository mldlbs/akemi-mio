/**
 * AgentBehaviorSchema — Agent ↔ UserBehavior 事件合同
 *
 * ── 设计哲学 ──
 * Agent 和 UserBehavior 通过标准化的、带版本号的事件 Schema 通信，
 * 各自独立演进但保持向后兼容。
 *
 * 生产者（Agent）产出事件时附带 schemaVersion，
 * 消费者（UserBehavior）按版本号处理载荷。
 *
 * ── Schema 演进规则 ──
 * 1. 向后兼容：新版本只能添加可选字段，不能删除/重命名现有字段
 * 2. 版本递增：新增可选字段 → 递增 major；新增必需字段 → 需同时调整所有消费者
 * 3. 弃用字段：标记为 @deprecated，至少保留一个 major 版本
 * 4. 消费者应当按当前声明的 schemaVersion 检查载荷，未知字段应透传
 *
 * ── 事件分类 ──
 * Agent → UserBehavior（Agent 产生，UserBehavior 消费）:
 *   - agent.plan.created:     计划创建
 *   - agent.plan.step:        计划步骤变更
 *   - agent.plan.completed:   计划完成
 *   - agent.tool.invoked:     工具调用开始
 *   - agent.tool.completed:   工具调用完成
 *   - agent.tool.failed:      工具调用失败
 *   - agent.state.changed:    Agent 状态变更（pause/resume/error）
 *   - agent.input.received:   收到用户输入
 *   - agent.response.generated: 生成回复
 *
 * UserBehavior → Agent（UserBehavior 产生，Agent 消费）:
 *   - behavior.state.updated: 行为状态更新
 *   - behavior.mode.switch:   双模切换事件
 */

import { log } from '../logger/Logger'

// ══════════════════════════════════════════════════════════════
//  Schema 版本定义
// ══════════════════════════════════════════════════════════════

/** Agent→UserBehavior 事件 Schema 版本注册表 */
export const AGENT_EVENT_SCHEMAS = {
  'agent.plan.created': { version: 1 },
  'agent.plan.step': { version: 1 },
  'agent.plan.completed': { version: 1 },
  'agent.tool.invoked': { version: 1 },
  'agent.tool.completed': { version: 1 },
  'agent.tool.failed': { version: 1 },
  'agent.state.changed': { version: 1 },
  'agent.input.received': { version: 1 },
  'agent.response.generated': { version: 1 },
  'agent.error': { version: 1 },
} as const

/** UserBehavior→Agent 事件 Schema 版本注册表 */
export const BEHAVIOR_EVENT_SCHEMAS = {
  'behavior.state.updated': { version: 1 },
  'behavior.mode.switch': { version: 1 },
} as const

/** 所有 Agent↔UserBehavior 事件的 Schema 版本注册表 */
export const AGENT_BEHAVIOR_EVENT_SCHEMAS = {
  ...AGENT_EVENT_SCHEMAS,
  ...BEHAVIOR_EVENT_SCHEMAS,
} as const

/** Agent↔UserBehavior 事件名称联合类型 */
export type AgentBehaviorEventName = keyof typeof AGENT_BEHAVIOR_EVENT_SCHEMAS

/** Schema 版本信息 */
export interface SchemaVersion {
  major: number
}

// ══════════════════════════════════════════════════════════════
//  版本化事件载荷基类型
// ══════════════════════════════════════════════════════════════

/**
 * 所有 Agent↔UserBehavior 事件的基类型。
 * 每个事件载荷应包含 _schemaVersion 字段以便消费者判断格式。
 */
export interface VersionedEventPayload {
  /** Schema 版本号，消费者据此判断载荷格式 */
  _schemaVersion: number
}

// ══════════════════════════════════════════════════════════════
//  Agent 事件载荷定义（含版本号）
// ══════════════════════════════════════════════════════════════

/**
 * agent.state.changed 载荷 (v1)
 *
 * Agent 生命周期状态变更时触发。
 * 消费者（UserBehavior）可根据状态调整行为策略：
 * - paused:   Agent 暂停 → UserBehavior 可进入低功耗监测模式
 * - resumed:  Agent 恢复 → UserBehavior 恢复正常行为跟踪
 * - error:    Agent 出错 → UserBehavior 可触发降级策略
 * - busy:     Agent 忙 → UserBehavior 可推迟非关键行为
 * - idle:     Agent 空闲 → UserBehavior 可执行周期性维护
 */
export interface AgentStateChangedPayloadV1 extends VersionedEventPayload {
  _schemaVersion: 1
  /** 新状态 */
  state: 'paused' | 'resumed' | 'error' | 'busy' | 'idle'
  /** 前一个状态 */
  previousState?: string
  /** 状态变更原因 */
  reason?: string
  /** 时间戳 */
  timestamp: number
}

/** 当前 agent.state.changed 载荷类型 */
export type AgentStateChangedPayload = AgentStateChangedPayloadV1

// ══════════════════════════════════════════════════════════════
//  UserBehavior 事件载荷定义（含版本号）
// ══════════════════════════════════════════════════════════════

/**
 * behavior.state.updated 载荷 (v1)
 *
 * UserBehaviorService 在行为状态（活动/空闲/离开）或环境状态
 * （全屏/聚焦/应用类别）变化时触发。
 *
 * 消费者（Agent/ChatExecutor）可据此调整 TTS/回复策略。
 */
export interface BehaviorStateUpdatedPayloadV1 extends VersionedEventPayload {
  _schemaVersion: 1
  /** 活动状态 */
  activityState: 'active' | 'idle' | 'away'
  /** 是否全屏 */
  fullscreen: boolean
  /** 窗口是否聚焦 */
  focused: boolean
  /** 前台应用类别 */
  appCategory: 'code' | 'browser' | 'media' | 'communication' | 'other'
  /** 前台窗口标题 */
  windowTitle: string
  /** 空闲时长 ms */
  idleTimeMs: number
}

/** 当前 behavior.state.updated 载荷类型 */
export type BehaviorStateUpdatedPayload = BehaviorStateUpdatedPayloadV1

/**
 * behavior.mode.switch 载荷 (v1)
 *
 * DualModeController 在 user-behavior ↔ plan-typescript 模式切换时触发。
 *
 * 消费者（Agent）可据此调整上下文或通知策略。
 */
export interface BehaviorModeSwitchPayloadV1 extends VersionedEventPayload {
  _schemaVersion: 1
  /** 来源模式 */
  fromMode: 'user-behavior' | 'plan-typescript'
  /** 目标模式 */
  toMode: 'user-behavior' | 'plan-typescript'
  /** 切换原因 */
  reason: string
  /** 切换置信度 */
  confidence: number
  /** 时间戳 */
  timestamp: number
}

/** 当前 behavior.mode.switch 载荷类型 */
export type BehaviorModeSwitchPayload = BehaviorModeSwitchPayloadV1

// ══════════════════════════════════════════════════════════════
//  Schema 验证
// ══════════════════════════════════════════════════════════════

/** 获取事件当前的 Schema 版本 */
export function getCurrentSchemaVersion(event: AgentBehaviorEventName): number {
  return AGENT_BEHAVIOR_EVENT_SCHEMAS[event]?.version ?? 1
}

/**
 * 验证载荷的 Schema 版本是否被当前系统支持。
 * 未知版本（高于当前版本）视为兼容，仅记录警告。
 * 过时版本视为兼容（自动迁移）。
 */
export function isSchemaVersionCompatible(
  event: string,
  payloadVersion: number | undefined,
): boolean {
  const currentVersion = getCurrentSchemaVersion(event as AgentBehaviorEventName)
  // 无版本号 → 旧格式，视为 v1
  if (payloadVersion === undefined || payloadVersion === null) {
    return true
  }
  // 未来版本（> currentVersion）→ 记录警告，尝试兼容
  if (payloadVersion > currentVersion) {
    log('WARN', 'agent_behavior_schema_future_version', {
      event,
      payloadVersion,
      currentVersion,
      hint: '未知字段将被忽略，请考虑升级消费者',
    })
    return true
  }
  // 过时版本 → 兼容
  if (payloadVersion < currentVersion) {
    log('INFO', 'agent_behavior_schema_old_version', {
      event,
      payloadVersion,
      currentVersion,
      hint: '旧版本格式，尝试自动迁移',
    })
    return true
  }
  return true
}

/**
 * 迁移载荷到当前 Schema 版本。
 * 当前仅处理 v1→v1（恒等映射），后续演进时在此扩展。
 */
export function migratePayload<E extends AgentBehaviorEventName>(
  event: E,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const currentVersion = getCurrentSchemaVersion(event)
  const payloadVersion = (payload._schemaVersion as number) ?? 1

  if (payloadVersion === currentVersion) {
    return payload
  }

  // 未来版本 → 尝试透传
  if (payloadVersion > currentVersion) {
    return payload
  }

  // 旧版本迁移（按 event 类型）
  // 当前所有事件均为 v1，后续演进在此扩展
  // 例如:
  //   if (event === 'behavior.state.updated' && payloadVersion === 1 && currentVersion === 2) {
  //     return { ...payload, _schemaVersion: 2, newField: undefined }
  //   }

  return payload
}

/**
 * 记录 Schema 意外变更警告。
 * 在消费者订阅事件时调用，用于在调试模式下追踪非预期字段。
 */
export function logUnexpectedFields(
  event: string,
  payload: Record<string, unknown>,
  expectedFields: string[],
): void {
  const actualFields = Object.keys(payload)
  const unexpected = actualFields.filter(
    (f) => !expectedFields.includes(f) && f !== '_schemaVersion',
  )
  if (unexpected.length > 0) {
    log('DEBUG', 'agent_behavior_unexpected_fields', {
      event,
      unexpected,
      expectedCount: expectedFields.length,
      actualCount: actualFields.length,
    })
  }
}

// ══════════════════════════════════════════════════════════════
//  事件源标记
// ══════════════════════════════════════════════════════════════

/** 标记事件的生产者是 Agent 还是 UserBehavior */
export type EventSource = 'agent' | 'user-behavior'

/** Agent 产生的事件列表 */
export const AGENT_PRODUCED_EVENTS: ReadonlySet<string> = new Set([
  'agent.plan.created',
  'agent.plan.step',
  'agent.plan.completed',
  'agent.tool.invoked',
  'agent.tool.completed',
  'agent.tool.failed',
  'agent.state.changed',
  'agent.input.received',
  'agent.response.generated',
  'agent.error',
])

/** UserBehavior 产生的事件列表 */
export const BEHAVIOR_PRODUCED_EVENTS: ReadonlySet<string> = new Set([
  'behavior.state.updated',
  'behavior.mode.switch',
])

/** 获取事件的生产者 */
export function getEventSource(event: string): EventSource | null {
  if (AGENT_PRODUCED_EVENTS.has(event)) return 'agent'
  if (BEHAVIOR_PRODUCED_EVENTS.has(event)) return 'user-behavior'
  return null
}
