import { Transport, StdioTransport, HttpTransport } from './transport'
import { MCPRequest, MCPResponse, MCPToolSchema, MCPToolResult, MCPInitializeResult, MCPServerConfig, MCPToolDefinition } from './types'

let requestId = 0

export class McpClient {
  readonly name: string
  readonly rawCommand: string
  readonly cwd: string
  readonly transportType: 'stdio' | 'http' | 'sse'
  readonly url: string
  readonly requestTimeoutMs: number
  readonly headers: Record<string, string>
  readonly transport: Transport
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()
  private tools: MCPToolSchema[] = []
  private initialized = false
  private serverInfo: { name: string; version: string } = { name: '', version: '' }
  private notificationHandler: ((method: string, params?: any) => void) | null = null

  constructor(config: MCPServerConfig) {
    this.name = config.name
    this.rawCommand = config.rawCommand || ''
    this.cwd = config.cwd || ''
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30000
    this.headers = config.headers || {}

    if (config.transport === 'http' || config.transport === 'sse' || config.url) {
      this.transportType = config.transport === 'sse' ? 'sse' : config.url?.endsWith('/sse') ? 'sse' : 'http'
      this.url = config.url || config.command || ''
      this.transport = new HttpTransport(this.url, this.requestTimeoutMs, this.headers)
    } else {
      this.transportType = 'stdio'
      this.url = ''
      this.transport = new StdioTransport(
        config.command!,
        config.args,
        config.env,
        config.cwd,
        config.existingProcess,
      )
    }
    this.transport.onMessage((data) => this.handleResponse(data))
  }

  private handleResponse(data: MCPResponse): void {
    // JSON-RPC notification (no id field) — server-initiated message
    const maybeNotification = data as any
    if (data.id == null && maybeNotification.method) {
      this.notificationHandler?.(maybeNotification.method as string, maybeNotification.params)
      return
    }
    const pending = this.pending.get(data.id)
    if (!pending) return
    this.pending.delete(data.id)
    if (data.error) {
      pending.reject(new Error(data.error.message))
    } else {
      pending.resolve(data.result)
    }
  }

  /** 注册通知处理回调（处理 MCP Notification / 服务端主动推送的消息） */
  onNotification(handler: (method: string, params?: any) => void): void {
    this.notificationHandler = handler
  }

  private async request(method: string, params?: any): Promise<any> {
    const id = ++requestId
    const msg: MCPRequest = { jsonrpc: '2.0', id, method, params }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request timeout: ${method}`))
      }, this.requestTimeoutMs)

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timeout)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timeout)
          reject(e)
        },
      })

      this.transport.send(JSON.stringify(msg)).catch(reject)
    })
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    const result = (await this.request('initialize', {
      protocolVersion: '0.1.0',
      capabilities: {},
      clientInfo: { name: 'akemi-mio', version: '1.0.0' },
    })) as MCPInitializeResult
    // 兼容性处理：部分 MCP 服务器可能未返回 serverInfo
    this.serverInfo = result.serverInfo || { name: this.name, version: '0.0.0' }
    // 服务端 capabilities 缺失时使用空对象兜底（兼容旧版 MCP 协议实现）
    if (!result.capabilities) {
      ;(result as any).capabilities = {}
    }
    // SSE 传输需要建立长期连接以接收服务端推送通知
    if (this.transportType === 'sse') {
      try {
        await (this.transport as any).connectSSE()
      } catch (err) {
        console.error(`[MCP] SSE connect failed for ${this.name}:`, err)
      }
    }
    this.initialized = true
    console.log(`[MCP] Initialized: ${this.serverInfo.name} v${this.serverInfo.version}`)
  }

  async discoverTools(): Promise<MCPToolSchema[]> {
    if (!this.initialized) await this.initialize()
    const result = await this.request('tools/list')
    this.tools = result?.tools || []
    return this.tools
  }

  async callTool(name: string, args: Record<string, any>): Promise<MCPToolResult> {
    if (!this.initialized) await this.initialize()
    const result = await this.request('tools/call', { name, arguments: args })
    return result as MCPToolResult
  }

  getToolDefinitions(): MCPToolDefinition[] {
    return this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: (t.inputSchema?.properties as Record<string, { type: string; description: string }>) || {},
      required: t.inputSchema?.required || [],
      serverName: this.name,
    }))
  }

  isInitialized(): boolean {
    return this.initialized
  }
  getServerInfo(): { name: string; version: string } {
    return this.serverInfo
  }
  getLaunchCommand(): string {
    return this.rawCommand
  }

  /** Ping 检查服务器是否存活 */
  async ping(): Promise<boolean> {
    try {
      await this.request('ping', {})
      return true
    } catch {
      return false
    }
  }

  async shutdown(): Promise<void> {
    // 拒绝所有 pending 请求，防止进行中的工具调用挂起直到超时
    const err = new Error('MCP client shutdown')
    for (const [, pending] of this.pending) {
      pending.reject(err)
    }
    this.pending.clear()

    try {
      await this.request('shutdown')
    } catch {
      /* ignore */
    }
    await this.transport.close()
    this.initialized = false
  }
}
