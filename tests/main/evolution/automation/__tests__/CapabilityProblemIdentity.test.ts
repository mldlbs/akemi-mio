import { describe, expect, it } from 'vitest'

import {
  buildCapabilityProblemIdentityKey,
  CAPABILITY_PROBLEM_IDENTITY_VERSION,
  normalizeCapabilityProblemIdentity,
} from '@akemi-mio/evolution/automation/CapabilityProblemIdentity'

describe('CapabilityProblemIdentity', () => {
  it('applies the default identity version during normalization', () => {
    expect(
      normalizeCapabilityProblemIdentity({
        capability: 'file.management',
        operation: 'write',
        issueType: 'error_rate',
      }),
    ).toEqual({
      capability: 'file.management',
      operation: 'write',
      issueType: 'error_rate',
      version: CAPABILITY_PROBLEM_IDENTITY_VERSION,
    })
  })

  it('builds a stable capability identity key', () => {
    const identity = normalizeCapabilityProblemIdentity({
      capability: 'browser.automation',
      operation: 'navigate',
      issueType: 'timeout',
      version: 'm56.v1',
    })

    expect(buildCapabilityProblemIdentityKey(identity)).toBe(
      'capability:browser.automation|operation:navigate|issue:timeout|version:m56.v1',
    )
  })
})
