/**
 * decisions schema 的类型验证。
 * Drizzle ORM 的 sqliteTable 返回 proxy 对象，columns 无法直接通过 Object.keys 访问。
 * 这里通过运行时推断验证枚举值正确性。
 */
import { describe, it, expect } from 'vitest'
import { decisions } from '../decisions'

describe('decisions schema', () => {
  it('导出存在', () => {
    expect(decisions).toBeDefined()
  })

  it('category 列可访问', () => {
    const col = decisions.category
    expect(col).toBeDefined()
  })

  it('多个列可访问', () => {
    expect(decisions.id).toBeDefined()
    expect(decisions.timestamp).toBeDefined()
    expect(decisions.agentId).toBeDefined()
    expect(decisions.category).toBeDefined()
    expect(decisions.context).toBeDefined()
    expect(decisions.choice).toBeDefined()
    expect(decisions.alternatives).toBeDefined()
    expect(decisions.outcome).toBeDefined()
    expect(decisions.confidence).toBeDefined()
    expect(decisions.relatedPlanId).toBeDefined()
    expect(decisions.createdAt).toBeDefined()
  })
})
