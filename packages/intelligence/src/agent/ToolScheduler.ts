import { log } from '@akemi-mio/core/logger/Logger'
import type { ToolCallInfo } from '@akemi-mio/intelligence/llm/LlmService'
import { ServerManager } from '@akemi-mio/intelligence-mcp/ServerManager'
import { classifyToolError, ToolErrorType } from '@akemi-mio/capabilities/tool/ToolErrorType'
import { toolAvailabilityCache } from '@akemi-mio/capabilities/tool/ToolAvailabilityCache'
import type { ToolInvocationRouter } from '@akemi-mio/capabilities/tool/ToolInvocationRouter'
import { toolErrorAggregator, type ToolErrorAggregator } from '@akemi-mio/capabilities/tool/ToolErrorAggregator'
import { toolFallbackRegistry, type ToolFallbackRegistry } from '@akemi-mio/capabilities/tool/ToolFallbackRegistry'
import { DEFAULT_DEGRADATION_CONFIG } from '@akemi-mio/capabilities/tool/ToolDegradationConfig'

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
  /** 启用自动降级 */
  autoDegradation: boolean
  /** 启用自动回退 */
  autoFallback: boolean
  /** 回退退避基数（毫秒） */
  fallbackBackoffMs: number
  /** 回退重试次数 */
  fallbackRetries: number
  /** 是否允许跨服务器回退 */
  crossServerFallback: boolean
  /** 降级详细日志 */
  verboseLogging: boolean
}

const DEFAULT_CONFIG: ToolSchedulerConfig = {
  maxConcurrency: 5,
  toolTimeoutMs: 60000,
  maxRetries: 2,
  retryBaseMs: 1000,
  autoDegradation: true,
  autoFallback: true,
  fallbackBackoffMs: 500,
  fallbackRetries: 1,
  crossServerFallback: false,
  verboseLogging: true,
}

/**
 * ToolScheduler — 并发工具调度器
 *
 * 职责：
 * - 并行执行 LLM 一次发起的多个工具调用
 * - 单工具超时/重试
 * - 信号量限流
 * - 可恢复错误的自动降级（回退到备选工具）
 * - 通过 ToolErrorAggregator 聚合错误并生成批量建议
 * - 返回统一 ToolResult[]，按原顺序排列
 */
export class ToolScheduler {
  private mcpManager: ServerManager
  private config: ToolSchedulerConfig
  private errorAggregator: ToolErrorAggregator
  private fallbackRegistry: ToolFallbackRegistry
  /** P1.3a: capability 调用路由器（可选） */
  private invocationRouter: ToolInvocationRouter | null = null

  constructor(
    mcpManager: ServerManager,
    config?: Partial<ToolSchedulerConfig>,
    errorAggregator?: ToolErrorAggregator,
    fallbackRegistry?: ToolFallbackRegistry,
    /** P1.3a: capability 调用路由器（可选，null = 不使用 capability 路由） */
    invocationRouter?: ToolInvocationRouter | null,
  ) {
    this.mcpManager = mcpManager
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.errorAggregator = errorAggregator ?? toolErrorAggregator
    this.fallbackRegistry = fallbackRegistry ?? toolFallbackRegistry
    this.invocationRouter = invocationRouter ?? null
  }

  /**
   * 获取当前配置
   */
  getConfig(): Readonly<ToolSchedulerConfig> {
    return { ...this.config }
  }

