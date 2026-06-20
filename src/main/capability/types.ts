/**
 * Capability Sandbox 类型定义
 */

/** 能力动作 — 粒度操作单元 */
export type CapabilityAction =
  | 'file.read'
  | 'file.write'
  | 'file.delete'
  | 'llm.call'
  | 'llm.call.chat'
  | 'llm.call.code'
  | 'shell.execute'
  | 'network.connect'
  | 'network.http'
  | 'memory.read'
  | 'memory.write'
  | 'mcp.call'
  | 'evolution.analyze'
  | 'evolution.execute'
  | 'evolution.rollback'

/** 能力令牌 */
export interface CapabilityToken {
  id: string
  action: CapabilityAction
  resource?: string // glob pattern
  constraints?: {
    maxCalls?: number
    maxTokens?: number
    expiryMs?: number
    allowedValues?: Record<string, string[]>
  }
  issuedBy: string
  issuedAt: number
  expiresAt?: number
  delegatedFrom?: string // parent token ID
}

/** 能力请求 */
export interface CapabilityRequest {
  action: CapabilityAction
  resource?: string
  context: {
    caller: string
    taskId?: string
    requestId: string
    metadata?: Record<string, any>
  }
}

/** 能力决策 */
export interface CapabilityDecision {
  granted: boolean
  token?: CapabilityToken
  reason?: string
  auditEntry: AuditEntry
}

/** 审计条目 */
export interface AuditEntry {
  requestId: string
  action: CapabilityAction
  resource?: string
  caller: string
  granted: boolean
  reason?: string
  timestamp: number
}
