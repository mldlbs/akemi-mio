/**
 * MessageGateway — 工具化统一消息网关
 *
 * 将所有外部数据源注册为可发现的 MCP 工具，提供统一的执行调度、
 * 输出格式协商和附件处理。支持动态注册/注销数据源工具，
 * 与 Telegram 推送系统集成，未来可扩展至其他外部通道。
 *
 * ## 架构
 *
 * ┌─────────────────────────────────────────────────────┐
 * │                   MessageGateway                     │
 * │  ┌──────────────────────────────────────────────┐   │
 * │  │          DataSourceToolRegistry               │   │
 * │  │  radar_scan  │  radar_analyze  │  rss_fetch  │   │
 * │  └──────────────────────────────────────────────┘   │
 * │  ┌──────────────────────────────────────────────┐   │
 * │  │            Execution Engine                    │   │
 * │  │  • 格式协商 (text/image/json)                  │   │
 * │  │  • 并发控制 (Semaphore)                        │   │
 * │  │  • 超时保护                                    │   │
 * │  └──────────────────────────────────────────────┘   │
 * │  ┌──────────────────────────────────────────────┐   │
 * │  │          Output Formatter                     │   │
 * │  │  • → MCPToolResult (Agent 工具链)             │   │
 * │  │  • → Telegram 消息 (推送)                     │   │
 * │  └──────────────────────────────────────────────┘   │
 * └─────────────────────────────────────────────────────┘
 *
 * ## 线程模型
 *
 * 所有工具执行在异步 worker 中运行，通过 Semaphore 限制最大并发数。
 * 不阻塞 Telegram 轮询循环（setInterval 独立运行）。
 *
 * ## 使用示例
 *
 * ```typescript
 * const gateway = new MessageGateway()
 * gateway.register(radarScanDataSource)
 *
 * // Agent 调用
 * const result = await gateway.executeTool('radar_scan', { sources: ['hackernews'] }, 'text')
 *
 * // Telegram 推送
 * const { text, photoBase64 } = gateway.formatForTelegram(result, 'auto')
 * ```
 */

import { log } from '../logger/Logger'
import type {
  DataSourceToolDef,
  DataSourceResult,
  OutputFormat,
} from './DataSourceTool'
import {
  dataSourceResultToMCP,
  formatForTelegram,
  isFormatSupported,
} from './DataSourceTool'
import type { MCPToolResult } from '../mcp/types'

// =============================================================================
// 配置
// =============================================================================

/** 默认最大并发工具执行数 */
const DEFAULT_MAX_CONCURRENCY = 4

/** 默认工具执行超时（毫秒） */
const DEFAULT_TOOL_TIMEOUT_MS = 60_000

// =============================================================================
// Semaphore — 轻量级信号量，控制并发
// =============================================================================

class Semaphore {
  private current = 0
  private queue: Array<() => void> = []

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++
      return
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.current++
        resolve()
      })
    })
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!
      next()
    } else {
      this.current--
    }
  }

  get active(): number {
    return this.current
  }

  get pending(): number {
    return this.queue.length
  }
}

// =============================================================================
// DataSourceToolRegistry — 数据源工具注册表
// =============================================================================

export class DataSourceToolRegistry {
  private tools = new Map<string, DataSourceToolDef>()

  /**
   * 注册一个数据源工具。
   * 如果同名工具已存在，记录警告但不覆盖（幂等）。
   */
  register(tool: DataSourceToolDef): boolean {
    if (this.tools.has(tool.name)) {
      log('WARN', 'gateway_tool_already_registered', { name: tool.name })
      return false
    }
    this.tools.set(tool.name, tool)
    log('INFO', 'gateway_tool_registered', {
      name: tool.name,
      formats: tool.supportedFormats.join(', '),
    })
    return true
  }

  /** 注销一个数据源工具 */
  unregister(name: string): boolean {
    const removed = this.tools.delete(name)
    if (removed) {
      log('INFO', 'gateway_tool_unregistered', { name })
    }
    return removed
  }

  /** 按名获取工具定义 */
  get(name: string): DataSourceToolDef | undefined {
    return this.tools.get(name)
  }

  /** 列出所有已注册的工具 */
  list(): DataSourceToolDef[] {
    return Array.from(this.tools.values())
  }

  /** 检查工具是否已注册 */
  has(name: string): boolean {
    return this.tools.has(name)
  }

  /** 获取已注册工具数量 */
  get size(): number {
    return this.tools.size
  }

  /** 清理所有工具 */
  clear(): void {
    const count = this.tools.size
    this.tools.clear()
    log('INFO', 'gateway_tools_cleared', { count })
  }
}

// =============================================================================
// MessageGateway — 统一消息网关
// =============================================================================

export class MessageGateway {
  /** 数据源工具注册表 */
  readonly registry: DataSourceToolRegistry

  /** 并发控制器 */
  private semaphore: Semaphore

  /** 是否已初始化 */
  private _initialized = false

  constructor(maxConcurrency: number = DEFAULT_MAX_CONCURRENCY) {
    this.registry = new DataSourceToolRegistry()
    this.semaphore = new Semaphore(maxConcurrency)
  }

