import { McpClient } from '../mcp/McpClient'
import type { MCPServerConfig } from '../mcp/types'
import { AgentService } from '../agent/AgentService'
import { log } from '../logger/Logger'
import { credentialsManager } from '../credentials/CredentialsManager'
import { eventBus } from '../core/EventBus'

const UUMIT_SSE_URL = 'https://api.uumit.com/mcp/sse'
const UUMIT_API_URL = 'https://m.uumit.com/api/v1'
const TASK_SCAN_INTERVAL_MS = 120_000 // 每 2 分钟扫一次任务市场

export class UumitService {
  private agentService: AgentService
  private client: McpClient | null = null
  private connected = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private stopped = false
  private scanTimer: ReturnType<typeof setInterval> | null = null
  private apiKey = ''
  private platformUserId = ''
  private appliedTaskIds = new Set<string>()
  private knownSkillNames = [
    'AI智能助手开发',
    '数据分析与可视化',
    '语音识别与合成',
    'Web搜索与信息整理',
    '自动化工作流开发',
    '代码审查与重构',
  ]

  constructor(agentService: AgentService) {
    this.agentService = agentService
  }

  async initialize(): Promise<void> {
    log('INFO', 'uumit_service_initialized')
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.connect()
    this.startTaskScanning()
    log('INFO', 'uumit_service_started')
  }

