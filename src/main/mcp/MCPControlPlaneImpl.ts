import { McpClient } from './McpClient'
import { MCPServerConfig, MCPToolDefinition } from './types'
import { log } from '../logger/Logger'
import { MCPControlPlane, MCPHealthStatus, MCPServerState } from './MCPControlPlane'

const PING_TIMEOUT_MS = 5000

/**
 * MCPControlPlaneImpl — MCP 协议层管理。
 *
 * 职责 (ADR-014)：
 * - MCP initialize / shutdown 协议握手
 * - MCP 健康检查 (ping/pong)
 * - 工具发现 (discoverTools)
 * - MCP Server 状态追踪
 * - Capability Registry（工具集基线 + 漂移检测）
 *
 * 不负责：
 * - 进程生命周期（ProcessManager）
 * - 重启预算（ProcessManager）
 * - 日志捕获（ProcessManager）
 * - 工具调用优先级排序（ServerManager）
 */
export class MCPControlPlaneImpl implements MCPControlPlane {
  readonly servers = new Map<string, McpClient>()
  readonly toolMap = new Map<string, { serverName: string }>()

  private healthCheckTimer: ReturnType<typeof setTimeout> | null = null
  private retryStates = new Map<string, { backoffAttempts: number; nextRetryAt: number }>()
  /** 每个 MCP 服务器的独立熔断器 */
  private circuitBreakers = new Map<string, { failures: number; state: 'closed' | 'open'; openedAt: number }>()
  /** Capability Registry: 记录每个服务器的期望和实际工具集，检测漂移 */
  private capabilityRegistry = new Map<
    string,
    { expectedTools: number; expectedToolNames: string[]; actualTools: number; actualToolNames: string[]; healthScore: number }
  >()

  constructor() {
    this.startHealthCheck()
  }

  // ==================== MCPControlPlane 接口 ====================

  async initialize(config: MCPServerConfig): Promise<McpClient | undefined> {
    if (this.servers.has(config.name)) {
      log('WARN', 'mcp_server_exists', { name: config.name })
      return undefined
    }

    const client = new McpClient(config)
    this.servers.set(config.name, client)

    try {
      await client.initialize()
      await client.discoverTools()
      this.indexServerTools(config.name, client)
      this.registerCapabilities(config.name, client)
      return client
    } catch (err: any) {
      log('ERROR', 'mcp_connect_failed', { name: config.name, error: err.message })
      this.servers.delete(config.name)
      return undefined
    }
  }

  async health(serverId: string): Promise<MCPHealthStatus> {
    const client = this.servers.get(serverId)
    if (!client) return 'disabled'

    const cb = this.circuitBreakers.get(serverId)
    if (cb && cb.state === 'open') {
      return 'failed'
    }

    try {
      const alive = await pingWithTimeout(client, PING_TIMEOUT_MS)
      if (alive) {
        return 'healthy'
      }
      return 'degraded'
    } catch {
      return 'failed'
    }
  }

  async discoverTools(serverId: string): Promise<MCPToolDefinition[]> {
    const client = this.servers.get(serverId)
    if (!client) return []

    try {
      await client.discoverTools()
      this.indexServerTools(serverId, client)
      return client.getToolDefinitions()
    } catch (err: any) {
      log('WARN', 'mcp_discovery_failed', { name: serverId, error: err.message })
      return []
    }
  }

  getState(serverId: string): MCPServerState | null {
    const client = this.servers.get(serverId)
    if (!client) return null

    const health = this.healthSync(serverId)
    return {
      name: serverId,
      status: health,
      tools: client.getToolDefinitions().map((t) => t.name),
      toolCount: client.getToolDefinitions().length,
      initialized: client.isInitialized(),
      uptimeMs: 0,
      healthScore: this.capabilityRegistry.get(serverId)?.healthScore ?? 100,
    }
  }

  listStates(): MCPServerState[] {
    return Array.from(this.servers.keys()).map((name) => {
      const state = this.getState(name)
      return state || { name, status: 'disabled', tools: [], toolCount: 0, initialized: false, uptimeMs: 0, healthScore: 0 }
    })
  }

