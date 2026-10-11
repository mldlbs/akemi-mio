/**
 * 机制涌现 P0 (b): ExperimentSnapshot 短 id 可复现
 */
import { describe, it, expect } from 'vitest'
import {
  computeSnapshotId,
  normalizeBindings,
  hashLlmConfig,
  type ExperimentSnapshotInput,
  type SnapshotCapabilityBinding,
} from '@akemi-mio/capabilities/capability/ExperimentSnapshot'

const BINDING_A: SnapshotCapabilityBinding = {
  capability: 'publishing',
  contractVersion: '1.0.0',
  providerId: 'fanqie-publish',
  tool: 'fanqie_publish_novel',
}

const BINDING_B: SnapshotCapabilityBinding = {
  capability: 'browser.automation',
  contractVersion: '1.0.0',
  providerId: 'playwright',
  tool: 'browser_navigate',
}

const BASE: ExperimentSnapshotInput = {
  capabilityBindings: [BINDING_A, BINDING_B],
  policyVersion: 'v1',
  llmConfigHash: 'abc123def456',
  runtimeVersion: '0.15.0',
  gitDescribe: 'v0.15.0-3-gdeadbeef',
}

describe('ExperimentSnapshot.computeSnapshotId', () => {
  it('is deterministic for identical input', () => {
    expect(computeSnapshotId(BASE)).toBe(computeSnapshotId({ ...BASE, capabilityBindings: [...BASE.capabilityBindings] }))
  })

  it('produces a 12-hex short id', () => {
    const id = computeSnapshotId(BASE)
    expect(id).toMatch(/^[0-9a-f]{12}$/)
  })

  it('is independent of binding registration order', () => {
    expect(computeSnapshotId(BASE)).toBe(computeSnapshotId({ ...BASE, capabilityBindings: [BINDING_B, BINDING_A] }))
  })

  it('changes when contractVersion drifts (A4)', () => {
    const drifted: ExperimentSnapshotInput = {
      ...BASE,
      capabilityBindings: [{ ...BINDING_A, contractVersion: '2.0.0' }, BINDING_B],
    }
    expect(computeSnapshotId(drifted)).not.toBe(computeSnapshotId(BASE))
  })

  it('changes when policyVersion changes', () => {
    expect(computeSnapshotId({ ...BASE, policyVersion: 'v2' })).not.toBe(computeSnapshotId(BASE))
  })

  it('changes when runtimeVersion changes', () => {
    expect(computeSnapshotId({ ...BASE, runtimeVersion: '0.16.0' })).not.toBe(computeSnapshotId(BASE))
  })

  it('changes when gitDescribe changes', () => {
    expect(computeSnapshotId({ ...BASE, gitDescribe: 'v0.16.0' })).not.toBe(computeSnapshotId(BASE))
  })

  it('omitting gitDescribe is distinct from providing it', () => {
    const without: ExperimentSnapshotInput = { ...BASE, gitDescribe: undefined }
    expect(computeSnapshotId(without)).not.toBe(computeSnapshotId(BASE))
  })

  it('empty binding table is a valid distinguishable state', () => {
    const empty: ExperimentSnapshotInput = { ...BASE, capabilityBindings: [] }
    const id = computeSnapshotId(empty)
    expect(id).toMatch(/^[0-9a-f]{12}$/)
    expect(id).not.toBe(computeSnapshotId(BASE))
  })
})

describe('normalizeBindings', () => {
  it('sorts by capability|providerId|tool key', () => {
    const sorted = normalizeBindings([BINDING_A, BINDING_B])
    expect(sorted.map((b) => b.capability)).toEqual(['browser.automation', 'publishing'])
  })
})

describe('hashLlmConfig', () => {
  it('is deterministic', () => {
    expect(hashLlmConfig({ model: 'gpt-4o', apiHost: 'https://api.example.com' })).toBe(
      hashLlmConfig({ model: 'gpt-4o', apiHost: 'https://api.example.com' }),
    )
  })

  it('changes when model changes', () => {
    expect(hashLlmConfig({ model: 'gpt-4o-mini', apiHost: 'https://api.example.com' })).not.toBe(
      hashLlmConfig({ model: 'gpt-4o', apiHost: 'https://api.example.com' }),
    )
  })

  it('accepts apiUrl as host fallback', () => {
    expect(hashLlmConfig({ model: 'm', apiUrl: 'https://x.example' })).toBe(hashLlmConfig({ model: 'm', apiHost: 'https://x.example' }))
  })
})
