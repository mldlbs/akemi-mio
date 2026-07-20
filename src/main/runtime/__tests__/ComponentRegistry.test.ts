/**
 * ComponentRegistry — contract tests
 *
 * 冻结语义后再实现，避免实现细节污染契约决策。
 */

import { describe, it, expect } from 'vitest'
import { ComponentRegistryImpl } from '../ComponentRegistry'
import type { ComponentDescriptor, CheckpointableComponent, VersionedState } from '../CheckpointTypes'

// ════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════

function createDescriptor(id: string, version = '1.0'): ComponentDescriptor {
  return {
    id,
    version,
    create() {
      return new MockComponent(id, version)
    },
  }
}

let compCounter = 0
class MockComponent implements CheckpointableComponent {
  readonly id: string
  readonly instanceId: number
  private version: string
  restoredData: unknown = undefined

  constructor(id: string, version: string) {
    this.id = id
    this.version = version
    this.instanceId = ++compCounter
  }

  async snapshot(): Promise<VersionedState> {
    return { component: this.id, version: this.version, data: {}, createdAt: Date.now() }
  }

  async restore(state: VersionedState): Promise<void> {
    this.restoredData = state.data
  }
}

// ════════════════════════════════════════════════════
//  Scene 1: register & resolve
// ════════════════════════════════════════════════════

describe('ComponentRegistry — register & resolve', () => {
  it('should return descriptor by id', () => {
    const registry = new ComponentRegistryImpl()
    const desc = createDescriptor('workflow-runtime')
    registry.register(desc)
    expect(registry.resolve('workflow-runtime')).toBe(desc)
  })

  it('should return undefined for unknown id', () => {
    const registry = new ComponentRegistryImpl()
    registry.register(createDescriptor('workflow-runtime'))
    expect(registry.resolve('memory-runtime')).toBeUndefined()
  })

  it('should reject duplicate id registration', () => {
    const registry = new ComponentRegistryImpl()
    registry.register(createDescriptor('workflow-runtime'))
    expect(() => registry.register(createDescriptor('workflow-runtime'))).toThrow(/duplicate/i)
  })

  it('should list all registered descriptors', () => {
    const registry = new ComponentRegistryImpl()
    registry.register(createDescriptor('a'))
    registry.register(createDescriptor('b'))
    registry.register(createDescriptor('c'))
    const all = registry.list()
    expect(all).toHaveLength(3)
    expect(all.map((d) => d.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('should return empty list when no descriptors', () => {
    const registry = new ComponentRegistryImpl()
    expect(registry.list()).toEqual([])
  })
})

// ════════════════════════════════════════════════════
//  Scene 2: create isolation
// ════════════════════════════════════════════════════

describe('ComponentRegistry — create isolation', () => {
  it('each create() call should return a new instance', () => {
    const desc = createDescriptor('workflow-runtime')
    const a = desc.create()
    const b = desc.create()
    expect(a).not.toBe(b)
    expect((a as MockComponent).instanceId).not.toBe((b as MockComponent).instanceId)
  })

  it('instances should not share restored state', async () => {
    const desc = createDescriptor('workflow-runtime')
    const a = desc.create() as MockComponent
    const b = desc.create() as MockComponent

    const stateA: VersionedState = { component: 'workflow-runtime', version: '1.0', data: { runId: 'A' }, createdAt: 1 }
    const stateB: VersionedState = { component: 'workflow-runtime', version: '1.0', data: { runId: 'B' }, createdAt: 2 }

    await a.restore(stateA)
    await b.restore(stateB)

    expect(a.restoredData).toEqual({ runId: 'A' })
    expect(b.restoredData).toEqual({ runId: 'B' })
  })
})

// ════════════════════════════════════════════════════
//  Scene 3: resolve & create composition
// ════════════════════════════════════════════════════

describe('ComponentRegistry — resolve & create composition', () => {
  it('resolve → create should produce a valid component', () => {
    const registry = new ComponentRegistryImpl()
    registry.register(createDescriptor('workflow-runtime'))
    const desc = registry.resolve('workflow-runtime')
    expect(desc).toBeDefined()
    const comp = desc!.create()
    expect(comp.id).toBe('workflow-runtime')
    expect(typeof comp.snapshot).toBe('function')
    expect(typeof comp.restore).toBe('function')
  })

  it('resolve → create should not affect registry', () => {
    const registry = new ComponentRegistryImpl()
    registry.register(createDescriptor('workflow-runtime'))
    const desc = registry.resolve('workflow-runtime')!
    desc.create()
    desc.create()
    desc.create()
    // Registry state unchanged
    expect(registry.list()).toHaveLength(1)
    expect(registry.resolve('workflow-runtime')).toBe(desc)
  })
})
