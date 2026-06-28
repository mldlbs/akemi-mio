import { log } from '../logger/Logger'
import type { ToolCallInfo } from '../llm/LlmService'
import { ServerManager } from '../mcp/ServerManager'
import { toolAvailabilityCache } from '../tool/ToolAvailabilityCache'

/** 单个工具执行结果 */
export interface ToolResult {
  id: string
  name: string
  success: boolean
  content: string
  error?: string
  latencyMs: number
}

/** 调度器配置 */
export interface ToolSchedulerConfig {
  /** 最大并发工具数 */
  maxConcurrency: number
  /** 单工具超时（毫秒） */
  toolTimeoutMs: number
  /** 失败重试次数 */
  maxRetries: number
  /** 重试退避基数（毫秒） */
  retryBaseMs: number
}

const DEFAULT_CONFIG: ToolSchedulerConfig = {
  maxConcurrency: 5,
  toolTimeoutMs: 60000,
  maxRetries: 2,
  retryBaseMs: 1000,
}

/**
 * ToolScheduler — 并发工具调度器
 *
 * 职责：
 * - 并行执行 LLM 一次发起的多个工具调用
 * - 单工具超时/重试
 * - 信号量限流
 * - 返回统一 ToolResult[]，按原顺序排列
 */
export class ToolScheduler {
  private mcpManager: ServerManager
  private config: ToolSchedulerConfig

  constructor(mcpManager: ServerManager, config?: Partial<ToolSchedulerConfig>) {
    this.mcpManager = mcpManager
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 并发执行一批工具调用
   * 按传入顺序返回结果，失败工具会重试（最多 maxRetries 次）
   */
  async executeAll(toolCalls: ToolCallInfo[], abortSignal?: AbortSignal): Promise<ToolResult[]> {
    // 信号量控制并发度
    const semaphore = new Semaphore(this.config.maxConcurrency)

    const tasks = toolCalls.map((call) => semaphore.run(() => this.executeSingle(call, abortSignal)))

    return Promise.all(tasks)
  }

  private async executeSingle(call: ToolCallInfo, abortSignal?: AbortSignal): Promise<ToolResult> {
    const t0 = Date.now()

    // 预检：工具在此上下文中是否已知不可用（避免浪费 toolLoop 轮次）
    const cachedReason = toolAvailabilityCache.check(call.name, call.arguments)
    if (cachedReason) {
      log('INFO', 'tool_availability_skip', { tool: call.name, reason: cachedReason })
      return {
        id: call.id,
        name: call.name,
        success: false,
        content: '',
        error: `工具不可用（已缓存）: ${cachedReason}`,
        latencyMs: 0,
      }
    }

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (abortSignal?.aborted) {
        return { id: call.id, name: call.name, success: false, content: '', error: 'cancelled', latencyMs: Date.now() - t0 }
      }

      try {
        const content = await this.callWithTimeout(call, abortSignal)
        log('INFO', 'tool_scheduler_ok', { tool: call.name, attempt: attempt + 1, latencyMs: Date.now() - t0 })
        return { id: call.id, name: call.name, success: true, content, latencyMs: Date.now() - t0 }
      } catch (err: any) {
        // 工具调用失败：统一分类后决定是否缓存/重试
        const errorType = classifyToolError(err.message)
        toolAvailabilityCache.record(call.name, call.arguments, err.message)

        // TOOL_MISSING / MCP_ERROR → 缓存 + 跳过重试（工具不可用）
        if (errorType === ToolErrorType.TOOL_MISSING || errorType === ToolErrorType.MCP_ERROR) {
          log('WARN', 'tool_scheduler_non_retryable', {
            tool: call.name,
            attempt: attempt + 1,
            errorType,
            error: err.message,
          })
          return { id: call.id, name: call.name, success: false, content: '', error: err.message, latencyMs: Date.now() - t0 }
        }

        // ENVIRONMENT / PERMISSION / ARGUMENT → 跳过重试（但已不缓存）
        if (errorType !== ToolErrorType.TRANSIENT && errorType !== ToolErrorType.UNKNOWN) {
          log('WARN', 'tool_scheduler_skip_retry', {
            tool: call.name,
            attempt: attempt + 1,
            errorType,
            error: err.message,
          })
          return { id: call.id, name: call.name, success: false, content: '', error: err.message, latencyMs: Date.now() - t0 }
        }

        // TRANSIENT / UNKNOWN → 正常重试
        const isLastAttempt = attempt >= this.config.maxRetries
        log(isLastAttempt ? 'ERROR' : 'WARN', 'tool_scheduler_retry', {
          tool: call.name,
          attempt: attempt + 1,
          errorType,
          error: err.message,
          willRetry: !isLastAttempt,
        })
        if (isLastAttempt) {
          return { id: call.id, name: call.name, success: false, content: '', error: err.message, latencyMs: Date.now() - t0 }
        }
        await sleep(this.config.retryBaseMs * Math.pow(2, attempt))
      }
    }

    return { id: call.id, name: call.name, success: false, content: '', error: 'unknown', latencyMs: Date.now() - t0 }
  }

  private async callWithTimeout(call: ToolCallInfo, abortSignal?: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      // 超时定时器
      const timer = setTimeout(() => {
        reject(new Error('tool timeout'))
      }, this.config.toolTimeoutMs)

      // 外部取消
      const onAbort = () => {
        clearTimeout(timer)
        reject(new Error(abortSignal?.reason?.toString() || 'cancelled'))
      }
      if (abortSignal?.aborted) {
        onAbort()
        return
      }
      abortSignal?.addEventListener('abort', onAbort, { once: true })

      this.mcpManager.callTool(call.name, call.arguments).then(
        (content) => {
          clearTimeout(timer)
          abortSignal?.removeEventListener('abort', onAbort)
          resolve(content)
        },
        (err) => {
          clearTimeout(timer)
          abortSignal?.removeEventListener('abort', onAbort)
          reject(err)
        },
      )
    })
  }
}

// ── 工具函数 ──

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 简单信号量 */
class Semaphore {
  private max: number
  private current = 0
  private queue: Array<() => void> = []

  constructor(max: number) {
    this.max = max
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.current >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }
    this.current++
    try {
      return await fn()
    } finally {
      this.current--
      this.queue.shift()?.()
    }
  }
}
