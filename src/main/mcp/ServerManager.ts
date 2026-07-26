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
import { MemoryResourceProvider } from './MemoryResourceProvider'
import type { MemoryResourceDefinition, ResourceContent } from './MemoryResourceProvider'
import { setMemoryResourceProvider } from '../tool/deps'
import { MEMORY_TOOL_PERSONALIZATION, BEHAVIOR_PREDICTOR_PRELOAD_CONFIDENCE } from '../config'
import { behaviorPredictor } from './BehaviorPredictor'
import { toolCallLogStore } from '../tool/ToolCallLogStore'
import { toolCallMemoryCache } from '../tool/ToolCallMemoryCache'
import { classifyToolError } from '../tool/ToolErrorType'
import { toolAnalytics } from '../tool/ToolAnalytics'
import type { ProcessManager } from '../core/ProcessManager'
import { MCPControlPlaneImpl } from './MCPControlPlaneImpl'

const FILE_WRITE_TOOLS = new Set(['write_file', 'edit_file'])
const FILE_READ_TOOLS = new Set(['read_file', 'list_files', 'grep'])
const SHELL_TOOLS = new Set(['run_command'])

const MGR = '@builtin/mcp-mgr'
const SERVERS_CONFIG_PATH = join(WORKSPACE_DIR, 'mcp_servers.json')

interface PersistedServerConfig {
  name: string
  command: string
  cwd?: string
  transport?: string
  url?: string
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
      url: { type: 'string', description: 'MCP 服务器 URL' },
      transport: { type: 'string', description: '传输协议，可选 http 或 sse' },
    },
    required: ['name', 'url'],
    serverName: MGR,
  },
]

/**
 * ServerManager — 工具注册、路由和调用管理。
 *
 * M2 重构后 (ADR-014)：
 * - 不再包含进程生命周期（→ ProcessManager）
 * - 不再包含 MCP 协议健康检查（→ MCPControlPlane）
 * - 不再包含 MCP initialize/discover（→ MCPControlPlane）
 *
 * ServerManager 保留：
 * - 工具列表合并 (local + MGR + MCP)
 * - 工具调用路由 (callTool)
 * - 内存驱动的优先级排序 (MemoryAwareInterceptor)
 * - 行为预激活 (BehaviorPredictor)
 * - MCP 服务器持久化 (initServers/persistServers)
 * - 权限检查 (Constitution/CapabilityEngine)
 */
export class ServerManager {
  private local: LocalProvider
  private toolMap = new Map<string, { serverName: string }>()
  private constitutionEngine: ConstitutionEngine | null = null
  private capabilityEngine: CapabilityEngine | null = null
  private memoryInterceptor: MemoryAwareInterceptor = new MemoryAwareInterceptor()
  private memoryRetriever: MemoryRetriever = new MemoryRetriever()
  private toolDefaults: ToolMemoryDefaults = new ToolMemoryDefaults(this.memoryRetriever)
  private memoryResourceProvider: MemoryResourceProvider = new MemoryResourceProvider()
  private processManager: ProcessManager | null = null
  private controlPlane: MCPControlPlaneImpl

  constructor(processManager?: ProcessManager) {
    this.processManager = processManager || null
    this.controlPlane = new MCPControlPlaneImpl()
    this.local = new LocalProvider()
    this.indexLocalTools()
    this.indexMgrTools()
    this.initServers()
  }

  setProcessManager(pm: ProcessManager): void {
    this.processManager = pm
  }

  setConstitutionEngine(engine: ConstitutionEngine): void {
    this.constitutionEngine = engine
  }

  setCapabilityEngine(engine: CapabilityEngine): void {
    this.capabilityEngine = engine
  }

  setMemoryService(ms: MemoryService): void {
    this.memoryInterceptor.setMemoryService(ms)
    this.memoryRetriever.setMemoryService(ms)
    this.memoryInterceptor.setToolDefaults(this.toolDefaults)
    this.memoryInterceptor.setPersonalizationLevel(MEMORY_TOOL_PERSONALIZATION)
    this.memoryResourceProvider.setMemoryService(ms)
    setMemoryResourceProvider(this.memoryResourceProvider)
  }

  getToolDefaults(): ToolMemoryDefaults {
    return this.toolDefaults
  }

  getMemoryRetriever(): MemoryRetriever {
    return this.memoryRetriever
  }