  /**
   * 更新配置
   */
  setConfig(config: Partial<ToolSchedulerConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /**
   * 获取错误聚合器实例
   */
  getErrorAggregator(): ToolErrorAggregator {
    return this.errorAggregator
  }

  /**
   * P1.3a: 设置 ToolInvocationRouter（可在构造后绑定，支持延迟初始化）
   */
  setInvocationRouter(router: ToolInvocationRouter | null): void {
    this.invocationRouter = router
  }

  /**
   * 获取回退注册表实例
   */
  getFallbackRegistry(): ToolFallbackRegistry {
    return this.fallbackRegistry
  }

  /**
   * 并发执行一批工具调用。
   *
   * 执行流程：
   * 1. 并行执行所有工具（受信号量限流）
   * 2. 单工具超时/重试（原逻辑）
   * 3. 通过 ToolErrorAggregator 聚合结果
   * 4. 对可恢复错误且注册了回退的工具，自动执行备选工具
   * 5. 返回按传入顺序排列的 ToolResult[]，含回退结果
   */
  async executeAll(toolCalls: ToolCallInfo[], abortSignal?: AbortSignal): Promise<ToolResult[]> {
    // 信号量控制并发度
    const semaphore = new Semaphore(this.config.maxConcurrency)

    const tasks = toolCalls.map((call) => semaphore.run(() => this.executeSingle(call, abortSignal)))

    const initialResults = await Promise.all(tasks)

    // 降级检查：需要回退或重试时执行降级逻辑
    if (this.config.autoDegradation || this.config.autoFallback) {
      return this.applyDegradation(initialResults, toolCalls, abortSignal, semaphore)
    }

    return initialResults
  }

  /**
   * 对初始执行结果应用降级逻辑。
   *
   * 步骤：
   * 1. 聚合初始结果
   * 2. 对可恢复失败的工具检查是否有回退规则
   * 3. 并行执行所有回退调用
   * 4. 合并结果（回退成功用回退结果，否则保留原始失败结果）
   */
  private async applyDegradation(
    initialResults: ToolResult[],
    toolCalls: ToolCallInfo[],
    abortSignal?: AbortSignal,
    semaphore?: Semaphore,
  ): Promise<ToolResult[]> {
    // 1. 聚合初始结果
    const batchResult = this.errorAggregator.aggregateBatch(initialResults)

    if (batchResult.batchAdvice.action === 'all_ok') {
      return initialResults
    }

    if (this.config.verboseLogging) {
      log('INFO', 'tool_scheduler_degradation_check', {
        action: batchResult.batchAdvice.action,
        recoverableCount: batchResult.recoverableFailures.length,
        unrecoverableCount: batchResult.unrecoverableFailures.length,
        totalFailures: batchResult.failureCount,
      })
    }

    // 2. 对可恢复失败的工具收集回退规则
    type FallbackWorkItem = {
      originalIndex: number
      originalResult: ToolResult
      originalCall: ToolCallInfo
      fallbackToolName: string
    }
    const fallbackWork: FallbackWorkItem[] = []

    for (const failedEvent of batchResult.recoverableFailures) {
      // 找到原始结果和调用信息
      const originalIdx = initialResults.findIndex((r) => r.id === failedEvent.callId)
      if (originalIdx < 0) continue

      const originalResult = initialResults[originalIdx]
      const originalCall = toolCalls.find((tc) => tc.id === failedEvent.callId)
      if (!originalCall) continue

      // 检查是否有回退规则
      const suggestion = this.fallbackRegistry.beginFallback(
        failedEvent.toolName,
        failedEvent.errorType,
        failedEvent.error,
        DEFAULT_DEGRADATION_CONFIG.strategy.maxFallbackChainDepth,
      )

      if (!suggestion) {
        if (this.config.verboseLogging) {
          log('INFO', 'tool_scheduler_no_fallback', {
            tool: failedEvent.toolName,
            errorType: failedEvent.errorType,
          })
        }
        continue
      }

      const fallbackToolName = suggestion.rule.fallbackTool

      // 检查跨服务器回退权限
      if (!this.config.crossServerFallback && suggestion.rule.crossServerFallback) {
        log('INFO', 'tool_scheduler_fallback_cross_server_blocked', {
          primary: failedEvent.toolName,
          fallback: fallbackToolName,
        })
        this.fallbackRegistry.endFallback(failedEvent.toolName)
        continue
      }

      fallbackWork.push({
        originalIndex: originalIdx,
        originalResult,
        originalCall,
        fallbackToolName,
      })
    }

    if (fallbackWork.length === 0) {
      return initialResults
    }

    // 3. 并行执行回退调用
    log('INFO', 'tool_scheduler_executing_fallbacks', {
      count: fallbackWork.length,
      fallbacks: fallbackWork.map((fw) => `${fw.originalCall.name}→${fw.fallbackToolName}`).join(', '),
    })

    const fallbackTasks = fallbackWork.map((fw) => {
      const execFn = semaphore
        ? () => semaphore.run(() => this.executeFallback(fw, abortSignal))
        : () => this.executeFallback(fw, abortSignal)
      return execFn()
    })

    const fallbackResults = await Promise.all(fallbackTasks)

    // 4. 合并结果：回退成功则替换原始结果
    const mergedResults = [...initialResults]

    for (let i = 0; i < fallbackWork.length; i++) {
      const fw = fallbackWork[i]
      const fbResult = fallbackResults[i]

      // 记录回退执行事件
      this.errorAggregator.recordFallbackExecution(fw.originalCall.name, fw.fallbackToolName, batchResult.batchId)

      if (fbResult.success) {
        // 回退成功：用回退结果替换原始失败结果
        mergedResults[fw.originalIndex] = fbResult
        this.fallbackRegistry.endFallback(fw.originalCall.name)

        if (this.config.verboseLogging) {
          log('INFO', 'tool_scheduler_fallback_succeeded', {
            primary: fw.originalCall.name,
            fallback: fw.fallbackToolName,
          })
        }
      } else {
        // 回退也失败：尝试递增重试计数
        const canRetry = this.fallbackRegistry.incrementFallbackAttempt(fw.originalCall.name)
        if (!canRetry) {
          this.fallbackRegistry.endFallback(fw.originalCall.name)
        }

        if (this.config.verboseLogging) {
          log('WARN', 'tool_scheduler_fallback_failed', {
            primary: fw.originalCall.name,
            fallback: fw.fallbackToolName,
            error: fbResult.error,
            willRetry: canRetry,
          })
        }
        // 保留原始失败结果（已被回退覆盖的 index 仍保持失败状态）
      }
    }

    // 最终聚合（含回退结果）
    if (this.config.verboseLogging) {
      const finalBatch = this.errorAggregator.aggregateBatch(mergedResults)
      log('INFO', 'tool_scheduler_degradation_complete', {
        finalSuccessCount: mergedResults.filter((r) => r.success).length,
        finalFailureCount: mergedResults.filter((r) => !r.success).length,
        fallbacks: fallbackWork.length,
        finalAdvice: finalBatch.batchAdvice.action,
      })
    }

    return mergedResults
  }

  /**
   * 执行一次回退调用。
   * 使用与 executeSingle 类似的逻辑，但使用回退工具名。
   */
  private async executeFallback(
    fallbackWork: {
      originalIndex: number
      originalResult: ToolResult
      originalCall: ToolCallInfo
      fallbackToolName: string
    },
    abortSignal?: AbortSignal,
  ): Promise<ToolResult> {
    const t0 = Date.now()
    const { originalCall, fallbackToolName } = fallbackWork

    // 特殊处理：run_command→run_command 的 fallback（切换 shell）
    // 如果原工具和回退工具都是 run_command，尝试切换 shell
    if (originalCall.name === 'run_command' && fallbackToolName === 'run_command') {
      return this.executeShellFallback(originalCall, abortSignal, t0)
    }

    // 一般回退：使用回退工具名 + 原始参数执行
    const fallbackArgs = { ...originalCall.arguments }

    log('INFO', 'tool_scheduler_fallback_executing', {
      primary: originalCall.name,
      fallback: fallbackToolName,
      args: JSON.stringify(fallbackArgs).slice(0, 200),
    })

    for (let attempt = 0; attempt <= this.config.fallbackRetries; attempt++) {
      if (abortSignal?.aborted) {
        return {
          id: originalCall.id,
          name: fallbackToolName,
          success: false,
          content: '',
          error: 'cancelled',
          latencyMs: Date.now() - t0,
        }
      }

      try {
        const content = await this.callMcpWithTimeout(fallbackToolName, fallbackArgs, abortSignal)
        log('INFO', 'tool_scheduler_fallback_ok', {
          primary: originalCall.name,
          fallback: fallbackToolName,
          latencyMs: Date.now() - t0,
        })
        return {
          id: originalCall.id,
          name: fallbackToolName,
          success: true,
          content,
          latencyMs: Date.now() - t0,
        }
      } catch (err: any) {
        const isLastAttempt = attempt >= this.config.fallbackRetries
        log(isLastAttempt ? 'ERROR' : 'WARN', 'tool_scheduler_fallback_retry', {
          primary: originalCall.name,
          fallback: fallbackToolName,
          attempt: attempt + 1,
          error: err.message,
          willRetry: !isLastAttempt,
        })
        if (isLastAttempt) {
          return {
            id: originalCall.id,
            name: fallbackToolName,
            success: false,
            content: '',
            error: err.message,
            latencyMs: Date.now() - t0,
          }
        }
        await sleep(this.config.fallbackBackoffMs * Math.pow(2, attempt))
      }
    }

    return {
      id: originalCall.id,
      name: fallbackToolName,
      success: false,
      content: '',
      error: '回退执行失败',
      latencyMs: Date.now() - t0,
    }
  }

  /**
   * run_command→run_command 回退的特殊处理。
   * 尝试切换 shell 类型（cmd ↔ bash）。
   */
  private async executeShellFallback(originalCall: ToolCallInfo, abortSignal?: AbortSignal, t0?: number): Promise<ToolResult> {
    const startTime = t0 ?? Date.now()
    const originalCommand = originalCall.arguments?.command || ''
    const currentShell = process.platform === 'win32' ? 'cmd' : 'bash'

    // 尝试切换 shell
    const altCommand = process.platform === 'win32' ? `bash -c "${originalCommand.replace(/"/g, '\\"')}"` : originalCommand

    // 使用 run_command 但修改参数（添加 shell 切换提示）
    const fallbackArgs = {
      ...originalCall.arguments,
      command: altCommand,
      _fallback: `shell_switch:${process.platform === 'win32' ? 'cmd→bash' : 'bash→cmd'}`,
    }

    try {
      const content = await this.callMcpWithTimeout('run_command', fallbackArgs, abortSignal)
      return {
        id: originalCall.id,
        name: 'run_command',
        success: true,
        content: `[Shell 回退] 使用备选 shell 执行成功:\n${content}`,
        latencyMs: Date.now() - startTime,
      }
    } catch (err: any) {
      return {
        id: originalCall.id,
        name: 'run_command',
        success: false,
        content: '',
        error: `Shell 回退失败: ${err.message}`,
        latencyMs: Date.now() - startTime,
      }
    }
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
    return this.callMcpWithTimeout(call.name, call.arguments, abortSignal)
  }

  /**
   * 通用 MCP 调用 + 超时逻辑。
   * 被 executeSingle 和 executeFallback 共用。
   */
  private async callMcpWithTimeout(toolName: string, args: Record<string, any>, abortSignal?: AbortSignal): Promise<string> {
    // P1.3a: capability 函数经由 ToolInvocationRouter 转发，不经由 MCP
    if (this.invocationRouter) {
      const result = await this.invocationRouter.dispatch(toolName, args)
      return result.result
    }

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

      this.mcpManager.callTool(toolName, args).then(
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

/** 简单的信号量实现 */
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
