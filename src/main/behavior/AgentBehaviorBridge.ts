/**
 * AgentBehaviorBridge — Agent ↔ UserBehavior 事件总线桥接层
 *
 * ── 职责 ──
 * 在 EventBus 之上添加 Schema 版本管理，确保：
 * 1. 所有 Agent→UserBehavior 事件携带 _schemaVersion 以便消费者兼容性判断
 * 2. 消费者接收事件前经过 Schema 版本校验/迁移
 * 3. Schema 演进可追溯、可兼容，生产者和消费者各自独立升级
 *
 * ── 事件流 ──
 *   Agent (emit) → AgentBehaviorBridge.emitAgentEvent()
 *     → EventBus 广播
 *     → AgentBehaviorBridge.onBehaviorEvent() → UserBehavior (version checked)
 *
 *   UserBehavior (emit) → AgentBehaviorBridge.emitBehaviorEvent()
 *     → EventBus 广播
 *     → AgentBehaviorBridge.onAgentEvent() → Agent (version checked)
 *
 * ── Schema 演进兼容 ──
 * - 新版本只能添加可选字段（向后兼容）
 * - 消费者按 _schemaVersion 解析载荷
 * - 未来版本（> 当前）记录警告后尝试透传
 * - 过时版本自动迁移（当前为恒等映射，后续扩展）
 */

import { eventBus, type EventName, type EventPayload, type Listener } from '../core/EventBus'
import {
  AGENT_BEHAVIOR_EVENT_SCHEMAS,
  getCurrentSchemaVersion,
  isSchemaVersionCompatible,
  migratePayload,
  logUnexpectedFields,
  getEventSource,
  type AgentBehaviorEventName,
  type EventSource,
} from './AgentBehaviorSchema'
import { log } from '../logger/Logger'

// ══════════════════════════════════════════════════════════════
//  类型
// ══════════════════════════════════════════════════════════════

/** 桥接配置选项 */
export interface AgentBehaviorBridgeOptions {
  /** 是否记录 Schema 意外字段警告（默认 false，生产关闭） */
  logUnexpectedFields?: boolean
  /** 调试模式：记录每次 emit/subscribe 的 Schema 版本信息（默认 false） */
  debug?: boolean
}

/** Agent 可发射的 Agent↔UserBehavior 事件名 */
export type AgentProducedEvent = Extract<
  AgentBehaviorEventName,
  'agent.plan.created' | 'agent.plan.step' | 'agent.plan.completed'
  | 'agent.tool.invoked' | 'agent.tool.completed' | 'agent.tool.failed'
  | 'agent.state.changed' | 'agent.input.received'
  | 'agent.response.generated' | 'agent.error'
>

/** UserBehavior 可发射的 Agent↔UserBehavior 事件名 */
export type BehaviorProducedEvent = Extract<
  AgentBehaviorEventName,
  'behavior.state.updated' | 'behavior.mode.switch'
>

/** 所有受桥接管理的事件名 */
export type BridgeManagedEvent = AgentProducedEvent | BehaviorProducedEvent

// ══════════════════════════════════════════════════════════════
//  AgentBehaviorBridge
// ══════════════════════════════════════════════════════════════

export class AgentBehaviorBridge {
  private disposers: (() => void)[] = []
  private options: Required<AgentBehaviorBridgeOptions>

  constructor(options?: AgentBehaviorBridgeOptions) {
    this.options = {
      logUnexpectedFields: options?.logUnexpectedFields ?? false,
      debug: options?.debug ?? false,
    }
  }

  // ════════════════════════════
  //  发射（Producer 侧）
  // ════════════════════════════

  /**
   * Agent 端发射事件：自动注入 _schemaVersion 并广播到 EventBus。
   *
   * @param event   事件名（需在 AGENT_PRODUCED_EVENTS 中）
   * @param payload 事件载荷（不含 _schemaVersion，由桥接自动注入）
   */
  emitAgentEvent<E extends AgentProducedEvent & EventName>(
    event: E,
    payload: EventPayload[E],
  ): void {
    this.emitWithSchema(event, payload, 'agent')
  }

  /**
   * UserBehavior 端发射事件：自动注入 _schemaVersion 并广播到 EventBus。
   *
   * @param event   事件名（需在 BEHAVIOR_PRODUCED_EVENTS 中）
   * @param payload 事件载荷（不含 _schemaVersion，由桥接自动注入）
   */
  emitBehaviorEvent<E extends BehaviorProducedEvent & EventName>(
    event: E,
    payload: EventPayload[E],
  ): void {
    this.emitWithSchema(event, payload, 'user-behavior')
  }

