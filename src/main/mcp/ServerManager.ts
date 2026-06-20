import { McpClient } from './McpClient'
import { LocalProvider } from './LocalProvider'
import { MCPServerConfig, MCPToolDefinition, MCPToolResult } from './types'
import { log } from '../logger/Logger'
import { resolve, join, relative } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { WORKSPACE_DIR } from './LocalProvider'
import { ConstitutionEngine } from '../constitution/ConstitutionEngine'
import { CapabilityEngine } from '../capability/CapabilityEngine'

const FILE_WRITE_TOOLS = new Set(['write_file', 'edit_file'])
const FILE_READ_TOOLS = new Set(['read_file', 'list_files', 'grep'])
const SHELL_TOOLS = new Set(['run_command'])

const MGR = '@builtin/mcp-mgr'
const SERVERS_CONFIG_PATH = join(WORKSPACE_DIR, 'mcp_servers.json')

interface PersistedServerConfig {
  name: string
  /** 原始命令字符串，如 "node servers/note-keeper/index.js" */
  command: string
  /** 工作子目录，相对于 mcp_workspace。省略则使用 mcp_workspace 根目录 */
  cwd?: string
  /** 传输类型 (stdio/http/sse)，默认 stdio */
  transport?: string
  /** HTTP/SSE 模式时的 URL */
  url?: string
  /** 请求超时（毫秒），默认 60000 */
  requestTimeoutMs?: number
}

const MGR_TOOLS: MCPToolDefinition[] = [
  {
    name: 'list_mcp_servers',
    description: '列出所有已注册的外部 MCP 服务器及其状态',
    parameters: {},
    required: [],
    serverName: MGR,
  },
  {
    name: 'remove_mcp_server',
    description: '关闭并移除一个已注册的 MCP 服务器',
    parameters: {
      name: { type: 'string', description: '要移除的服务器名称' },
    },
    required: ['name'],
    serverName: MGR,
  },
  {
    name: 'connect_mcp_server',
    description: '连接一个远程 MCP 服务器 (HTTP/SSE 协议)',
    parameters: {
      name: { type: 'string', description: '服务器名称' },
      url: { type: 'string', description: 'MCP 服务器 URL，如 http://192.168.1.100:3000/mcp 或 https://example.com/mcp/sse' },
      transport: { type: 'string', description: '传输协议，可选 http 或 sse，默认根据 URL 自动判断（/sse 结尾为 sse）' },
    },
    required: ['name', 'url'],
    serverName: MGR,
  },
]

export class ServerManager {
  private servers = new Map<string, McpClient>()
  private local: LocalProvider
  private toolMap = new Map<string, { serverName: string }>()
  private healthCheckTimer: ReturnType<typeof setTimeout> | null = null
  private retryStates = new Map<string, { backoffAttempts: number; nextRetryAt: number }>()
  private constitutionEngine: ConstitutionEngine | null = null
  private capabilityEngine: CapabilityEngine | null = null
  /** 每个 MCP 服务器的独立熔断器 */
  private circuitBreakers = new Map<string, { failures: number; state: 'closed' | 'open'; openedAt: number }>()

  constructor() {
    this.local = new LocalProvider()
    this.indexLocalTools()
    this.indexMgrTools()
    this.initServers()
    this.startHealthCheck()
  }

  setConstitutionEngine(engine: ConstitutionEngine): void {
    this.constitutionEngine = engine
  }

  /** Phase 4: 设置 CapabilityEngine 用于工具调用授权 */
  setCapabilityEngine(engine: CapabilityEngine): void {
    this.capabilityEngine = engine
  }

  /** 从 mcp_servers.json 自动恢复持久化的 MCP 服务器 */
  private initServers(): void {
    if (!existsSync(SERVERS_CONFIG_PATH)) return
    let entries: PersistedServerConfig[]
    try {
      entries = JSON.parse(readFileSync(SERVERS_CONFIG_PATH, 'utf-8'))
    } catch (err) {
      log('WARN', 'mcp_config_read_failed', { error: String(err) })
      return
    }
    for (const entry of entries) {
      if (entry.transport === 'http' || entry.transport === 'sse' || entry.url) {
        // HTTP/SSE 模式
        const transport = entry.transport || (entry.url?.endsWith('/sse') ? 'sse' : 'http')
        const config: MCPServerConfig = {
          name: entry.name,
          transport: transport as 'http' | 'sse',
          url: entry.url || entry.command,
          requestTimeoutMs: entry.requestTimeoutMs ?? 60000,
        }
        this.addServer(config).catch(() => {
          log('WARN', 'mcp_auto_connect_failed', { name: entry.name })
        })
      } else {
        // stdio 模式（向后兼容）
        const config: MCPServerConfig = {
          name: entry.name,
          transport: 'stdio',
          command: process.platform === 'win32' ? 'cmd' : 'bash',
          args: process.platform === 'win32' ? ['/c', entry.command] : ['-c', entry.command],
          cwd: WORKSPACE_DIR,
        }
        this.addServer(config).catch(() => {
          log('WARN', 'mcp_auto_connect_failed', { name: entry.name })
        })
      }
    }
    log('INFO', 'mcp_servers_restored', { count: entries.length })
  }

