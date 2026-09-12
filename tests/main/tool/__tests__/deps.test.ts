import { describe, it, expect } from 'vitest'
import {
  setPlanManager,
  getPlanManager,
  setCredentialsManager,
  getCredentialsManager,
  setMemoryService,
  getMemoryService,
  setSkillManager,
  getSkillManager,
  setProceduralMemory,
  getProceduralMemory,
} from '@akemi-mio/capabilities/tool/deps'

describe('tool deps', () => {
  it('PlanManager 默认 null → set → 清空', () => {
    expect(getPlanManager()).toBeNull()
    const mock = {} as any
    setPlanManager(mock)
    expect(getPlanManager()).toBe(mock)
    setPlanManager(null)
    expect(getPlanManager()).toBeNull()
  })

  it('CredentialsManager 默认 null → set → 清空', () => {
    expect(getCredentialsManager()).toBeNull()
    const mock = {} as any
    setCredentialsManager(mock)
    expect(getCredentialsManager()).toBe(mock)
    setCredentialsManager(null)
    expect(getCredentialsManager()).toBeNull()
  })

  it('MemoryService 默认 null → set → 清空', () => {
    expect(getMemoryService()).toBeNull()
    const mock = {} as any
    setMemoryService(mock)
    expect(getMemoryService()).toBe(mock)
    setMemoryService(null)
    expect(getMemoryService()).toBeNull()
  })

  it('SkillManager 默认 null → set → 清空', () => {
    expect(getSkillManager()).toBeNull()
    const mock = {} as any
    setSkillManager(mock)
    expect(getSkillManager()).toBe(mock)
    setSkillManager(null)
    expect(getSkillManager()).toBeNull()
  })

  it('ProceduralMemory 默认 null → set → 清空', () => {
    expect(getProceduralMemory()).toBeNull()
    const mock = {} as any
    setProceduralMemory(mock)
    expect(getProceduralMemory()).toBe(mock)
    setProceduralMemory(null)
    expect(getProceduralMemory()).toBeNull()
  })

  it('set 一个不影响其他', () => {
    const a = { tag: 'plan' } as any
    const b = { tag: 'cred' } as any
    setPlanManager(a)
    setCredentialsManager(b)
    expect(getPlanManager()).toEqual({ tag: 'plan' })
    expect(getCredentialsManager()).toEqual({ tag: 'cred' })
    expect(getMemoryService()).toBeNull()
    expect(getSkillManager()).toBeNull()
    expect(getProceduralMemory()).toBeNull()
    setPlanManager(null)
    setCredentialsManager(null)
  })
})
