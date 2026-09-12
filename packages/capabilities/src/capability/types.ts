/**
 * Capability Sandbox 类型定义
 *
 * 两个层次：
 * 1. Permission Layer（已存在）— CapabilityAction: action-level sandbox
 * 2. Semantic Layer（ADR-015 新增）— CapabilityDefinition: task → provider → tool
 */

// ══════════════════════════════════════════
// Permission Layer (existing)
// ══════════════════════════════════════════

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

// ══════════════════════════════════════════
// Semantic Capability Layer (ADR-015)
// ══════════════════════════════════════════

/**
 * 语义 Capability 定义 — 描述系统能完成的"任务"。
 *
 * 例：
 * {
 *   id: "publishing",
 *   description: "发布内容到外部内容平台",
 *   inputSchema: { type: "object", properties: { title: {...}, content: {...} }, required: ["title"] },
 *   providers: [{ mcpServerId: "fanqie", tools: ["publish_novel", "draft"], defaultTool: "publish_novel" }]
 * }
 *
 * ADR-015 C-8 (P1.3a): inputSchema 不允许为空（properties 和 required 均非空）
 */
export interface CapabilityDefinition {
  id: string
  description: string
  /** P1.3a: 用于生成 function calling schema 的 parameters。
   *  M1 阶段从 provider 的 tool schema 推断。禁止为空 {}。 */
  inputSchema: {
    type: 'object'
    properties: Record<string, { type: string; description: string }>
    required: string[]
  }
  providers: CapabilityProvider[]
}

/**
 * CapabilityProviderAdapter — 将 canonical capability input 转换为 provider-specific tool params。
 *
 * P1.3b D3 (Capability Schema Ownership):
 * - Capability 拥有 canonical inputSchema，Provider 适配器负责转换
 * - 例如: publishing 的 canonical input { title, content, platform? }
 *           → fanqie adapter 转换为 { novelName, content, category }
 * - 无 adapter 时: input 直接透传给 provider tool（向后兼容）
 */
export type CapabilityProviderAdapter = (input: unknown, tool: string) => unknown

export interface CapabilityProvider {
  /** MCP Registry 中的 server id */
  mcpServerId: string
  /** 该服务器提供此 capability 时使用的工具列表 */
  tools: string[]
  /** 默认工具，当有多个工具可用时使用 */
  defaultTool?: string
  /** P1.3b: canonical input → provider-specific params */
  adapter?: CapabilityProviderAdapter
}

export interface ResolveResult {
  capabilityId: string
  provider: {
    mcpServerId: string
    tool: string
  }
  confidence: 1.0
}

// ══════════════════════════════════════════
// Capability Invocation (ADR-015 M5.2)
// ══════════════════════════════════════════

/**
 * CapabilityBinding — resolve 后的固定绑定结果。
 *
 * Agent/business 层通过此 binding 调用能力，
 * 不直接接触 MCP server id 或 tool name。
 */
export interface CapabilityBinding {
  capability: string
  provider: {
    type: 'mcp'
    id: string
  }
  tool: string
}

/**
 * CapabilityService — Agent 和 MCP 的隔离层。
 *
 * Agent 只通过 capability id 和 input 交互：
 * - resolve(capability) → 发现谁能提供
 * - invoke(binding, input) → 执行能力
 *
 * Agent 永远不知道：
 * - MCP server id
 * - tool name
 * - transport protocol
 */
export interface ICapabilityService {
  resolve(capability: string, toolHint?: string): Promise<CapabilityBinding | undefined>
  invoke(binding: CapabilityBinding, input: unknown): Promise<unknown>
  listCapabilities(): string[]
}