  async addServer(config: MCPServerConfig): Promise<void> {
    await this.initialize(config)
  }

  async removeServer(name: string): Promise<void> {
    const client = this.servers.get(name)
    if (!client) return

    try {
      await client.shutdown()
    } catch {
      /* ignore */
    }

    this.servers.delete(name)
    for (const [tool, meta] of this.toolMap) {
      if (meta.serverName === name) this.toolMap.delete(tool)
    }
    this.circuitBreakers.delete(name)
    this.capabilityRegistry.delete(name)
    this.retryStates.delete(name)
    log('INFO', 'mcp_disconnected', { name })
  }

  getClient(name: string): McpClient | undefined {
    return this.servers.get(name)
  }

  getToolMap(): Map<string, { serverName: string }> {
    return this.toolMap
  }

  // ==================== 内部 ====================

  private indexServerTools(name: string, client: McpClient): void {
    // 清除旧的工具索引
    for (const [tool, meta] of this.toolMap) {
      if (meta.serverName === name) this.toolMap.delete(tool)
    }
    for (const t of client.getToolDefinitions()) {
      if (this.toolMap.has(t.name)) {
        log('WARN', 'mcp_tool_conflict', { tool: t.name, existing: this.toolMap.get(t.name)!.serverName, newServer: name })
        continue
      }
      this.toolMap.set(t.name, { serverName: name })
    }
  }

  // ==================== 健康检查 ====================

  private startHealthCheck(): void {
    this.scheduleHealthCheck()
  }

  private scheduleHealthCheck(): void {
    const baseInterval = 120000
    const jitter = Math.random() * 30000 - 15000
    const interval = Math.max(60000, baseInterval + jitter)

    this.healthCheckTimer = setTimeout(async () => {
      try {
        for (const [name, client] of this.servers) {
          const cb = this.circuitBreakers.get(name)
          if (cb && cb.state === 'open') {
            if (Date.now() - cb.openedAt > 60000) {
              cb.state = 'closed'
              cb.failures = 0
              log('INFO', 'mcp_circuit_half_open', { name })
            } else {
              continue
            }
          }
          try {
            const alive = await pingWithTimeout(client, PING_TIMEOUT_MS)
            if (alive) {
              this.recordServerSuccess(name)
              this.checkCapabilityDrift(name, client)
              continue
            }
            this.recordServerFailure(name)
            log('WARN', 'mcp_server_detected_dead', { name })
          } catch {
            this.recordServerFailure(name)
            log('WARN', 'mcp_server_health_check_failed', { name })
          }
        }
      } catch (err) {
        log('ERROR', 'mcp_health_check_error', { error: String(err) })
      }
      this.scheduleHealthCheck()
    }, interval)
  }

  private recordServerSuccess(name: string): void {
    const state = this.retryStates.get(name)
    if (state && state.backoffAttempts > 0) {
      state.backoffAttempts = 0
      state.nextRetryAt = 0
      log('INFO', 'mcp_server_recovered', { name })
    }
    const cb = this.circuitBreakers.get(name)
    if (cb) {
      cb.failures = 0
      cb.state = 'closed'
    }
  }

  private recordServerFailure(name: string): void {
    let cb = this.circuitBreakers.get(name)
    if (!cb) {
      cb = { failures: 0, state: 'closed', openedAt: 0 }
      this.circuitBreakers.set(name, cb)
    }
    cb.failures++
    if (cb.failures >= 3) {
      cb.state = 'open'
      cb.openedAt = Date.now()
      log('WARN', 'mcp_circuit_opened', { name, failures: cb.failures })
    }
  }