  getMemoryInterceptor(): MemoryAwareInterceptor {
    return this.memoryInterceptor
  }

  getMemoryResourceProvider(): MemoryResourceProvider {
    return this.memoryResourceProvider
  }

  getResourceDefinitions(): MemoryResourceDefinition[] {
    return this.memoryResourceProvider.getResourceDefinitions()
  }

  async readResource(uri: string): Promise<ResourceContent> {
    return this.memoryResourceProvider.readResource(uri)
  }

  getMemoryConfig() {
    return this.memoryResourceProvider.getConfig()
  }

  updateMemoryConfig(partial: Parameters<MemoryResourceProvider['updateConfig']>[0]) {
    return this.memoryResourceProvider.updateConfig(partial)
  }

  getCapabilitySummary() {
    return this.controlPlane.getCapabilitySummary()
  }

  getCapabilityHealth(name: string) {
    return this.controlPlane.getCapabilityHealth(name)
  }

  // ==================== 持久化 (MCP Registry) ====================

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
      const config: MCPServerConfig = entry.transport === 'http' || entry.transport === 'sse' || entry.url
        ? {
            name: entry.name,
            transport: (entry.transport || (entry.url?.endsWith('/sse') ? 'sse' : 'http')) as 'http' | 'sse',
            url: entry.url || entry.command,
            requestTimeoutMs: entry.requestTimeoutMs ?? 60000,
          }
        : {
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
    log('INFO', 'mcp_servers_restored', { count: entries.length })
  }