  /**
   * 通用 Schema 化发射。
   * 为载荷注入当前版本的 _schemaVersion，然后通过 EventBus 广播。
   * 运行时验证事件源是否匹配，不匹配仅记录警告。
   */
  private emitWithSchema<E extends BridgeManagedEvent & EventName>(
    event: E,
    payload: EventPayload[E],
    expectedSource: EventSource,
  ): void {
    const source = getEventSource(event)
    if (source && source !== expectedSource) {
      log('WARN', 'agent_behavior_bridge_source_mismatch', {
        event,
        expected: expectedSource,
        actual: source,
      })
    }

    const version = getCurrentSchemaVersion(event)
    const schemaVersion = version ?? 1
    const versionedPayload = { ...payload, _schemaVersion: schemaVersion } as EventPayload[E]

    if (this.options.debug) {
      log('DEBUG', 'agent_behavior_bridge_emit', {
        event,
        source: expectedSource,
        schemaVersion,
      })
    }

    eventBus.emit(event, versionedPayload)
  }

  // ════════════════════════════
  //  订阅（Consumer 侧）
  // ════════════════════════════

  /**
   * 订阅 Agent 事件（供 UserBehavior 端消费）。
   * 自动进行 Schema 版本校验和迁移，确保消费者只收到兼容的载荷。
   *
   * @param event   事件名
   * @param handler 处理函数（收到已校验/迁移的载荷）
   * @param label   可选的订阅标签（用于 EventBus 诊断）
   * @returns disposer 函数
   */
  onAgentEvent<E extends AgentProducedEvent & EventName>(
    event: E,
    handler: Listener<E>,
    label?: string,
  ): () => void {
    return this.subscribeWithSchema(event, handler, label)
  }

  /**
   * 订阅 Behavior 事件（供 Agent 端消费）。
   * 自动进行 Schema 版本校验和迁移。
   *
   * @param event   事件名
   * @param handler 处理函数（收到已校验/迁移的载荷）
   * @param label   可选的订阅标签（用于 EventBus 诊断）
   * @returns disposer 函数
   */
  onBehaviorEvent<E extends BehaviorProducedEvent & EventName>(
    event: E,
    handler: Listener<E>,
    label?: string,
  ): () => void {
    return this.subscribeWithSchema(event, handler, label)
  }

  /**
   * 通用 Schema 化订阅。
   * 包装 EventBus.on，在回调中对载荷执行版本校验和迁移。
   *
   * - 无 _schemaVersion 的旧式载荷 → 视为 v1，兼容处理
   * - 未来版本（> 当前）→ 记录警告，尝试透传
   * - 过时版本 → 自动迁移（migratePayload）
   */
  private subscribeWithSchema<E extends BridgeManagedEvent & EventName>(
    event: E,
    handler: Listener<E>,
    label?: string,
  ): () => void {
    const wrappedHandler = (rawPayload: EventPayload[E]): void => {
      const payloadRecord = rawPayload as Record<string, unknown>
      const payloadVersion = (payloadRecord._schemaVersion as number | undefined) ?? 1

      // 版本兼容性检查
      if (!isSchemaVersionCompatible(event, payloadVersion)) {
        log('WARN', 'agent_behavior_bridge_incompatible', {
          event,
          payloadVersion,
          currentVersion: getCurrentSchemaVersion(event),
        })
        return
      }

      // 可选：记录意外字段
      if (this.options.logUnexpectedFields) {
        logUnexpectedFields(event, payloadRecord, Object.keys(payloadRecord))
      }

      // Schema 迁移（当前为恒等映射，后续版本演进时扩展）
      const migrated = migratePayload(event, payloadRecord)

      if (this.options.debug) {
        log('DEBUG', 'agent_behavior_bridge_deliver', {
          event,
          schemaVersion: payloadVersion,
          migrated: payloadVersion !== (migrated._schemaVersion as number | undefined),
        })
      }

      handler(migrated as EventPayload[E])
    }

    const disposer = eventBus.on(event, wrappedHandler, { label: label ?? `bridge:${event}` })
    this.disposers.push(disposer)
    return disposer
  }

  // ════════════════════════════
  //  生命周期
  // ════════════════════════════

  /** 停止所有通过此桥接注册的订阅 */
  dispose(): void {
    for (const d of this.disposers) {
      try {
        d()
      } catch {
        // 静默处理单个清理异常
      }
    }
    this.disposers = []
  }

  /** 获取当前活跃订阅数 */
  get subscriptionCount(): number {
    return this.disposers.length
  }
}

// ══════════════════════════════════════════════════════════════
//  单例
// ══════════════════════════════════════════════════════════════

/**
 * 全局 AgentBehaviorBridge 单例。
 * 应用启动时创建，通过 dispose() 在关闭时清理。
 */
export const agentBehaviorBridge = new AgentBehaviorBridge()
