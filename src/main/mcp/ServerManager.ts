import { McpClient } from './McpClient'
import { LocalProvider } from './LocalProvider'
import { MCPServerConfig, MCPToolDefinition, MCPToolResult } from './types'
import { log } from '../logger/Logger'
import { resolve, join, relative } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { WORKSPACE_DIR } from './LocalProvider'
import { ConstitutionEngine } from '../constitution/ConstitutionEngine'
import { CapabilityEngine } from '../capability/CapabilityEngine'
import { MemoryAwareInterceptor } from './MemoryAwareInterceptor'
import type { MemoryService } from '../memory/MemoryService'
import { MemoryRetriever, ToolMemoryDefaults } from './ToolMemoryDefaults'
import { MEMORY_TOOL_PERSONALIZATION, BEHAVIOR_PREDICTOR_PRELOAD_CONFIDENCE } from '../config'
import { behaviorPredictor } from './BehaviorPredictor'

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
  private memoryInterceptor: MemoryAwareInterceptor = new MemoryAwareInterceptor()
  private memoryRetriever: MemoryRetriever = new MemoryRetriever()
  private toolDefaults: ToolMemoryDefaults = new ToolMemoryDefaults(this.memoryRetriever)
  /** 每个 MCP 服务器的独立熔断器 */
  private circuitBreakers = new Map<string, { failures: number; state: 'closed' | 'open'; openedAt: number }>()
  /** 重启预算：每小时最多 RESTART_BUDGET_MAX 次重启，超限后自动禁用 */
  private restartBudgets = new Map<string, { attempts: number[]; disabled: boolean }>()
  private readonly RESTART_BUDGET_WINDOW = 3600_000 // 1 小时
  private readonly RESTART_BUDGET_MAX = 10 // 每小时最多 10 次
  /** Capability Registry: 记录每个服务器的期望和实际工具集，检测漂移 */
  private capabilityRegistry = new Map<
    string,
    { expectedTools: number; expectedToolNames: string[]; actualTools: number; actualToolNames: string[]; healthScore: number }
  >()

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

  /** 设置 MemoryService 用于记忆感知的工具调用拦截 */
  setMemoryService(ms: MemoryService): void {
    this.memoryInterceptor.setMemoryService(ms)
    this.memoryRetriever.setMemoryService(ms)
    this.memoryInterceptor.setToolDefaults(this.toolDefaults)
    this.memoryInterceptor.setPersonalizationLevel(MEMORY_TOOL_PERSONALIZATION)
  }

  /** 获取 ToolMemoryDefaults 注册表，用于注册工具参数默认值映射 */
  getToolDefaults(): ToolMemoryDefaults {
    return this.toolDefaults
  }

  /** 获取 MemoryRetriever，用于直接检索用户偏好和工具调用历史 */
  getMemoryRetriever(): MemoryRetriever {
    return this.memoryRetriever
  }

  /** 获取 MemoryAwareInterceptor，用于动态调整个性化设置或记录反馈 */
  getMemoryInterceptor(): MemoryAwareInterceptor {
    return this.memoryInterceptor
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
      this.registerCapabilities(config.name, client)
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
    const schemas = allDefs.map((def) => ({
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

    // ★ 记忆驱动的工具优先级排序
    // 根据 Memory 中的调用频次和成功率提升高频/高成功工具的排名，
    // 使 LLM 更倾向于选择用户常用的工具。
    const priorities = this.memoryInterceptor.getToolPriorities()
    if (priorities.length > 0) {
      // 构建工具名 → boost 查找表
      const boostMap = new Map(priorities.map((p) => [p.toolName, p.boost]))

      // 稳定排序：高 boost 的工具排前面，其余保持原顺序
      schemas.sort((a, b) => {
        const boostA = boostMap.get(a.function.name) ?? 0
        const boostB = boostMap.get(b.function.name) ?? 0
        // 降序（高 boost 在前），boost 相同时保持原顺序
        return boostB - boostA || 0
      })

      log('INFO', 'memory_tool_prioritized', {
        boostedCount: priorities.filter((p) => p.boost > 0).length,
        topBoosted: priorities.slice(0, 5).map((p) => `${p.toolName}(+${p.boost})`).join(', '),
      })
    }

    return schemas
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

    // ★ 行为预激活：检查预加载缓存中是否有该工具+参数的结果
    const cacheKey = behaviorPredictor.buildCacheKey(name, args)
    const cachedResult = behaviorPredictor.getCachedResult(cacheKey)
    if (cachedResult !== null) {
      log('INFO', 'behavior_predictor_cache_used', { tool: name, cacheKey })
      // 缓存命中时仍记录调用（验证预测有效），更新模式库
      behaviorPredictor.recordCall(name, args, 0, true)
      this.memoryInterceptor.postCall(name, args, cachedResult, true)
      // 记录后预测下一步，触发后续工具的预加载
      this.recordAndPredict(name, args, cachedResult, meta.serverName)
      return cachedResult
    }

    // ★ Memory-aware 拦截：工具调用前检索相关记忆
    const memoryCtx = this.memoryInterceptor.preCall(name, args)
    let enrichedArgs = this.memoryInterceptor.enrichArgs(args, memoryCtx)

    // ★ Memory-aware 拦截：从用户偏好自动填充未提供的参数默认值
    const fillResult = this.memoryInterceptor.fillDefaults(name, enrichedArgs)
    enrichedArgs = fillResult.args

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

    let result: string
    let success = true

    try {
      if (meta.serverName === MGR) {
        result = await this.handleMgrTool(name, enrichedArgs)
      } else if (meta.serverName === this.local.name) {
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
        const toolResult = await this.local.callTool(name, enrichedArgs)
        result = this.formatResult(toolResult)
      } else {
        const client = this.servers.get(meta.serverName)
        if (!client) throw new Error(`MCP 服务器不可用: ${meta.serverName}`)
        const toolResult = await client.callTool(name, enrichedArgs)
        result = this.formatResult(toolResult)
      }

      // ★ Memory-aware 拦截：工具调用成功后存储结果摘要
      this.memoryInterceptor.postCall(name, args, result, true)

      // ★ 行为驱动预激活：记录本次调用并预测下一步
      this.recordAndPredict(name, args, result, meta.serverName)

      return result
    } catch (err: any) {
      success = false
      // ★ Memory-aware 拦截：工具调用失败也记录（低置信度）
      this.memoryInterceptor.postCall(name, args, err.message || String(err), false)

      // ★ 行为驱动预激活：即使调用失败也记录行为（但 success=false）
      behaviorPredictor.recordCall(name, args, 0, false)

      throw err
    }
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
              // 健康时校验工具集是否漂移
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

  /** Capability Registry v0: 注册/更新服务器工具集，检测漂移 */
  private registerCapabilities(name: string, client: McpClient): void {
    const toolNames = client.getToolDefinitions().map((t) => t.name)
    const toolCount = toolNames.length
    const existing = this.capabilityRegistry.get(name)
    if (!existing) {
      // 首次连接：记录 expected 基线
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
    // 后续连接：对比实际 vs 预期，检测漂移
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

  /** 获取所有服务器的能力健康汇总 */
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

  /** 查询服务器的能力健康状态 */
  getCapabilityHealth(name: string): { healthScore: number; expectedTools: number; actualTools: number; missingTools: string[] } | null {
    const entry = this.capabilityRegistry.get(name)
    if (!entry) return null
    const missing = entry.expectedToolNames.filter((t) => !entry.actualToolNames.includes(t))
    return { healthScore: entry.healthScore, expectedTools: entry.expectedTools, actualTools: entry.actualTools, missingTools: missing }
  }

  /** 检查并记录重启预算。预算超限返回 false，不再自动重启 */
  private checkRestartBudget(name: string): boolean {
    let budget = this.restartBudgets.get(name)
    if (!budget) {
      budget = { attempts: [], disabled: false }
      this.restartBudgets.set(name, budget)
    }
    const now = Date.now()
    // 清理过期记录
    budget.attempts = budget.attempts.filter((t) => now - t < this.RESTART_BUDGET_WINDOW)
    // 如果 disabled 但所有记录已过期，自动恢复
    if (budget.disabled && budget.attempts.length === 0) {
      budget.disabled = false
      log('INFO', 'mcp_restart_budget_recovered', { name })
    }
    if (budget.disabled) return false
    if (budget.attempts.length >= this.RESTART_BUDGET_MAX) {
      budget.disabled = true
      log('ERROR', 'mcp_restart_budget_exhausted', { name, maxPerHour: this.RESTART_BUDGET_MAX })
      return false
    }
    budget.attempts.push(now)
    return true
  }

  /** 带指数退避的重启 */
  private async restartServerWithBackoff(name: string): Promise<void> {
    if (!this.checkRestartBudget(name)) {
      log('WARN', 'mcp_restart_budget_exceeded', { name })
      return
    }
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

  // ══════════════════════════════════════════
  //  行为驱动预激活：记录 + 预测 + 预加载
  // ══════════════════════════════════════════

  /**
   * 记录工具调用到 BehaviorPredictor，然后预测后续工具并触发异步预加载。
   *
   * 预加载条件：
   * - 预测置信度 >= BEHAVIOR_PREDICTOR_PRELOAD_CONFIDENCE 阈值
   * - 预测工具存在于 toolMap 中
   * - 预测工具有对应的服务器可用
   *
   * 预加载策略：
   * - 只读工具（read/grep/list）优先预加载（副作用小）
   * - 写入/命令类工具跳过预加载（避免意外副作用）
   * - 异步执行，不阻塞当前请求
   */
  private recordAndPredict(
    currentTool: string,
    args: Record<string, any>,
    result: string,
    serverName: string,
  ): void {
    // 记录当前调用
    behaviorPredictor.recordCall(currentTool, args, 0, true)

    // 预测后续工具
    const predictions = behaviorPredictor.predict(currentTool)

    // 对高置信度预测触发预加载
    for (const prediction of predictions) {
      if (prediction.confidence < BEHAVIOR_PREDICTOR_PRELOAD_CONFIDENCE) continue

      const predictedTool = prediction.toolName

      // 写入/命令类工具跳过预加载（避免意外副作用）
      if (FILE_WRITE_TOOLS.has(predictedTool) || SHELL_TOOLS.has(predictedTool)) {
        log('DEBUG', 'behavior_predictor_skip_write_tool', { tool: predictedTool })
        continue
      }

      // 查找工具所在服务器
      const predictedMeta = this.toolMap.get(predictedTool)
      if (!predictedMeta) continue

      // 异步预加载（不阻塞）
      this.triggerPreload(predictedTool, predictedMeta.serverName)
    }
  }

  /**
   * 触发单个工具的异步预加载。
   *
   * 预加载策略（按优先级）：
   * 1. 无必需参数的工具 → 用空参数预执行并缓存结果（如 list_* 工具）
   * 2. 外部 MCP 服务器 → 探活 + 连接预热（降低冷启动延迟）
   * 3. 有必需参数的工具 → 跳过（无法预测参数值）
   * 4. 管理工具 → 跳过
   *
   * 预加载结果缓存键使用空参数构建，因此只有无必需参数的
   * 只读工具（list_files 等）能命中缓存。对有参数需求的工具，
   * 预加载效果体现在 MCP 服务器连接预热上。
   */
  private triggerPreload(
    toolName: string,
    serverName: string,
  ): void {
    if (serverName === MGR) return

    // 查询工具定义，判断是否有必需参数
    const defs = this.getAllDefinitions()
    const toolDef = defs.find((d) => d.name === toolName)
    const hasRequiredParams = toolDef && toolDef.required.length > 0

    if (serverName === this.local.name) {
      if (!hasRequiredParams && FILE_READ_TOOLS.has(toolName)) {
        // 无必需参数的只读工具：用空参数预执行并缓存
        const noArgCacheKey = behaviorPredictor.buildCacheKey(toolName, {})
        behaviorPredictor.preloadTool(
          noArgCacheKey,
          serverName,
          toolName,
          {},
          async (name, preloadArgs) => {
            const toolResult = await this.local.callTool(name, preloadArgs)
            return this.formatResult(toolResult)
          },
        ).catch(() => { /* 预加载失败不抛出 */ })
      }
      // 有必需参数的工具跳过预执行，仅通过行为记录预热
    } else {
      // 外部 MCP 服务器：连接预热（先确保初始化完成）
      const client = this.servers.get(serverName)
      if (client && !client.isInitialized()) {
        client.initialize().catch(() => {
          log('WARN', 'behavior_predictor_prewarm_failed', { server: serverName })
        })
      }

      // 无必需参数的只读工具：可安全预执行
      if (client && client.isInitialized() && !hasRequiredParams && FILE_READ_TOOLS.has(toolName)) {
        const noArgCacheKey = behaviorPredictor.buildCacheKey(toolName, {})
        behaviorPredictor.preloadTool(
          noArgCacheKey,
          serverName,
          toolName,
          {},
          async (name, preloadArgs) => {
            const toolResult = await client.callTool(name, preloadArgs)
            return this.formatResult(toolResult)
          },
        ).catch(() => { /* 预加载失败不抛出 */ })
      }
    }
  }
}