  /** 网关是否已初始化 */
  get initialized(): boolean {
    return this._initialized
  }

  /** 当前活跃执行数 */
  get activeExecutions(): number {
    return this.semaphore.active
  }

  /** 等待中的执行数 */
  get pendingExecutions(): number {
    return this.semaphore.pending
  }

  /**
   * 初始化网关。在 AppRuntime 启动时调用。
   * 注册内置的数据源工具。
   */
  async initialize(): Promise<void> {
    if (this._initialized) return
    this._initialized = true
    log('INFO', 'message_gateway_initialized', {
      maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    })
  }

  /**
   * 注册数据源工具。
   * 支持单体和批量注册。
   */
  register(tool: DataSourceToolDef): boolean
  register(tools: DataSourceToolDef[]): number
  register(toolOrTools: DataSourceToolDef | DataSourceToolDef[]): boolean | number {
    if (Array.isArray(toolOrTools)) {
      let count = 0
      for (const t of toolOrTools) {
        if (this.registry.register(t)) count++
      }
      return count
    }
    return this.registry.register(toolOrTools)
  }

  /** 注销数据源工具 */
  unregister(name: string): boolean {
    return this.registry.unregister(name)
  }

  /**
   * 执行一个数据源工具。
   *
   * @param name 工具名
   * @param args 输入参数
   * @param format 期望输出格式（默认 auto）
   * @param timeoutMs 超时（毫秒，默认 60000）
   * @returns 工具执行结果
   */
  async executeTool(
    name: string,
    args: Record<string, any> = {},
    format: OutputFormat = 'auto',
    timeoutMs: number = DEFAULT_TOOL_TIMEOUT_MS,
  ): Promise<DataSourceResult> {
    const tool = this.registry.get(name)
    if (!tool) {
      return {
        text: `❌ 数据源工具 "${name}" 未注册。可用工具: ${this.registry.list().map((t) => t.name).join(', ') || '无'}`,
        isError: true,
      }
    }

    if (tool.isEnabled === false) {
      return {
        text: `⚠️ 数据源工具 "${name}" 当前已禁用`,
        isError: true,
      }
    }

    // 校验输出格式
    const effectiveFormat: OutputFormat = isFormatSupported(tool, format) ? format : tool.defaultFormat
    if (!isFormatSupported(tool, effectiveFormat)) {
      return {
        text: `⚠️ 工具 "${name}" 不支持格式 "${effectiveFormat}"。支持: ${tool.supportedFormats.join(', ')}`,
        isError: true,
      }
    }

    // 并发控制
    await this.semaphore.acquire()

    try {
      const startTime = Date.now()

      const result = await Promise.race([
        tool.handler(args, effectiveFormat),
        new Promise<DataSourceResult>((_, reject) =>
          setTimeout(() => reject(new Error(`工具 "${name}" 执行超时 (${timeoutMs}ms)`)), timeoutMs),
        ),
      ])

      const durationMs = Date.now() - startTime
      log('INFO', 'gateway_tool_executed', {
        name,
        format: effectiveFormat,
        durationMs,
        isError: result.isError,
        attachments: result.attachments?.length ?? 0,
      })

      return result
    } catch (err: any) {
      log('ERROR', 'gateway_tool_execution_failed', {
        name,
        error: err.message,
      })
      return {
        text: `❌ 工具 "${name}" 执行失败: ${err.message}`,
        isError: true,
      }
    } finally {
      this.semaphore.release()
    }
  }

  /**
   * 执行工具并返回 MCPToolResult（供 Agent 工具链使用）。
   * 自动转换附件为 MCP 内容格式。
   */
  async executeToolAsMCP(
    name: string,
    args: Record<string, any> = {},
    format: OutputFormat = 'auto',
  ): Promise<MCPToolResult> {
    const result = await this.executeTool(name, args, format)
    return dataSourceResultToMCP(result)
  }

  /**
   * 执行工具并返回 Telegram 友好格式。
   * 自动提取图片附件用于 photo 发送。
   */
  async executeToolForTelegram(
    name: string,
    args: Record<string, any> = {},
    format: OutputFormat = 'auto',
  ): Promise<{ text: string; photoBase64?: string }> {
    const result = await this.executeTool(name, args, format)
    return formatForTelegram(result, format)
  }

  /**
   * 获取网关状态摘要。
   */
  getStatus(): {
    initialized: boolean
    registeredTools: number
    activeExecutions: number
    pendingExecutions: number
    tools: Array<{ name: string; description: string; formats: string; enabled: boolean }>
  } {
    return {
      initialized: this._initialized,
      registeredTools: this.registry.size,
      activeExecutions: this.semaphore.active,
      pendingExecutions: this.semaphore.pending,
      tools: this.registry.list().map((t) => ({
        name: t.name,
        description: t.description,
        formats: t.supportedFormats.join(', '),
        enabled: t.isEnabled !== false,
      })),
    }
  }

  /** 清理所有资源 */
  dispose(): void {
    this.registry.clear()
    this._initialized = false
    log('INFO', 'message_gateway_disposed')
  }
}

// =============================================================================
// 全局单例
// =============================================================================

/** 全局 MessageGateway 实例 */
export const messageGateway = new MessageGateway()
