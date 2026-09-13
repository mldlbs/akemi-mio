/**
 * 真实数据源解析的单元测试。
 *
 * 这些解析函数处理的是从主进程传来的裸值（无编译期类型保障）。
 * 上游字段缺失/改名时 TypeScript 看不见，只能靠这里的防御性断言兜住 ——
 * 否则 undefined 会直接渲染进壁纸卡片，在用户桌面上长期显示"undefined"。
 */

import { describe, it, expect } from 'vitest'
import { parseConversationContext, parseMemoryCards } from '../runtime'

describe('parseConversationContext', () => {
  it('正常载荷解析成功', () => {
    const r = parseConversationContext({
      hasData: true,
      summary: '在重构表单架构',
      summaryConfidence: 0.8,
      activeTasks: [
        { taskId: 't1', title: '重构渲染层', status: 'running', progressPercent: 40, completedSteps: 2, totalSteps: 5 },
      ],
      completedTasks: 3,
      totalTasks: 4,
      progressPercent: 75,
      updatedAt: 1,
    })
    expect(r).not.toBeNull()
    expect(r!.summary).toBe('在重构表单架构')
    expect(r!.activeTasks).toHaveLength(1)
    expect(r!.activeTasks[0].title).toBe('重构渲染层')
    expect(r!.progressPercent).toBe(75)
  })

  it('hasData 非 true 时返回 null（不显示空卡片）', () => {
    expect(parseConversationContext({ hasData: false, summary: 'x' })).toBeNull()
    expect(parseConversationContext({ summary: 'x' })).toBeNull()
  })

  it('非对象输入返回 null', () => {
    expect(parseConversationContext(null)).toBeNull()
    expect(parseConversationContext(undefined)).toBeNull()
    expect(parseConversationContext('字符串')).toBeNull()
    expect(parseConversationContext(42)).toBeNull()
  })

  it('数字字段缺失时归 0 而非 undefined', () => {
    const r = parseConversationContext({ hasData: true, summary: '' })
    expect(r!.progressPercent).toBe(0)
    expect(r!.completedTasks).toBe(0)
    expect(r!.summaryConfidence).toBe(0)
  })

  it('数字字段为 NaN / Infinity 时归 0（不能渲染出 NaN%）', () => {
    const r = parseConversationContext({
      hasData: true,
      progressPercent: Number.NaN,
      completedTasks: Number.POSITIVE_INFINITY,
    })
    expect(r!.progressPercent).toBe(0)
    expect(r!.completedTasks).toBe(0)
  })

  it('activeTasks 非数组时视为空', () => {
    expect(parseConversationContext({ hasData: true, activeTasks: 'nope' })!.activeTasks).toEqual([])
    expect(parseConversationContext({ hasData: true, activeTasks: null })!.activeTasks).toEqual([])
  })

  it('丢弃没有标题的任务（避免渲染空行）', () => {
    const r = parseConversationContext({
      hasData: true,
      activeTasks: [
        { taskId: 'a', title: '', status: 'running' },
        { taskId: 'b', title: '有标题', status: 'running' },
        null,
        'garbage',
      ],
    })
    expect(r!.activeTasks).toHaveLength(1)
    expect(r!.activeTasks[0].title).toBe('有标题')
  })

  it('任务字段类型错误时降级为安全默认值', () => {
    const r = parseConversationContext({
      hasData: true,
      activeTasks: [{ title: '任务', progressPercent: 'abc', completedSteps: null }],
    })
    expect(r!.activeTasks[0].progressPercent).toBe(0)
    expect(r!.activeTasks[0].completedSteps).toBe(0)
    expect(r!.activeTasks[0].taskId).toBe('')
  })

  it('error 非字符串时不写入', () => {
    const r = parseConversationContext({ hasData: true, error: { msg: 'x' } })
    expect(r!.error).toBeUndefined()
  })
})

describe('parseMemoryCards', () => {
  it('正常卡片解析成功', () => {
    const cards = parseMemoryCards({
      hasData: true,
      cards: [
        { id: 'm1', content: '用户偏好简洁回复', type: 'preference', confidence: 0.9, isPinned: true, topics: ['偏好'] },
      ],
    })
    expect(cards).toHaveLength(1)
    expect(cards[0].content).toBe('用户偏好简洁回复')
    expect(cards[0].isPinned).toBe(true)
    expect(cards[0].topics).toEqual(['偏好'])
  })

  it('hasData 非 true 时返回空数组', () => {
    expect(parseMemoryCards({ hasData: false, cards: [{ content: 'x' }] })).toEqual([])
  })

  it('非对象输入返回空数组', () => {
    expect(parseMemoryCards(null)).toEqual([])
    expect(parseMemoryCards('x')).toEqual([])
  })

  it('丢弃无内容的卡片', () => {
    const cards = parseMemoryCards({
      hasData: true,
      cards: [{ id: 'a', content: '' }, { id: 'b', content: '有内容' }, null],
    })
    expect(cards).toHaveLength(1)
    expect(cards[0].content).toBe('有内容')
  })

  it('topics 含非字符串项时被过滤', () => {
    const cards = parseMemoryCards({
      hasData: true,
      cards: [{ content: 'x', topics: ['ok', 42, null, 'fine'] }],
    })
    expect(cards[0].topics).toEqual(['ok', 'fine'])
  })

  it('isPinned 非 true 一律为 false', () => {
    const cards = parseMemoryCards({ hasData: true, cards: [{ content: 'x', isPinned: 'yes' }] })
    expect(cards[0].isPinned).toBe(false)
  })

  it('confidence 非数字归 0', () => {
    const cards = parseMemoryCards({ hasData: true, cards: [{ content: 'x', confidence: 'high' }] })
    expect(cards[0].confidence).toBe(0)
  })
})
