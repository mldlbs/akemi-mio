import { describe, it, expect } from 'vitest'
import { selectMethodology, buildMethodologyHint, getMethodologyById } from '@akemi-mio/intelligence/superpowers/Methodology'

describe('selectMethodology (M6.2 deterministic)', () => {
  it('selects systematic_debugging for bug/error requests', () => {
    expect(selectMethodology({ objective: '修复这个 bug', successCriteria: ['测试通过'] }).id).toBe('systematic_debugging')
    expect(selectMethodology({ objective: '排查一下报错原因', successCriteria: [] }).id).toBe('systematic_debugging')
  })

  it('selects test_driven_development for test-driven requests', () => {
    expect(selectMethodology({ objective: '实现新功能', successCriteria: ['测试通过'] }).id).toBe('test_driven_development')
  })

  it('selects writing_plan for planning/design requests', () => {
    expect(selectMethodology({ objective: '给出一个部署方案', successCriteria: [] }).id).toBe('writing_plan')
  })

  it('selects brainstorming for creative requirements', () => {
    expect(selectMethodology({ objective: '帮我头脑风暴一个新功能', successCriteria: [] }).id).toBe('brainstorming')
  })

  it('selects verification_before_completion for acceptance requests', () => {
    expect(selectMethodology({ objective: '确认这个改动可以验收', successCriteria: [] }).id).toBe('verification_before_completion')
  })

  it('falls back to executing_plan for generic execution goals', () => {
    const methodology = selectMethodology({ objective: '帮我优化 MCP 管理', successCriteria: ['文件修改成功'] })
    expect(methodology.id).toBe('executing_plan')
  })

  it('orders rules by priority so debugging beats generic test match', () => {
    const methodology = selectMethodology({ objective: '修复测试失败的 bug', successCriteria: ['测试通过'] })
    expect(methodology.id).toBe('systematic_debugging')
  })
})

describe('methodology helpers', () => {
  it('builds a system_hint from a methodology', () => {
    const methodology = getMethodologyById('executing_plan')!
    expect(buildMethodologyHint(methodology)).toContain('【方法论：分步执行】')
  })

  it('returns null for unknown methodology ids', () => {
    expect(getMethodologyById('missing')).toBeNull()
  })
})
