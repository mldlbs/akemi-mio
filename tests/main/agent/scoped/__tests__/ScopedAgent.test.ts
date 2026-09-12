import { describe, it, expect } from 'vitest'
import { ScopedAgent } from '@akemi-mio/intelligence/agent/scoped/ScopedAgent'
import type { SkillAgentDef } from '@akemi-mio/intelligence/skill/SkillAgentRegistry'

function makeAgentDef(overrides: Partial<SkillAgentDef> = {}): SkillAgentDef {
  return {
    skillName: 'test-skill',
    allowedTools: ['read_file', 'search'],
    systemPrompt: '你是一个测试技能助手。',
    outputSchema: {},
    requiresInput: {},
    ...overrides,
  }
}

describe('ScopedAgent - 纯逻辑', () => {
  it('初始状态为 pending', () => {
    const agent = new ScopedAgent('sk_1', 'test-skill', makeAgentDef(), {}, null as any, '', '')
    expect(agent.status).toBe('pending')
  })

  it('构造时存储 skillName 和 id', () => {
    const agent = new ScopedAgent('sk_custom', 'my-skill', makeAgentDef(), {}, null as any, '', '')
    expect(agent.id).toBe('sk_custom')
    expect(agent.skillName).toBe('my-skill')
  })

  it('interrupt 不会抛出异常（即使未执行）', () => {
    const agent = new ScopedAgent('sk_1', 'test-skill', makeAgentDef(), {}, null as any, '', '')
    expect(() => agent.interrupt()).not.toThrow()
  })

  it('toResult 返回结构化结果（未执行时）', () => {
    const agent = new ScopedAgent('sk_1', 'test-skill', makeAgentDef(), { foo: 'bar' }, null as any, '', '')
    const result = agent.toResult()
    expect(result).toHaveProperty('id', 'sk_1')
    expect(result).toHaveProperty('status', 'pending')
    expect(result.goal).toContain('test-skill')
    expect(result).toHaveProperty('startedAt')
  })

  it('toResult 始终包含 required 字段', () => {
    const agent = new ScopedAgent('sk_2', 'test-skill', makeAgentDef(), {}, null as any, '', '')
    const r = agent.toResult()
    expect(r.id).toBe('sk_2')
    expect(typeof r.status).toBe('string')
    expect(typeof r.goal).toBe('string')
    expect(typeof r.startedAt).toBe('number')
  })
})