  private async apiPost(path: string, body: any): Promise<any> {
    try {
      const res = await fetch(`${UUMIT_API_URL}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
          'X-Platform-User-Id': this.platformUserId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null
    }
  }

  private async apiGet(path: string, params?: string): Promise<any> {
    try {
      const url = params ? `${UUMIT_API_URL}${path}?${params}` : `${UUMIT_API_URL}${path}`
      const res = await fetch(url, {
        headers: {
          'X-API-Key': this.apiKey,
          'X-Platform-User-Id': this.platformUserId,
        },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null
    }
  }

  /** 启动定时扫描任务市场，自动申请匹配的任务 */
  private startTaskScanning(): void {
    if (this.scanTimer) return
    // 首次延迟 30 秒，让核心服务先就绪
    setTimeout(() => this.scanAndApplyTasks(), 30000)
    this.scanTimer = setInterval(() => this.scanAndApplyTasks(), TASK_SCAN_INTERVAL_MS)
    log('INFO', 'uumit_task_scanner_started', { intervalMs: TASK_SCAN_INTERVAL_MS })
  }

  private async scanAndApplyTasks(): Promise<void> {
    if (this.stopped) return
    log('INFO', 'uumit_scanning_tasks')

    try {
      // 1. 获取任务市场列表（AI与自动化分类）
      const res = await fetch(`${UUMIT_API_URL}/tasks?category=AI与自动化&page=1&page_size=20`, {
        headers: {
          'X-API-Key': this.apiKey,
          'X-Platform-User-Id': this.platformUserId,
        },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) return
      const data: any = await res.json()
      const tasks: any[] = data?.data?.tasks || data?.tasks || data?.data || []

      for (const task of tasks) {
        const taskId = task.id || task.taskId
        if (!taskId || this.appliedTaskIds.has(taskId)) continue

        // 2. 判断是否适合自动申请（文字类任务、AI相关）
        const title = (task.title || '').toLowerCase()
        const desc = (task.description || '').toLowerCase()
        const combined = title + ' ' + desc

        // 检查是否含"ai不要来接"等排除标记
        if (combined.includes('ai不要') || combined.includes('不要ai') || combined.includes('不接受ai')) continue

        // 3. 只申请文字可完成的任务
        const keywords = [
          'ai',
          '智能',
          '代码',
          '编程',
          '写作',
          '文案',
          '数据',
          '分析',
          '翻译',
          '搜索',
          '报告',
          '整理',
          '自动化',
          '工具',
          '效率',
          '部署',
          '开发',
          '设计',
          '体验',
          '评价',
        ]
        const matched = keywords.some((k) => combined.includes(k))
        if (!matched) continue

        // 4. 申请任务
        log('INFO', 'uumit_applying_task', { taskId, title: task.title, budget: task.bounty_amount || task.price_ut })
        const result = await this.apiPost(`/tasks/${taskId}/apply`, {})
        if (result) {
          this.appliedTaskIds.add(taskId)
          log('INFO', 'uumit_task_applied', { taskId, title: task.title })
        }
      }
    } catch (err: any) {
      log('WARN', 'uumit_scan_tasks_error', { error: err.message })
    }
  }

  private async connect(): Promise<void> {
    if (this.connected || this.stopped) return

    this.apiKey = credentialsManager.get('uumit_api_key') || process.env.UUMIT_API_KEY || ''
    this.platformUserId = 'a18ef6c8-2da5-4c2b-9f32-b1c02e3895b7'

    if (!this.apiKey) {
      log('WARN', 'uumit_no_api_key', { hint: 'Set UUMIT_API_KEY env or uumit_api_key credential' })
      this.scheduleReconnect(30000)
      return
    }

    const config: MCPServerConfig = {
      name: 'uumit',
      transport: 'sse',
      url: UUMIT_SSE_URL,
      requestTimeoutMs: 60000,
      headers: {
        'X-API-Key': apiKey,
        'X-Platform-User-Id': platformUserId,
      },
    }

    try {
      this.client = new McpClient(config)

      this.client.onNotification((method, params) => {
        this.handleNotification(method, params)
      })

      await this.client.initialize()
      const tools = await this.client.discoverTools()
      log('INFO', 'uumit_connected', { tools: tools.length, names: tools.map((t) => t.name) })

      this.connected = true
      this.reconnectAttempts = 0
      eventBus.emit('uumit.connected', { serverInfo: this.client.getServerInfo() })

      if ('connectSSE' in (this.client as any).transport) {
        await (this.client as any).transport.connectSSE().catch((err: Error) => {
          log('WARN', 'uumit_sse_listen_failed', { error: err.message })
        })
      }
    } catch (err: any) {
      log('WARN', 'uumit_connect_failed', { error: err.message, attempt: this.reconnectAttempts })
      eventBus.emit('uumit.disconnected', { error: err.message })
      this.scheduleReconnect()
    }
  }

  private async handleNotification(method: string, params?: any): Promise<void> {
    log('INFO', 'uumit_notification', { method, params: params ? JSON.stringify(params).slice(0, 200) : '' })

    switch (method) {
      case 'tools/call':
      case 'task': {
        const taskName = params?.name || params?.taskName || 'uumit_task'
        const taskArgs = params?.arguments || params?.args || params
        await this.executeTask(taskName, taskArgs)
        break
      }

      case 'chat': {
        const text = params?.text || params?.message || ''
        if (text) {
          this.agentService
            .processTextInput(text, undefined, 'uumit', {
              uumitTaskId: params?.taskId,
              uumitOrderId: params?.orderId,
            })
            .catch((err) => {
              log('ERROR', 'uumit_chat_error', { error: String(err) })
            })
        }
        break
      }

      case 'ping':
        break

      default:
        log('INFO', 'uumit_unknown_notification', { method })
    }
  }

  private async executeTask(taskName: string, args: any): Promise<void> {
    log('INFO', 'uumit_executing_task', { taskName, args: JSON.stringify(args).slice(0, 300) })

    try {
      const result = await this.agentService.runSelfTask(
        typeof args === 'string' ? args : JSON.stringify(args),
        `【UUMit 任务】${taskName}`,
      )
      log('INFO', 'uumit_task_completed', { taskName, success: result.success })
    } catch (err: any) {
      log('ERROR', 'uumit_task_failed', { taskName, error: err.message })
    }
  }

  private scheduleReconnect(overrideDelay?: number): void {
    if (this.stopped) return
    const delay = overrideDelay ?? Math.min(5000 * Math.pow(2, this.reconnectAttempts), 120000)
    this.reconnectAttempts++
    log('INFO', 'uumit_reconnect_scheduled', { delayMs: delay, attempt: this.reconnectAttempts })

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connected = false
      this.client = null
      this.connect()
    }, delay)
  }

  isConnected(): boolean {
    return this.connected
  }

  getStatus(): string {
    if (this.stopped) return 'stopped'
    if (this.connected) return 'connected'
    return 'disconnected'
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.client) {
      this.client.shutdown().catch(() => {})
      this.client = null
    }
    this.connected = false
    eventBus.emit('uumit.disconnected', { reason: 'shutdown' })
    log('INFO', 'uumit_service_stopped')
  }
}

/** 模块级单例 */
export let uumitService: UumitService | null = null

export function initUumit(agentService: AgentService): UumitService {
  if (!uumitService) {
    uumitService = new UumitService(agentService)
  }
  return uumitService
}