  /** 持久化当前所有外部 MCP 服务器配置到 mcp_servers.json */
  private persistServers(): void {
    const entries: PersistedServerConfig[] = []
    for (const [name, client] of this.servers) {
      if (client.transportType === 'stdio') {
        const clientCwd = client.cwd
        const rel = clientCwd ? relative(WORKSPACE_DIR, clientCwd) : ''
        entries.push({ name, command: client.getLaunchCommand() || '', cwd: rel || undefined })
      } else {
        entries.push({
          name,
          command: '',
          transport: client.transportType,
          url: client.url || undefined,
          requestTimeoutMs: client.requestTimeoutMs,
        })
      }
    }
    // 非空时才覆写文件，避免 shutdownAll 清掉已有配置
    if (entries.length === 0) return
    try {
      if (!existsSync(WORKSPACE_DIR)) {
        mkdirSync(WORKSPACE_DIR, { recursive: true })
      }
      writeFileSync(SERVERS_CONFIG_PATH, JSON.stringify(entries, null, 2), 'utf-8')
    } catch (err) {
      log('WARN', 'mcp_config_write_failed', { error: String(err) })
    }
  }

  private indexLocalTools(): void {
    for (const t of this.local.getToolDefinitions()) {
      this.toolMap.set(t.name, { serverName: this.local.name })
    }
  }

  private indexMgrTools(): void {
    for (const t of MGR_TOOLS) {
      this.toolMap.set(t.name, { serverName: MGR })
    }
  }

  async addServer(config: MCPServerConfig): Promise<void> {
    if (this.servers.has(config.name)) {
      log('WARN', 'mcp_server_exists', { name: config.name })
      return
    }
    log('INFO', 'mcp_connecting', { name: config.name, transport: config.transport })
    const client = new McpClient(config)
    this.servers.set(config.name, client)
    try {
      await client.initialize()
      await client.discoverTools()
      for (const t of client.getToolDefinitions()) {
        if (this.toolMap.has(t.name)) {
          log('WARN', 'mcp_tool_conflict', { tool: t.name, existing: this.toolMap.get(t.name)!.serverName, newServer: config.name })
          continue
        }
        this.toolMap.set(t.name, { serverName: config.name })
      }
      log('INFO', 'mcp_connected', { name: config.name, tools: client.getToolDefinitions().length })
    } catch (err: any) {
      log('ERROR', 'mcp_connect_failed', { name: config.name, error: err.message })
      this.servers.delete(config.name)
    }
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
    log('INFO', 'mcp_disconnected', { name })
  }

  getAllSchemas(): Array<{
    type: 'function'
    function: {
      name: string
      description: string
      parameters: {
        type: 'object'
        properties: Record<string, { type: string; description: string }>
        required: string[]
      }
    }
  }> {
    const allDefs = this.getAllDefinitions()
    return allDefs.map((def) => ({
      type: 'function' as const,
      function: {
        name: def.name,
        description: def.description,
        parameters: {
          type: 'object' as const,
          properties: def.parameters,
          required: def.required,
        },
      },
    }))
  }

  getAllDefinitions(): MCPToolDefinition[] {
    const seen = new Set<string>()
    const defs: MCPToolDefinition[] = []

    for (const t of this.local.getToolDefinitions()) {
      if (this.toolMap.has(t.name) && !seen.has(t.name)) {
        seen.add(t.name)
        defs.push(t)
      }
    }

    for (const t of MGR_TOOLS) {
      if (!seen.has(t.name)) {
        seen.add(t.name)
        defs.push(t)
      }
    }

    for (const [name, client] of this.servers) {
      if (!client.isInitialized()) continue
      for (const t of client.getToolDefinitions()) {
        if (this.toolMap.has(t.name) && this.toolMap.get(t.name)!.serverName === name && !seen.has(t.name)) {
          seen.add(t.name)
          defs.push(t)
        }
      }
    }

    return defs
  }

  hasTool(name: string): boolean {
    return this.toolMap.has(name)
  }

