import { McpClient } from './McpClient'
import { LocalProvider } from './LocalProvider'
import { type MCPServerConfig, type MCPToolDefinition } from './types'
import { log } from '@akemi-mio/core/logger/Logger'

// ==================== Types ====================

export type MCPHealthStatus = 'healthy' | 'degraded' | 'failed' | 'disabled'

export interface MCPServerState {
  name: string
  status: MCPHealthStatus
  tools: string[]
  toolCount: number
  initialized: boolean
  uptimeMs: number
  healthScore: number
}

export interface MCPControlPlane {
  initialize(config: MCPServerConfig): Promise<McpClient | undefined>
  health(serverId: string): Promise<MCPHealthStatus>
  discoverTools(serverId: string): Promise<MCPToolDefinition[]>
  getState(serverId: string): MCPServerState | null
  listStates(): MCPServerState[]
  addServer(config: MCPServerConfig): Promise<void>
  removeServer(name: string): Promise<void>
  getClient(name: string): McpClient | undefined
  getToolMap(): Map<string, { serverName: string }>
}

// ==================== PING 超时 ====================

const PING_TIMEOUT_MS = 5000
