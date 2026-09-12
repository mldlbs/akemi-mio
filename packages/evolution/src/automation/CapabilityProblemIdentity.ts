export interface CapabilityProblemIdentity {
  capability: string
  operation: string
  issueType: string
  version?: string
}

export const CAPABILITY_PROBLEM_IDENTITY_VERSION = 'm56.v1'

export function normalizeCapabilityProblemIdentity(input: CapabilityProblemIdentity): CapabilityProblemIdentity {
  return {
    capability: input.capability,
    operation: input.operation,
    issueType: input.issueType,
    version: input.version ?? CAPABILITY_PROBLEM_IDENTITY_VERSION,
  }
}

export function buildCapabilityProblemIdentityKey(identity: CapabilityProblemIdentity): string {
  const normalized = normalizeCapabilityProblemIdentity(identity)

  return [
    `capability:${normalized.capability}`,
    `operation:${normalized.operation}`,
    `issue:${normalized.issueType}`,
    `version:${normalized.version}`,
  ].join('|')
}