  private persistServers(): void {
    const entries: PersistedServerConfig[] = []
    for (const [name, client] of this.controlPlane.servers) {
      entries.push(client.transportType === 'stdio'
        ? { name, command: client.getLaunchCommand() || '', cwd: client.cwd ? relative(WORKSPACE_DIR, client.cwd) || undefined : undefined }
        : { name, command: '', transport: client.transportType, url: client.url || undefined, requestTimeoutMs: client.requestTimeoutMs })
    }
    if (entries.length === 0) return
    try {
      if (!existsSync(WORKSPACE_DIR)) mkdirSync(WORKSPACE_DIR, { recursive: true })
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

  // ==================== MCP 服务器管理 ====================

  async addServer(config: MCPServerConfig): Promise<void> {
    log('INFO', 'mcp_connecting', { name: config.name, transport: config.transport })

    // stdio 模式：通过 ProcessManager 统一 spawn（C-6）
    if (config.transport === 'stdio' && !config.existingProcess && this.processManager) {
      try {
        const { process } = this.processManager.registerSpawn(config.name, {
          command: config.command!,
          args: config.args || [],
          cwd: config.cwd,
          env: config.env,
          restartPolicy: { maxRetries: 3, windowMs: 300000, cooldownMs: 60000 },
        })
        config.existingProcess = process
      } catch (err: any) {
        log('ERROR', 'mcp_spawn_failed_via_process_manager', { name: config.name, error: err.message })
      }
    }

    // MCPControlPlane 接管协议层
    const client = await this.controlPlane.initialize(config)
    if (!client) return  // initialize 失败时已记录日志

    // 索引新工具
    for (const t of client.getToolDefinitions()) {
      if (this.toolMap.has(t.name)) {
        log('WARN', 'mcp_tool_conflict', { tool: t.name, existing: this.toolMap.get(t.name)!.serverName, newServer: config.name })
        continue
      }
      this.toolMap.set(t.name, { serverName: config.name })
    }
    log('INFO', 'mcp_connected', { name: config.name, tools: client.getToolDefinitions().length })
  }

  async removeServer(name: string): Promise<void> {
    await this.controlPlane.removeServer(name)
    for (const [tool, meta] of this.toolMap) {
      if (meta.serverName === name) this.toolMap.delete(tool)
    }
    log('INFO', 'mcp_disconnected', { name })
  }

  // ==================== 工具模式暴露 ====================

  getAllSchemas(): Array<{
    type: 'function'
    function: {
      name: string
      description: string
      parameters: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] }
    }
  }> {
    const allDefs = this.getAllDefinitions()
    const schemas = allDefs.map((def) => ({
      type: 'function' as const,
      function: {
        name: def.name,
        description: def.description,
        parameters: { type: 'object' as const, properties: def.parameters, required: def.required },
      },
    }))

    const priorities = this.memoryInterceptor.getToolPriorities()
    const boostMap = new Map(priorities.map((p) => [p.toolName, p.boost]))

    if (priorities.length > 0) {
      schemas.sort((a, b) => {
        const boostA = boostMap.get(a.function.name) ?? 0
        const boostB = boostMap.get(b.function.name) ?? 0
        return boostB - boostA || 0
      })
      log('INFO', 'memory_tool_prioritized', {
        boostedCount: priorities.filter((p) => p.boost > 0).length,
        topBoosted: priorities.slice(0, 5).map((p) => `${p.toolName}(+${p.boost})`).join(', '),
      })
    }

    try {
      const recommendations = toolAnalytics.getPriorityRecommendations()
      if (recommendations.length > 0) {
        const analyticsBoostMap = new Map(recommendations.map((r) => [r.toolName, r.delta]))
        schemas.sort((a, b) => {
          const boostA = boostMap.get(a.function.name) ?? 0
          const boostB = boostMap.get(b.function.name) ?? 0
          const analyticsBoostA = analyticsBoostMap.get(a.function.name) ?? 0
          const analyticsBoostB = analyticsBoostMap.get(b.function.name) ?? 0
          return (boostB + analyticsBoostB) - (boostA + analyticsBoostA) || 0
        })
        log('INFO', 'analytics_tool_prioritized', {
          adjustedCount: recommendations.filter((r) => r.delta !== 0).length,
        })
      }
    } catch (err: any) {
      log('WARN', 'analytics_priority_failed', { error: err.message })
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
    for (const [name, client] of this.controlPlane.servers) {
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

  // ==================== 工具调用 ====================

  async callTool(name: string, args: Record<string, any>): Promise<string> {
    const startedAt = Date.now()
    const meta = this.toolMap.get(name)
    if (!meta) {
      toolCallLogStore.record(name, args, null, `未知工具: ${name}`, Date.now() - startedAt, false)
      throw new Error(`未知工具: ${name}`)
    }

    const memoryCacheHit = toolCallMemoryCache.get(name, args)
    if (memoryCacheHit !== null) {
      this.memoryInterceptor.postCall(name, args, memoryCacheHit.result, true)
      toolCallLogStore.record(name, args, memoryCacheHit.result, null, Date.now() - startedAt, true)
      this.recordAndPredict(name, args, memoryCacheHit.result, meta.serverName)
      return memoryCacheHit.result
    }

    const cacheKey = behaviorPredictor.buildCacheKey(name, args)
    const cachedResult = behaviorPredictor.getCachedResult(cacheKey)
    if (cachedResult !== null) {
      behaviorPredictor.recordCall(name, args, 0, true)
      this.memoryInterceptor.postCall(name, args, cachedResult, true)
      toolCallLogStore.record(name, args, cachedResult, null, Date.now() - startedAt, true)
      toolCallMemoryCache.set(name, args, cachedResult, 0, true)
      this.recordAndPredict(name, args, cachedResult, meta.serverName)
      return cachedResult
    }

    const memoryCtx = this.memoryInterceptor.preCall(name, args)
    let enrichedArgs = this.memoryInterceptor.enrichArgs(args, memoryCtx)
    const fillResult = this.memoryInterceptor.fillDefaults(name, enrichedArgs)
    enrichedArgs = fillResult.args

    const caller = meta.serverName
    if (this.capabilityEngine && meta.serverName !== MGR) {
      const action = this.toolNameToCapability(name)
      const allowed = this.capabilityEngine.checkCallAllowed(action, args?.path, caller)
      if (!allowed) {
        throw new Error(`[Capability] ${caller} 不允许执行 ${name} (需要 ${action} 能力)`)
      }
    } else if (meta.serverName !== this.local.name && meta.serverName !== MGR) {
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

    const adjustment = toolCallMemoryCache.getAdjustedArgs(name, enrichedArgs)
    if (adjustment.adjusted) {
      enrichedArgs = adjustment.args
    }

    let result: string
    try {
      if (meta.serverName === MGR) {
        result = await this.handleMgrTool(name, enrichedArgs)
      } else if (meta.serverName === this.local.name) {
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
        const client = this.controlPlane.getClient(meta.serverName)
        if (!client) throw new Error(`MCP 服务器不可用: ${meta.serverName}`)
        const toolResult = await client.callTool(name, enrichedArgs)
        result = this.formatResult(toolResult)
      }

      this.memoryInterceptor.postCall(name, args, result, true)
      toolCallLogStore.record(name, args, result, null, Date.now() - startedAt, true)
      toolCallMemoryCache.set(name, args, result, Date.now() - startedAt, true)
      this.recordAndPredict(name, args, result, meta.serverName)
      return result
    } catch (err: any) {
      this.memoryInterceptor.postCall(name, args, err.message || String(err), false)
      toolCallLogStore.record(name, args, null, err.message || String(err), Date.now() - startedAt, false)
      const errorType = classifyToolError(err.message || String(err))
      toolCallMemoryCache.recordError(name, args, err.message || String(err), errorType)
      behaviorPredictor.recordCall(name, args, 0, false)
      throw err
    }
  }

  private async handleMgrTool(name: string, args: Record<string, any>): Promise<string> {
    switch (name) {
      case 'list_mcp_servers':
        return this.listServers().map((s) => `${s.name} [${s.initialized ? '在线' : '离线'}] ${s.tools} 个工具`).join('\n')
      case 'remove_mcp_server':
        await this.removeServer(args.name)
        this.persistServers()
        return `MCP 服务器 "${args.name}" 已移除`
      case 'connect_mcp_server': {
        const transport = args.transport || (args.url.endsWith('/sse') ? 'sse' : 'http')
        const config: MCPServerConfig = {
          name: args.name,
          transport: transport as 'http' | 'sse',
          url: args.url,
          requestTimeoutMs: args.requestTimeoutMs ?? 60000,
        }
        await this.addServer(config)
        this.persistServers()
        return `MCP 服务器 "${args.name}" 已连接 (${transport}: ${args.url})`
      }
      default:
        throw new Error(`未知管理工具: ${name}`)
    }
  }

  private formatResult(result: MCPToolResult): string {
    const text = result.content.filter((c) => c.type === 'text').map((c) => c.text || '').join('\n')
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
    for (const [name, client] of this.controlPlane.servers) {
      servers.push({ name, initialized: client.isInitialized(), tools: client.getToolDefinitions().length })
    }
    return servers
  }

  async shutdownAll(): Promise<void> {
    await this.controlPlane.shutdown()
    this.toolMap.clear()
    this.indexLocalTools()
    log('INFO', 'mcp_all_shutdown')
  }

  // ==================== Capability 映射 ====================

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

  // ==================== 行为预激活 ====================

  private recordAndPredict(currentTool: string, args: Record<string, any>, result: string, serverName: string): void {
    behaviorPredictor.recordCall(currentTool, args, 0, true)
    const predictions = behaviorPredictor.predict(currentTool)
    for (const prediction of predictions) {
      if (prediction.confidence < BEHAVIOR_PREDICTOR_PRELOAD_CONFIDENCE) continue
      const predictedTool = prediction.toolName
      if (FILE_WRITE_TOOLS.has(predictedTool) || SHELL_TOOLS.has(predictedTool)) continue
      const predictedMeta = this.toolMap.get(predictedTool)
      if (!predictedMeta) continue
      this.triggerPreload(predictedTool, predictedMeta.serverName)
    }
  }

  private triggerPreload(toolName: string, serverName: string): void {
    if (serverName === MGR) return
    const defs = this.getAllDefinitions()
    const toolDef = defs.find((d) => d.name === toolName)
    const hasRequiredParams = toolDef && toolDef.required.length > 0

    if (serverName === this.local.name) {
      if (!hasRequiredParams && FILE_READ_TOOLS.has(toolName)) {
        const noArgCacheKey = behaviorPredictor.buildCacheKey(toolName, {})
        behaviorPredictor.preloadTool(noArgCacheKey, serverName, toolName, {}, async (name, preloadArgs) => {
          return this.formatResult(await this.local.callTool(name, preloadArgs))
        }).catch(() => {})
      }
    } else {
      const client = this.controlPlane.getClient(serverName)
      if (client && !client.isInitialized()) {
        client.initialize().catch(() => log('WARN', 'behavior_predictor_prewarm_failed', { server: serverName }))
      }
      if (client && client.isInitialized() && !hasRequiredParams && FILE_READ_TOOLS.has(toolName)) {
        const noArgCacheKey = behaviorPredictor.buildCacheKey(toolName, {})
        behaviorPredictor.preloadTool(noArgCacheKey, serverName, toolName, {}, async (name, preloadArgs) => {
          return this.formatResult(await client.callTool(name, preloadArgs))
        }).catch(() => {})
      }
    }
  }
}
