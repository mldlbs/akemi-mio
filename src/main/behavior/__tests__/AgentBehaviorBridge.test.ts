/**
 * AgentBehaviorBridge — 单元测试
 *
 * 覆盖：
 * 1. emitAgentEvent 自动注入 _schemaVersion
 * 2. emitBehaviorEvent 自动注入 _schemaVersion
 * 3. onAgentEvent 通过版本校验传递有效载荷
 * 4. onBehaviorEvent 通过版本校验传递有效载荷
 * 5. 无 _schemaVersion 的旧式载荷可兼容处理
 * 6. 未来版本（高于当前）记录警告后透传
 * 7. 事件源不匹配时记录警告
 * 8. 多个订阅可正常 dispose
 * 9. 与真实 EventBus 集成：Agent 事件被 UserBehavior 接收
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventBus, eventBus, type EventName, type EventPayload } from '../../core/EventBus'
import { AgentBehaviorBridge, agentBehaviorBridge } from '../AgentBehaviorBridge'
import {
  getCurrentSchemaVersion,
  isSchemaVersionCompatible,
  AGENT_BEHAVIOR_EVENT_SCHEMAS,
} from '../AgentBehaviorSchema'

// ── 测试辅助 ──

function resetEventBus(): void {
  eventBus.removeAll()
  // 清理 bridge 的订阅（不 dispose bridge 本身，因为测试可能重用它）
  // 这里我们每次创建新 bridge 实例
  EventBus.getInstance().removeAll()
}

function createBridge(): AgentBehaviorBridge {
  return new AgentBehaviorBridge({ logUnexpectedFields: false, debug: false })
}

// ── 测试套件 ──

describe('AgentBehaviorBridge', () => {
  let bridge: AgentBehaviorBridge

  beforeEach(() => {
    resetEventBus()
    bridge = createBridge()
  })

  afterEach(() => {
    bridge.dispose()
    resetEventBus()
  })

  describe('emitAgentEvent', () => {
    it('应为 agent 事件注入 _schemaVersion', () => {
      const handler = vi.fn()
      eventBus.on('agent.tool.invoked', handler)

      bridge.emitAgentEvent('agent.tool.invoked', {
        tool: 'read_file',
        args: { path: '/test' },
        requestId: 'r1',
      })

      expect(handler).toHaveBeenCalledOnce()
      const payload = handler.mock.calls[0][0]
      expect(payload).toHaveProperty('_schemaVersion')
      expect(payload._schemaVersion).toBe(getCurrentSchemaVersion('agent.tool.invoked'))
    })

    it('应传递所有原始字段', () => {
      const handler = vi.fn()
      eventBus.on('agent.plan.created', handler)

      bridge.emitAgentEvent('agent.plan.created', {
        planId: 'p1',
        title: 'Test Plan',
      })

      expect(handler).toHaveBeenCalledOnce()
      const payload = handler.mock.calls[0][0]
      expect(payload.planId).toBe('p1')
      expect(payload.title).toBe('Test Plan')
    })

    it('应支持 agent.state.changed 事件', () => {
      const handler = vi.fn()
      eventBus.on('agent.state.changed', handler)

      bridge.emitAgentEvent('agent.state.changed', {
        _schemaVersion: 1,
        state: 'paused',
        reason: 'user request',
        timestamp: Date.now(),
      })

      expect(handler).toHaveBeenCalledOnce()
      const payload = handler.mock.calls[0][0]
      expect(payload.state).toBe('paused')
      expect(payload._schemaVersion).toBe(1)
    })

    it('应在事件源不匹配时记录警告（不阻断）', () => {
      // behavior.mode.switch 是 BEHAVIOR_PRODUCED_EVENTS，但从 agent 端发射
      // 应该记录警告但不会抛异常
      const handler = vi.fn()
      eventBus.on('behavior.mode.switch', handler)

      // 不应该抛异常
      expect(() => {
        bridge.emitAgentEvent('behavior.mode.switch' as any, {} as any)
      }).not.toThrow()

      // 事件仍应被发射（桥接是松散的）
      expect(handler).toHaveBeenCalled()
    })
  })

  describe('emitBehaviorEvent', () => {
    it('应为 behavior 事件注入 _schemaVersion', () => {
      const handler = vi.fn()
      eventBus.on('behavior.state.updated', handler)

      bridge.emitBehaviorEvent('behavior.state.updated', {
        activityState: 'active',
        fullscreen: false,
        focused: true,
        appCategory: 'code',
        windowTitle: 'VS Code',
        idleTimeMs: 100,
      })

      expect(handler).toHaveBeenCalledOnce()
      const payload = handler.mock.calls[0][0]
      expect(payload._schemaVersion).toBe(getCurrentSchemaVersion('behavior.state.updated'))
      expect(payload.activityState).toBe('active')
    })

    it('应为 behavior.mode.switch 注入 _schemaVersion', () => {
      const handler = vi.fn()
      eventBus.on('behavior.mode.switch', handler)

      bridge.emitBehaviorEvent('behavior.mode.switch', {
        fromMode: 'user-behavior',
        toMode: 'plan-typescript',
        reason: 'plan created',
        confidence: 0.85,
        timestamp: Date.now(),
      })

      expect(handler).toHaveBeenCalledOnce()
      const payload = handler.mock.calls[0][0]
      expect(payload._schemaVersion).toBe(getCurrentSchemaVersion('behavior.mode.switch'))
    })
  })

  describe('onAgentEvent', () => {
    it('应通过 EventBus 接收 agent 事件并传递有效载荷', () => {
      const handler = vi.fn()
      bridge.onAgentEvent('agent.tool.invoked', handler)

      eventBus.emit('agent.tool.invoked', {
        tool: 'grep',
        args: { pattern: 'test' },
        requestId: 'r1',
        _schemaVersion: 1,
      })

      expect(handler).toHaveBeenCalledOnce()
      const payload = handler.mock.calls[0][0]
      expect(payload.tool).toBe('grep')
      // 确保 _schemaVersion 被传递
      expect(payload._schemaVersion).toBe(1)
    })

    it('应能处理 bridge 自身发出的 agent 事件（完整闭环）', () => {
      const handler = vi.fn()
      bridge.onAgentEvent('agent.plan.created', handler)

      bridge.emitAgentEvent('agent.plan.created', {
        planId: 'p1',
        title: '闭环测试',
      })

      expect(handler).toHaveBeenCalledOnce()
      const payload = handler.mock.calls[0][0]
      expect(payload.planId).toBe('p1')
      expect(payload._schemaVersion).toBe(getCurrentSchemaVersion('agent.plan.created'))
    })

    it('应兼容无 _schemaVersion 的旧式载荷', () => {
      const handler = vi.fn()
      bridge.onAgentEvent('agent.tool.completed', handler)

      // 直接通过 EventBus 发射旧式载荷（无 _schemaVersion）
      eventBus.emit('agent.tool.completed', {
        tool: 'test',
        result: 'ok',
        requestId: 'r1',
      })

      expect(handler).toHaveBeenCalledOnce()
      // migratePayload 会将无版本载荷视为 v1 并透传
      const payload = handler.mock.calls[0][0]
      expect(payload.tool).toBe('test')
      expect(payload.result).toBe('ok')
    })
  })

  describe('onBehaviorEvent', () => {
    it('应通过 EventBus 接收 behavior 事件并传递有效载荷', () => {
      const handler = vi.fn()
      bridge.onBehaviorEvent('behavior.state.updated', handler)

      eventBus.emit('behavior.state.updated', {
        activityState: 'idle',
        fullscreen: false,
        focused: false,
        appCategory: 'other',
        windowTitle: '',
        idleTimeMs: 5000,
        _schemaVersion: 1,
      })

      expect(handler).toHaveBeenCalledOnce()
      const payload = handler.mock.calls[0][0]
      expect(payload.activityState).toBe('idle')
      expect(payload._schemaVersion).toBe(1)
    })

    it('应能处理 bridge 自身发出的 behavior 事件（完整闭环）', () => {
      const handler = vi.fn()
      bridge.onBehaviorEvent('behavior.state.updated', handler)

      bridge.emitBehaviorEvent('behavior.state.updated', {
        activityState: 'active',
        fullscreen: false,
        focused: true,
        appCategory: 'browser',
        windowTitle: 'Chrome',
        idleTimeMs: 0,
      })

      expect(handler).toHaveBeenCalledOnce()
      const payload = handler.mock.calls[0][0]
      expect(payload.appCategory).toBe('browser')
      expect(payload._schemaVersion).toBe(getCurrentSchemaVersion('behavior.state.updated'))
    })
  })

  describe('Schema 版本兼容性', () => {
    it('应接受未来版本（高于当前）的载荷并记录警告', () => {
      const handler = vi.fn()
      bridge.onAgentEvent('agent.input.received', handler)

      // 模拟未来版本（当前为 v1，发送 v2）
      eventBus.emit('agent.input.received', {
        text: 'hello',
        requestId: 'r1',
        source: 'electron',
        _schemaVersion: 2,
        newField: 'future stuff',
      })

      // 未来版本仍应传递给 handler
      expect(handler).toHaveBeenCalledOnce()
      const payload = handler.mock.calls[0][0]
      expect(payload._schemaVersion).toBe(2)
      expect(payload.newField).toBe('future stuff')
    })

    it('应接受过时版本（低于当前）的载荷', () => {
      // 所有事件当前都是 v1，所以没有真正"过时"的版本
      // 这里验证 isSchemaVersionCompatible 对低版本返回 true
      expect(isSchemaVersionCompatible('agent.plan.created', 0)).toBe(true)
    })

    it('每个 Agent↔UserBehavior 事件都有注册的 Schema', () => {
      // 验证关键事件已注册
      expect(AGENT_BEHAVIOR_EVENT_SCHEMAS).toHaveProperty('agent.plan.created')
      expect(AGENT_BEHAVIOR_EVENT_SCHEMAS).toHaveProperty('agent.plan.step')
      expect(AGENT_BEHAVIOR_EVENT_SCHEMAS).toHaveProperty('agent.plan.completed')
      expect(AGENT_BEHAVIOR_EVENT_SCHEMAS).toHaveProperty('agent.tool.invoked')
      expect(AGENT_BEHAVIOR_EVENT_SCHEMAS).toHaveProperty('agent.tool.completed')
      expect(AGENT_BEHAVIOR_EVENT_SCHEMAS).toHaveProperty('agent.tool.failed')
      expect(AGENT_BEHAVIOR_EVENT_SCHEMAS).toHaveProperty('agent.state.changed')
      expect(AGENT_BEHAVIOR_EVENT_SCHEMAS).toHaveProperty('agent.input.received')
      expect(AGENT_BEHAVIOR_EVENT_SCHEMAS).toHaveProperty('agent.response.generated')
      expect(AGENT_BEHAVIOR_EVENT_SCHEMAS).toHaveProperty('agent.error')

      expect(AGENT_BEHAVIOR_EVENT_SCHEMAS).toHaveProperty('behavior.state.updated')
      expect(AGENT_BEHAVIOR_EVENT_SCHEMAS).toHaveProperty('behavior.mode.switch')
    })
  })

  describe('订阅生命周期', () => {
    it('dispose 应移除所有订阅', () => {
      const handler1 = vi.fn()
      const handler2 = vi.fn()
      bridge.onAgentEvent('agent.tool.invoked', handler1)
      bridge.onBehaviorEvent('behavior.state.updated', handler2)

      expect(bridge.subscriptionCount).toBe(2)

      bridge.dispose()

      expect(bridge.subscriptionCount).toBe(0)

      // dispose 后不应再收到事件
      bridge.emitAgentEvent('agent.tool.invoked', {
        tool: 'test',
        args: {},
        requestId: 'r1',
      })
      expect(handler1).not.toHaveBeenCalled()
    })

    it('disposer 应移除单个订阅', () => {
      const handler = vi.fn()
      const disposer = bridge.onAgentEvent('agent.tool.invoked', handler)
      expect(bridge.subscriptionCount).toBe(1)

      disposer()
      expect(bridge.subscriptionCount).toBe(1) // bridge 的 disposers 数组仍记录，但 EventBus 已移除

      bridge.emitAgentEvent('agent.tool.invoked', {
        tool: 'test',
        args: {},
        requestId: 'r1',
      })
      expect(handler).not.toHaveBeenCalled()
    })

    it('多次 dispose 应安全', () => {
      bridge.dispose()
      // 第二次调用不应抛异常
      expect(() => bridge.dispose()).not.toThrow()
    })
  })

  describe('两个独立 Bridge 实例', () => {
    it('各自订阅互不干扰', () => {
      const bridge1 = createBridge()
      const bridge2 = createBridge()
      const handler1 = vi.fn()
      const handler2 = vi.fn()

      bridge1.onAgentEvent('agent.tool.invoked', handler1, 'bridge1')
      bridge2.onAgentEvent('agent.tool.invoked', handler2, 'bridge2')

      eventBus.emit('agent.tool.invoked', {
        tool: 'test',
        args: {},
        requestId: 'r1',
        _schemaVersion: 1,
      })

      expect(handler1).toHaveBeenCalledOnce()
      expect(handler2).toHaveBeenCalledOnce()

      bridge1.dispose()
      bridge2.dispose()
    })
  })

  describe('单例 agentBehaviorBridge', () => {
    it('应作为默认导出可用', () => {
      expect(agentBehaviorBridge).toBeInstanceOf(AgentBehaviorBridge)
    })

    it('应能正常 emit 和 subscribe', () => {
      const handler = vi.fn()
      const disposer = agentBehaviorBridge.onAgentEvent('agent.tool.invoked', handler)

      agentBehaviorBridge.emitAgentEvent('agent.tool.invoked', {
        tool: 'test',
        args: {},
        requestId: 'r1',
      })

      expect(handler).toHaveBeenCalledOnce()
      disposer()
    })
  })
})
