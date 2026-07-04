/**
 * ToolEventBridge 测试 — 验证 agent.tool.* → EvaluationEmitter 桥接链路
 *
 * 验证范围：
 * 1. tool.invoked → push pending + emit tool.invoked
 * 2. tool.completed → consume pending + emit tool.completed（含 durationMs）
 * 3. tool.failed → consume pending + emit tool.completed（含 error）
 * 4. 相同工具名并发调用 FIFO 配对正确
 * 5. 无 pending 的 completed/failed 不崩溃
 * 6. start/stop 生命周期正确
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventBus, eventBus } from '../../EventBus'
import { ToolEventBridge } from '../ToolEventBridge'
import { EvaluationEmitter } from '../EvaluationEmitter'
import { InMemoryEvaluationRepository } from '../__test_support__'

function resetBus() {
  eventBus.removeAll()
}

describe('ToolEventBridge', () => {
  let repo: InMemoryEvaluationRepository
  let emitter: EvaluationEmitter
  let bridge: ToolEventBridge

  beforeEach(() => {
    resetBus()
    repo = new InMemoryEvaluationRepository()
    emitter = new EvaluationEmitter(repo, 'test')
    bridge = new ToolEventBridge(emitter, eventBus)
    bridge.start()
  })

  afterEach(() => {
    bridge.stop()
  })

  it('emits tool.invoked on agent.tool.invoked', () => {
    eventBus.emit('agent.tool.invoked', { tool: 'read_file', args: { path: '/test' } })

    const events = repo.events.filter((e) => e.type === 'tool.invoked')
    expect(events).toHaveLength(1)
    expect(events[0].payload).toMatchObject({
      toolName: 'read_file',
      args: { path: '/test' },
    })
  })

  it('emits tool.completed with latency on agent.tool.completed', () => {
    eventBus.emit('agent.tool.invoked', { tool: 'write_file', args: {} })
    eventBus.emit('agent.tool.completed', { tool: 'write_file', result: 'ok' })

    const events = repo.events.filter((e) => e.type === 'tool.completed')
    expect(events).toHaveLength(1)
    expect(events[0].payload).toMatchObject({
      toolName: 'write_file',
      output: 'ok',
    })
    expect((events[0].payload as any).durationMs).toBeGreaterThanOrEqual(0)
  })

  it('emits tool.completed with error on agent.tool.failed', () => {
    eventBus.emit('agent.tool.invoked', { tool: 'grep', args: {} })
    eventBus.emit('agent.tool.failed', { tool: 'grep', error: 'permission denied' })

    const events = repo.events.filter((e) => e.type === 'tool.completed')
    expect(events).toHaveLength(1)
    expect(events[0].payload).toMatchObject({
      toolName: 'grep',
      error: 'permission denied',
    })
    expect((events[0].payload as any).durationMs).toBeGreaterThanOrEqual(0)
  })

  it('handles concurrent calls to same tool name in FIFO order', () => {
    eventBus.emit('agent.tool.invoked', { tool: 'read_file', args: { path: '/a' } })
    eventBus.emit('agent.tool.invoked', { tool: 'read_file', args: { path: '/b' } })
    eventBus.emit('agent.tool.completed', { tool: 'read_file', result: 'result_a' })
    eventBus.emit('agent.tool.completed', { tool: 'read_file', result: 'result_b' })

    const invoked = repo.events.filter((e) => e.type === 'tool.invoked')
    const completed = repo.events.filter((e) => e.type === 'tool.completed')

    expect(invoked).toHaveLength(2)
    expect(completed).toHaveLength(2)
    // FIFO: first invoked matches first completed
    expect((invoked[0].payload as any).args?.path).toBe('/a')
    expect((invoked[1].payload as any).args?.path).toBe('/b')
    expect((completed[0].payload as any).output).toBe('result_a')
    expect((completed[1].payload as any).output).toBe('result_b')
  })

  it('does not crash on completed without matching invoked', () => {
    expect(() => {
      eventBus.emit('agent.tool.completed', { tool: 'orphan_tool', result: 'orphan' })
    }).not.toThrow()
  })

  it('does not crash on failed without matching invoked', () => {
    expect(() => {
      eventBus.emit('agent.tool.failed', { tool: 'orphan_tool', error: 'orphan error' })
    }).not.toThrow()
  })

  it('stops emitting after stop()', () => {
    bridge.stop()

    eventBus.emit('agent.tool.invoked', { tool: 'read_file', args: {} })
    expect(repo.events).toHaveLength(0)
  })
})
