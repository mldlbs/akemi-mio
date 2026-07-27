export interface MCPRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: any
}

export interface MCPResponse {
  jsonrpc: '2.0'
  id: number
  result?: any
  error?: { code: number; message: string; data?: any }
}

export interface MCPToolSchema {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, { type: string; description: string }>
    required: string[]
  }
}

export interface MCPToolResult {
  content: Array<{ type: string; text?: string; [key: string]: any }>
  isError: boolean
}

export interface MCPCapabilities {
  tools?: Record<string, unknown>
  resources?: Record<string, unknown>
  prompts?: Record<string, unknown>
}

export interface MCPInitializeResult {
  protocolVersion: string
  serverInfo: { name: string; version: string }
  capabilities: MCPCapabilities
}

export interface MCPToolDefinition {
  name: string
  description: string
  parameters: Record<string, { type: string; description: string }>
  required: string[]
  serverName: string
}

import type { ChildProcess } from 'child_process'

export interface MCPServerManifest {
  id: string
  name: string
  version: string

  runtime: {
    command: string
    args: string[]
  }

  capabilities: string[]

  /**
   * M5.4: 能力级别的 canonical inputSchema。
   * key = capability id, value = 标准化的 JSON Schema。
   * 未指定时使用通用 { description } schema（满足 C-8）。
   */
  capabilitySchemas?: Record<string, {
    type: 'object'
    properties: Record<string, { type: string; description: string }>
    required: string[]
  }>

  dependencies?: {
    capability: string
    /** P1.3b Observation-B1: 实际 MCP tool name，不指定时回退到 capability id */
    tool?: string
    optional?: boolean
  }[]

  permissions: string[]
}

export interface MCPServerConfig {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  url?: string
  /** 原始用户命令字符串，用于持久化还原，如 "node servers/note-keeper/index.js" */
  rawCommand?: string
  /** 请求超时（毫秒），默认 30000 */
  requestTimeoutMs?: number
  /** 自定义 HTTP 请求头，用于 SSE/HTTP 传输模式（如 X-API-Key 认证） */
  headers?: Record<string, string>
  /** 由 ProcessManager 预先 spawn 的 ChildProcess。设置后忽略 command/args/cwd/env */
  existingProcess?: ChildProcess
}