  private checkCapabilityDrift(name: string, client: McpClient): void {
    const toolNames = client.getToolDefinitions().map((t) => t.name)
    const entry = this.capabilityRegistry.get(name)
    if (entry && toolNames.length < entry.expectedTools) {
      const missing = entry.expectedToolNames.filter((t) => !toolNames.includes(t))
      entry.actualTools = toolNames.length
      entry.actualToolNames = toolNames
      entry.healthScore = Math.max(0, 100 - missing.length * 15)
      log('WARN', 'capability_registry.drift_detected', {
        name,
        expectedTools: entry.expectedTools,
        actualTools: toolNames.length,
        missingTools: missing,
        healthScore: entry.healthScore,
      })
    }
  }

  private registerCapabilities(name: string, client: McpClient): void {
    const toolNames = client.getToolDefinitions().map((t) => t.name)
    const toolCount = toolNames.length
    const existing = this.capabilityRegistry.get(name)
    if (!existing) {
      this.capabilityRegistry.set(name, {
        expectedTools: toolCount,
        expectedToolNames: toolNames,
        actualTools: toolCount,
        actualToolNames: toolNames,
        healthScore: 100,
      })
      log('INFO', 'capability_registry.registered', { name, tools: toolCount })
      return
    }
    const missing = existing.expectedToolNames.filter((t) => !toolNames.includes(t))
    if (missing.length > 0) {
      existing.actualTools = toolCount
      existing.actualToolNames = toolNames
      existing.healthScore = Math.max(0, 100 - missing.length * 15)
      log('WARN', 'capability_registry.drift_detected', {
        name,
        expectedTools: existing.expectedTools,
        actualTools: toolCount,
        missingTools: missing,
        healthScore: existing.healthScore,
      })
    } else {
      existing.actualTools = toolCount
      existing.actualToolNames = toolNames
      existing.healthScore = 100
    }
  }

  getCapabilitySummary(): { totalCapabilityHealth: number; servers: Array<{ name: string; healthScore: number; driftDetected: boolean }> } {
    const servers: Array<{ name: string; healthScore: number; driftDetected: boolean }> = []
    let totalScore = 0
    let count = 0
    for (const [name, entry] of this.capabilityRegistry) {
      const missing = entry.expectedToolNames.filter((t) => !entry.actualToolNames.includes(t))
      servers.push({ name, healthScore: entry.healthScore, driftDetected: missing.length > 0 })
      totalScore += entry.healthScore
      count++
    }
    return {
      totalCapabilityHealth: count > 0 ? Math.round(totalScore / count) : 100,
      servers,
    }
  }

  getCapabilityHealth(name: string): { healthScore: number; expectedTools: number; actualTools: number; missingTools: string[] } | null {
    const entry = this.capabilityRegistry.get(name)
    if (!entry) return null
    const missing = entry.expectedToolNames.filter((t) => !entry.actualToolNames.includes(t))
    return { healthScore: entry.healthScore, expectedTools: entry.expectedTools, actualTools: entry.actualTools, missingTools: missing }
  }

  /** 同步版本 health check（不发起网络请求，只根据缓存状态判定） */
  private healthSync(serverId: string): MCPHealthStatus {
    const client = this.servers.get(serverId)
    if (!client) return 'disabled'
    const cb = this.circuitBreakers.get(serverId)
    if (cb && cb.state === 'open') return 'failed'
    return client.isInitialized() ? 'healthy' : 'degraded'
  }

  /** 关闭所有连接 */
  async shutdown(): Promise<void> {
    if (this.healthCheckTimer) {
      clearTimeout(this.healthCheckTimer)
      this.healthCheckTimer = null
    }
    const shutdowns = Array.from(this.servers.entries()).map(async ([name, client]) => {
      try {
        await client.shutdown()
      } catch {
        /* ignore */
      }
    })
    await Promise.all(shutdowns)
    this.servers.clear()
    this.toolMap.clear()
    this.circuitBreakers.clear()
    this.capabilityRegistry.clear()
    this.retryStates.clear()
    log('INFO', 'mcp_control_plane_shutdown')
  }
}

// ==================== 工具函数 ====================

function pingWithTimeout(client: McpClient, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    client.ping(),
    new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error('ping timeout')), timeoutMs)),
  ])
}
