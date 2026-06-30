import { describe, it, expect } from 'vitest'
import { AudioService } from '../AudioService'

describe('AudioService', () => {
  it('can be instantiated', () => {
    const svc = new AudioService()
    expect(svc).toBeDefined()
    expect(svc.decodeWebMToPCM).toBeDefined()
  })
})
