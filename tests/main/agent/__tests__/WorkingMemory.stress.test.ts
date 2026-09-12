import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Scratchpad, AttentionSet } from '@akemi-mio/intelligence/agent/WorkingMemory'

describe('Scratchpad 压力测试', () => {
  it('10000 add + 一次 flush 后为空', () => {
    const pad = new Scratchpad()
    for (let i = 0; i < 10000; i++) pad.add('think', `条目 ${i}`)
    expect(pad.size).toBe(10000)
    expect(pad.flush()).toHaveLength(10000)
    expect(pad.size).toBe(0)
  })

  it('10000 次交替 add/flush 不溢出', () => {
    const pad = new Scratchpad()
    for (let i = 0; i < 10000; i++) {
      pad.add('observe', `obs ${i}`)
      pad.add('think', `think ${i}`)
      expect(pad.flush()).toHaveLength(2)
      expect(pad.size).toBe(0)
    }
  })

  it('1000 次 injectInto 不丢数据', () => {
    const pad = new Scratchpad()
    for (let i = 0; i < 1000; i++) pad.add('system_hint', `hint_${i}`)
    const msgs: any[] = [{ role: 'system', content: 'sys' }]
    pad.injectInto(msgs, 'system')
    expect(msgs[1].content).toContain('hint_0')
    expect(msgs[1].content).toContain('hint_999')
  })

  it('flushNew 精确区分新旧条目', () => {
    const pad = new Scratchpad()
    for (let i = 0; i < 10; i++) pad.add('observe', `old_${i}`)
    const mark = pad.size
    for (let i = 0; i < 5; i++) pad.add('think', `new_${i}`)
    expect(pad.flushNew(mark)).toHaveLength(5)
    expect(pad.flushNew(0)).toHaveLength(10) // 旧条目还在
  })

  it('4 种 entry type 在 injectInto 中都可见', () => {
    const pad = new Scratchpad()
    pad.add('observe', 'obs')
    pad.add('think', 't')
    pad.add('reflect', 'r')
    pad.add('system_hint', 'sys')
    pad.add('error_hint', 'err')
    const msgs: any[] = [{ role: 'user', content: 'hi' }]
    pad.injectInto(msgs, 'system')
    expect(msgs[1].content)
      .toContain('[observe]')
      .and.contain('[think]')
      .and.contain('[reflect]')
      .and.contain('[system_hint]')
      .and.contain('[error_hint]')
  })
})

describe('AttentionSet 压力测试', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('1000 个独立实体 getActive 排序正确', () => {
    const attn = new AttentionSet()
    for (let i = 0; i < 1000; i++) attn.add(`entity_${i}`, 'concept', Math.random())
    const active = attn.getActive(0)
    expect(active.length).toBeGreaterThan(0)
    for (let i = 1; i < active.length; i++) expect(active[i - 1].relevance).toBeGreaterThanOrEqual(active[i].relevance)
  })

  it('大量旧实体通过 tick 正确清理', () => {
    const attn = new AttentionSet()
    for (let i = 0; i < 200; i++) attn.add(`old_${i}`, 'concept', 0.5)
    vi.advanceTimersByTime(31 * 60 * 1000)
    for (let i = 0; i < 200; i++) attn.add(`fresh_${i}`, 'file', 1.0)
    attn.tick()
    const active = attn.getActive(0)
    expect(active.every((e) => e.name.startsWith('fresh_'))).toBe(true)
  })

  it('100 次 extractFrom 大量文本提取文件 + 概念', () => {
    const attn = new AttentionSet()
    const longText = Array.from({ length: 100 }, (_, i) => `修改 src/main/module_${i}.ts 中的「性能优化_${i}」`).join('\n')
    for (let i = 0; i < 100; i++) attn.extractFrom(longText)
    const active = attn.getActive(0)
    expect(active.some((e) => e.name.includes('module'))).toBe(true)
    expect(active.some((e) => e.name.includes('性能优化'))).toBe(true)
  })

  it('getFormattedContext limit 参数生效', () => {
    const attn = new AttentionSet()
    for (let i = 0; i < 50; i++) attn.add(`e${i}`, 'concept', 1.0)
    expect(
      attn
        .getFormattedContext(5)
        .split('\n')
        .filter((l) => l.startsWith('- ')),
    ).toHaveLength(5)
    expect(
      attn
        .getFormattedContext(20)
        .split('\n')
        .filter((l) => l.startsWith('- ')),
    ).toHaveLength(20)
  })

  it('衰减后 relevance 随时间递减', () => {
    const attn = new AttentionSet()
    attn.add('test', 'concept', 1.0)
    const r1 = attn.getActive(0)[0].relevance
    vi.advanceTimersByTime(5 * 60 * 1000)
    const r2 = attn.getActive(0)[0].relevance
    expect(r2).toBeLessThan(r1)
  })

  it('大量同名实体去重取最高 relevance', () => {
    const attn = new AttentionSet()
    for (let i = 0; i < 100; i++) attn.add('dedup_key', 'concept', i / 100)
    expect(attn.getActive(0)).toHaveLength(1)
    expect(attn.getActive(0)[0].relevance).toBeCloseTo(1.0, 1)
  })
})