  async callTool(name: string, args: Record<string, any>): Promise<string> {
    const meta = this.toolMap.get(name)
    if (!meta) {
      throw new Error(`未知工具: ${name}`)
    }

    // ★ Phase 4: Capability Sandbox（替换旧的硬编码检查）
    const caller = meta.serverName
    if (this.capabilityEngine && meta.serverName !== MGR) {
      // 通过 CapabilityEngine 统一授权
      const action = this.toolNameToCapability(name)
      const allowed = this.capabilityEngine.checkCallAllowed(action, args?.path, caller)
      if (!allowed) {
        throw new Error(`[Capability] ${caller} 不允许执行 ${name} (需要 ${action} 能力)`)
      }
    } else if (meta.serverName !== this.local.name && meta.serverName !== MGR) {
      // 回退：旧版 Constitution 检查（当 CapabilityEngine 未设置时）
      if (FILE_WRITE_TOOLS.has(name) && this.constitutionEngine) {
        const targetPath = args?.path
        if (targetPath) {
          const resolvedPath = resolve(typeof targetPath === 'string' ? targetPath : String(targetPath))
          const check = this.constitutionEngine.checkWrite(resolvedPath)
          if (!check.allowed) {
            throw new Error(`Constitution 拒绝写入: ${resolvedPath} — ${check.violation?.reason || '路径受保护'}`)
          }
        }
      }
      if (SHELL_TOOLS.has(name)) {
        throw new Error(`[Sandbox] 外部 MCP 服务器不允许执行 shell 命令: ${name}`)
      }
    }

    if (meta.serverName === MGR) {
      return this.handleMgrTool(name, args)
    }

    if (meta.serverName === this.local.name) {
      // Constitution check for file-write operations
      if (this.constitutionEngine && (name === 'write_file' || name === 'edit_file')) {
        const targetPath = args?.path
        if (targetPath) {
          const resolvedPath = resolve(typeof targetPath === 'string' ? targetPath : String(targetPath))
          const check = this.constitutionEngine.checkWrite(resolvedPath)
          if (!check.allowed) {
            throw new Error(`Constitution 拒绝写入: ${resolvedPath} — ${check.violation?.reason || '路径受保护'}`)
          }
        }
      }
      const result = await this.local.callTool(name, args)
      return this.formatResult(result)
    }

    const client = this.servers.get(meta.serverName)
    if (!client) throw new Error(`MCP 服务器不可用: ${meta.serverName}`)

    const result = await client.callTool(name, args)
    return this.formatResult(result)
  }

  private async handleMgrTool(name: string, args: Record<string, any>): Promise<string> {
    switch (name) {
      case 'list_mcp_servers': {
        const servers = this.listServers()
        const lines = servers.map((s) => `${s.name} [${s.initialized ? '在线' : '离线'}] ${s.tools} 个工具`)
        return lines.join('\n')
      }

      case 'remove_mcp_server': {
        await this.removeServer(args.name)
        this.persistServers()
        return `MCP 服务器 "${args.name}" 已移除`
      }

      case 'connect_mcp_server': {
        const name = args.name
        const url = args.url
        const transport = args.transport || (url.endsWith('/sse') ? 'sse' : 'http')
        const config: MCPServerConfig = {
          name,
          transport: transport as 'http' | 'sse',
          url,
          requestTimeoutMs: args.requestTimeoutMs ?? 60000,
        }
        await this.addServer(config)
        this.persistServers()
        return `MCP 服务器 "${name}" 已连接 (${transport}: ${url})`
      }

      default:
        throw new Error(`未知管理工具: ${name}`)
    }
  }

