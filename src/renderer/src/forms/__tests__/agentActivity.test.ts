/**
 * Agent 活动归一化的单元测试。
 *
 * 为什么这类测试值得写：`normalizeAgentEvent` 处理的是**跨进程传来的裸值**，
 * 没有类型保障。上游改了载荷形状、或某个字段变成 undefined，
 * TypeScript 完全看不见，只能靠这里的防御性断言兜住 ——
 * 否则错误会以 `undefined` 的形式泄漏到宠物气泡里，变成一串"undefined…"。
 */

import { describe, it, expect } from 'vitest'
import { normalizeAgentEvent } from '../runtime'

describe('normalizeAgentEvent — ai:chunk', () => {
  it('正常文本归为 speaking', () => {
    expect(normalizeAgentEvent('ai:chunk', ['你好'])).toEqual({ kind: 'speaking', text: '你好' })
  })

  it('空字符串返回 null（不产生空气泡）', () => {
    expect(normalizeAgentEvent('ai:chunk', [''])).toBeNull()
  })

  it('非字符串载荷返回 null（不把 undefined 泄漏出去）', () => {
    expect(normalizeAgentEvent('ai:chunk', [undefined])).toBeNull()
    expect(normalizeAgentEvent('ai:chunk', [42])).toBeNull()
    expect(normalizeAgentEvent('ai:chunk', [null])).toBeNull()
    expect(normalizeAgentEvent('ai:chunk', [{ text: '对象' }])).toBeNull()
  })

  it('无参数返回 null', () => {
    expect(normalizeAgentEvent('ai:chunk', [])).toBeNull()
  })
})

describe('normalizeAgentEvent — tool:status', () => {
  it('进行中的工具调用归为 tool 并带上工具名', () => {
    expect(normalizeAgentEvent('tool:status', [{ type: 'start', tool: 'Read', message: '读文件' }])).toEqual({
      kind: 'tool',
      text: 'Read',
    })
  })

  it('结束状态归为 done', () => {
    for (const type of ['end', 'done', 'complete']) {
      expect(normalizeAgentEvent('tool:status', [{ type, tool: 'Bash', message: '' }])?.kind).toBe('done')
    }
  })

  it('缺少 tool 时回退到 message', () => {
    expect(normalizeAgentEvent('tool:status', [{ type: 'start', message: '处理中' }])).toEqual({
      kind: 'tool',
      text: '处理中',
    })
  })

  it('tool 与 message 都没有时 text 为空串而非 undefined', () => {
    const r = normalizeAgentEvent('tool:status', [{ type: 'start' }])
    expect(r).toEqual({ kind: 'tool', text: '' })
  })

  it('载荷不是对象时返回 null', () => {
    expect(normalizeAgentEvent('tool:status', [null])).toBeNull()
    expect(normalizeAgentEvent('tool:status', ['字符串'])).toBeNull()
    expect(normalizeAgentEvent('tool:status', [])).toBeNull()
  })

  it('未知 type 按"正在工作"处理（比误报完成安全）', () => {
    expect(normalizeAgentEvent('tool:status', [{ type: 'weird', tool: 'X' }])?.kind).toBe('tool')
    expect(normalizeAgentEvent('tool:status', [{ tool: 'X' }])?.kind).toBe('tool')
  })
})

describe('normalizeAgentEvent — agent:state', () => {
  it('thinking / running 归为 thinking', () => {
    expect(normalizeAgentEvent('agent:state', [{ state: 'thinking' }])?.kind).toBe('thinking')
    expect(normalizeAgentEvent('agent:state', [{ state: 'running' }])?.kind).toBe('thinking')
  })

  it('idle / done 归为 done', () => {
    expect(normalizeAgentEvent('agent:state', [{ state: 'idle' }])?.kind).toBe('done')
    expect(normalizeAgentEvent('agent:state', [{ state: 'done' }])?.kind).toBe('done')
  })

  it('error 归为 error', () => {
    expect(normalizeAgentEvent('agent:state', [{ state: 'error', message: '炸了' }])).toEqual({
      kind: 'error',
      text: '炸了',
    })
  })

  it('未知状态返回 null', () => {
    expect(normalizeAgentEvent('agent:state', [{ state: 'paused' }])).toBeNull()
    expect(normalizeAgentEvent('agent:state', [{}])).toBeNull()
    expect(normalizeAgentEvent('agent:state', [null])).toBeNull()
  })
})

describe('normalizeAgentEvent — 未知频道', () => {
  it('返回 null 而不是抛错（上游加频道不应让形态崩掉）', () => {
    expect(normalizeAgentEvent('some:future:channel', ['x'])).toBeNull()
    expect(normalizeAgentEvent('', [])).toBeNull()
  })
})
