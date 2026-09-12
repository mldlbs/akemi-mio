import type { ToolCallIdentity } from './ToolCallIdentity'

export interface ToolIdentityProvenance {
  toolName: string
  capability: string
  operation: string
  provider: string
}

/** Non-authoritative identity metadata derived from telemetry only. */
export interface ToolIdentitySummary {
  toolName: string
  capability: string
  operation: string
  provider: string
  mixed: boolean
  provenance: ToolIdentityProvenance[]
}

/** Non-authoritative evidence for calls with incomplete identity telemetry. */
export interface UnresolvedToolIdentityStats {
  unresolvedCalls: number
  missingCapabilityCount: number
  missingOperationCount: number
  missingProviderCount: number
}

type IdentifiedToolCall = ToolCallIdentity & { toolName: string }

export function summarizeToolIdentity(calls: IdentifiedToolCall[]): ToolIdentitySummary | undefined {
  const provenanceByIdentity = new Map<string, ToolIdentityProvenance>()

  for (const call of calls) {
    if (!call.capability || !call.operation || !call.provider) continue

    const provenance: ToolIdentityProvenance = {
      toolName: call.toolName,
      capability: call.capability,
      operation: call.operation,
      provider: call.provider,
    }
    provenanceByIdentity.set(
      `${provenance.toolName}\u0000${provenance.capability}\u0000${provenance.operation}\u0000${provenance.provider}`,
      provenance,
    )
  }

  const provenance = [...provenanceByIdentity.values()]
  if (provenance.length === 0) return undefined

  const [identity] = provenance
  return {
    toolName: identity.toolName,
    capability: identity.capability,
    operation: identity.operation,
    provider: identity.provider,
    mixed: provenance.length > 1,
    provenance,
  }
}

export function summarizeUnresolvedToolIdentity(calls: IdentifiedToolCall[]): UnresolvedToolIdentityStats | undefined {
  const stats: UnresolvedToolIdentityStats = {
    unresolvedCalls: 0,
    missingCapabilityCount: 0,
    missingOperationCount: 0,
    missingProviderCount: 0,
  }

  for (const call of calls) {
    const missingCapability = !call.capability
    const missingOperation = !call.operation
    const missingProvider = !call.provider

    if (missingCapability || missingOperation || missingProvider) {
      stats.unresolvedCalls++
    }
    if (missingCapability) stats.missingCapabilityCount++
    if (missingOperation) stats.missingOperationCount++
    if (missingProvider) stats.missingProviderCount++
  }

  return stats.unresolvedCalls > 0 ? stats : undefined
}