  private formatResult(result: MCPToolResult): string {
    const text = result.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text || '')
      .join('\n')
    if (result.isError) throw new Error(text)
    return text
  }

  listTools(): string[] {
    return Array.from(this.toolMap.keys())
  }

  listServers(): Array<{ name: string; initialized: boolean; tools: number }> {
    const servers: Array<{ name: string; initialized: boolean; tools: number }> = [
      { name: this.local.name, initialized: true, tools: this.local.getToolDefinitions().length },
    ]
    for (const [name, client] of this.servers) {
      servers.push({ name, initialized: client.isInitialized(), tools: client.getToolDefinitions().length })
    }
    return servers
  }

  async shutdownAll(): Promise<void> {
    if (this.healthCheckTimer) {
      clearTimeout(this.healthCheckTimer)
      this.healthCheckTimer = null
    }
    for (const [name, client] of this.servers) {
      try {
        await client.shutdown()
      } catch {
        /* ignore */
      }
    }
    this.servers.clear()
    this.toolMap.clear()
    this.indexLocalTools()
    log('INFO', 'mcp_all_shutdown')
  }

  /** 定期健康检查：检测死亡 MCP 进程并自动重启
   *  连接失败后使用指数退避：2s→4s→8s→...→最大60s
   *  成功恢复后重置计数器。
   *
   *  使用递归 setTimeout + jitter 避免大量服务器同时请求：
   *  基础间隔 120s ±15s jitter，熔断中的服务器跳过健康检查。 */
  private startHealthCheck(): void {
    this.scheduleHealthCheck()
  }

  private scheduleHealthCheck(): void {
    const baseInterval = 120000
    const jitter = Math.random() * 30000 - 15000 // ±15s
    const interval = Math.max(60000, baseInterval + jitter) // 105s-135s
    this.healthCheckTimer = setTimeout(async () => {
      try {
        for (const [name, client] of this.servers) {
          // 熔断中的服务器跳过健康检查
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
            const alive = await client.ping()
            if (alive) {
              this.recordServerSuccess(name)
              continue
            }
            this.recordServerFailure(name)
            log('WARN', 'mcp_server_detected_dead', { name })
            await this.restartServerWithBackoff(name)
          } catch {
            this.recordServerFailure(name)
            log('WARN', 'mcp_server_health_check_failed', { name })
            await this.restartServerWithBackoff(name)
          }
        }
      } catch (err) {
        log('ERROR', 'mcp_health_check_error', { error: String(err) })
      }
      this.scheduleHealthCheck()
    }, interval)
  }

  /** 记录服务器成功 — 重置熔断器 */
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

  /** 记录服务器失败 — 连续 3 次触发熔断 60s */
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

  /** 带指数退避的重启 */
  private async restartServerWithBackoff(name: string): Promise<void> {
    const now = Date.now()
    let state = this.retryStates.get(name)
    if (!state) {
      state = { backoffAttempts: 0, nextRetryAt: 0 }
      this.retryStates.set(name, state)
    }
    if (now < state.nextRetryAt) return
    const delayMs = Math.min(2000 * Math.pow(2, state.backoffAttempts), 60000)
    state.backoffAttempts++
    state.nextRetryAt = now + delayMs
    log('INFO', 'mcp_server_restarting_backoff', { name, attempt: state.backoffAttempts, delayMs })
    await this.restartServer(name)
  }

  /** 重启单个 MCP 服务器：移除旧连接 → 重新从持久化配置注册 */
  private async restartServer(name: string): Promise<void> {
    log('INFO', 'mcp_server_restarting', { name })
    await this.removeServer(name)

    // 从持久化配置读取并重新注册
    if (!existsSync(SERVERS_CONFIG_PATH)) return
    try {
      const entries: PersistedServerConfig[] = JSON.parse(readFileSync(SERVERS_CONFIG_PATH, 'utf-8'))
      const entry = entries.find((e) => e.name === name)
      if (!entry) return

      let config: MCPServerConfig
      if (entry.transport === 'http' || entry.transport === 'sse' || entry.url) {
        const transport = entry.transport || (entry.url?.endsWith('/sse') ? 'sse' : 'http')
        config = {
          name: entry.name,
          transport: transport as 'http' | 'sse',
          url: entry.url || entry.command,
          requestTimeoutMs: entry.requestTimeoutMs ?? 60000,
        }
      } else {
        config = {
          name: entry.name,
          transport: 'stdio',
          command: process.platform === 'win32' ? 'cmd' : 'bash',
          args: process.platform === 'win32' ? ['/c', entry.command] : ['-c', entry.command],
          cwd: WORKSPACE_DIR,
        }
      }
      await this.addServer(config)
    } catch (err) {
      log('ERROR', 'mcp_server_restart_failed', { name, error: String(err) })
    }
  }

  /** Phase 4: 工具名 → CapabilityAction 映射 */
  private toolNameToCapability(toolName: string): import('../capability/types').CapabilityAction {
    if (toolName === 'write_file' || toolName === 'edit_file') return 'file.write'
    if (toolName === 'read_file' || toolName === 'list_files' || toolName === 'grep') return 'file.read'
    if (toolName === 'delete_file') return 'file.delete'
    if (toolName === 'run_command') return 'shell.execute'
    if (toolName.startsWith('llm.') || toolName === 'chat') return 'llm.call'
    if (toolName.startsWith('memory_')) return 'memory.read'
    if (toolName.startsWith('mcp_')) return 'mcp.call'
    if (toolName.startsWith('evolution_')) return 'evolution.analyze'
    return 'mcp.call'
  }
}
