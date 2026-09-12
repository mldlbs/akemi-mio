import { describe, expect, it } from 'vitest'
import { BehaviorPredictor } from '@akemi-mio/intelligence/mcp/BehaviorPredictor'

describe('BehaviorPredictor shadow identity', () => {
  it('records optional shadow identity metadata on recent calls', () => {
    const predictor = new BehaviorPredictor()

    predictor.recordCall('write_file', { path: 'a.txt' }, 5, true, {
      capability: 'file.management',
      operation: 'write',
      provider: '@builtin/core',
    })

    expect(predictor.getRecentCalls()[0]).toMatchObject({
      toolName: 'write_file',
      capability: 'file.management',
      operation: 'write',
      provider: '@builtin/core',
    })
  })

  it('keeps legacy call shape valid when no identity metadata is provided', () => {
    const predictor = new BehaviorPredictor()

    predictor.recordCall('list_files', { path: '.' }, 3, true)

    expect(predictor.getRecentCalls()[0].capability).toBeUndefined()
  })
})
