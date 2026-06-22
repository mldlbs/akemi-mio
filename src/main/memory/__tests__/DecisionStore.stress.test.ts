import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { DecisionStore } from '../DecisionStore'
import { initDatabase, closeDatabase } from '../../db/connection'

describe('DecisionStore 压力测试', () => {
  let store: DecisionStore

  beforeEach(async () => {
    if (existsSync(join(process.cwd(), 'akemi-mio.db'))) unlinkSync(join(process.cwd(), 'akemi-mio.db'))
    process.env.USER_DATA_DIR = process.cwd()
    await initDatabase()
    store = new DecisionStore()
  })

  afterEach(() => {
    closeDatabase()
    if (existsSync(join(process.cwd(), 'akemi-mio.db'))) unlinkSync(join(process.cwd(), 'akemi-mio.db'))
  })

  it('1000 条记录后 prune 稳定在 200 条', () => {
    for (let i = 0; i < 1000; i++)
      store.record({
        agentId: 'stress',
        category: i % 5 === 0 ? 'strategy' : 'tool_select',
        context: `压力测试第 ${i} 条`,
        choice: `choice_${i}`,
        confidence: Math.random(),
        outcome: i % 3 === 0 ? 'success' : 'failure',
      })
    const all = store.query({ limit: 999 })
    expect(all.length).toBeLessThanOrEqual(200)
    expect(all[0].choice).toBe('choice_999')
  })

  it('1000 条后 query 过滤依然正确', () => {
    for (let i = 0; i < 1000; i++)
      store.record({
        agentId: i % 2 === 0 ? 'agent_a' : 'agent_b',
        category: i % 5 === 0 ? 'recovery' : i % 3 === 0 ? 'strategy' : 'tool_select',
        context: `ctx_${i}`,
        choice: `ch_${i}`,
        outcome: i % 4 === 0 ? 'failure' : 'success',
      })
    expect(store.query({ agentId: 'agent_a', limit: 999 }).length).toBeLessThanOrEqual(200)
    expect(store.query({ outcome: 'success', limit: 999 }).every((r) => r.outcome === 'success')).toBe(true)
    expect(store.query({ categories: ['recovery'], limit: 999 }).every((r) => r.category === 'recovery')).toBe(true)
  })

  it('200 条边界不触发 prune', () => {
    for (let i = 0; i < 200; i++) store.record({ agentId: 'a', category: 'tool_select', context: `ctx_${i}`, choice: `ch_${i}` })
    expect(store.query({ limit: 999 })).toHaveLength(200)
  })

  it('大量 updateOutcome 不影响', () => {
    const ids: string[] = []
    for (let i = 0; i < 500; i++) ids.push(store.record({ agentId: 'a', category: 'tool_select', context: `ctx_${i}`, choice: `ch_${i}` }))
    for (let i = 0; i < 250; i++) store.updateOutcome(ids[i * 2], 'failure')
    const failures = store.query({ outcome: 'failure', limit: 999 })
    expect(failures.length).toBeLessThanOrEqual(200)
    const updatedIds = new Set(failures.map((r) => r.id))
    expect(ids.some((id, i) => i % 2 === 0 && updatedIds.has(id))).toBe(true)
  })

  it('多种 category 混合写入后按类别查询准确', () => {
    for (let i = 0; i < 500; i++)
      store.record({
        agentId: 'mix',
        category: ['tool_select', 'strategy', 'plan_route', 'goal_adjust', 'recovery'][i % 5] as any,
        context: `ctx_${i}`,
        choice: `ch_${i}`,
      })
    for (const cat of ['tool_select', 'strategy', 'plan_route', 'goal_adjust', 'recovery'] as const) {
      const results = store.query({ categories: [cat], limit: 999 })
      expect(results.every((r) => r.category === cat)).toBe(true)
    }
  })

  it('getFormattedContext 按 category 过滤不混', () => {
    for (let i = 0; i < 100; i++) {
      store.record({ agentId: 'f', category: 'tool_select', context: `t${i}`, choice: `tool_${i}` })
      store.record({ agentId: 'f', category: 'strategy', context: `s${i}`, choice: `strategy_${i}` })
    }
    const toolCtx = store.getFormattedContext('tool_select', 10)
    expect(toolCtx).toContain('tool_')
    expect(toolCtx).not.toContain('strategy_')
    const strategyCtx = store.getFormattedContext('strategy', 10)
    expect(strategyCtx).toContain('strategy_')
    expect(strategyCtx).not.toContain('tool_')
  })

  it('大量 query 组合条件不抛异常', () => {
    for (let i = 0; i < 200; i++)
      store.record({
        agentId: 'q',
        category: 'tool_select',
        context: `x${i}`,
        choice: `c${i}`,
        outcome: i % 2 === 0 ? 'success' : 'failure',
        confidence: Math.random(),
      })
    const r = store.query({ categories: ['tool_select'], agentId: 'q', outcome: 'success', limit: 10, since: 0 })
    expect(r.length).toBeLessThanOrEqual(10)
    expect(r.every((x) => x.outcome === 'success' && x.agentId === 'q' && x.category === 'tool_select')).toBe(true)
  })
})
