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
}
