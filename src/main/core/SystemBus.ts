/**
 * SystemBus — 协调总线：同步请求-响应层
 *
 * 与 EventBus（单向通知）互补。SystemBus 提供：
 * - query<T>(channel, context)：向所有注册的 handler 发起并行查询，聚合结果
 * - execute<T>(command, context)：向目标 handler 发起命令，等待确认
 *
 * 设计约束：
 * - 200ms 超时降级（不阻塞 toolLoop）
 * - DAG 循环依赖检测（启动时验证，有环则拒绝）
 * - Trace ID 传播（防无限递归 + 可观测性）
 */
import { log, createRequestId } from '../logger/Logger'
import type { EventBus, EventName } from './EventBus'

// ───── 桥接配置 ─────

export interface BridgeRule {
  event: EventName
  command?: CommandChannel
  query?: QueryChannel
  mapPayload?: (payload: any) => any
}

// ───── 类型 ─────

export type QueryChannel = 'utility-score' | 'resource-status' | 'goal-context' | 'memory-insight'

export type CommandChannel = 'guardrail.inject-feedback' | 'evolution.adjust-priority' | 'memory.consolidate-now'

export interface QueryContext {
  traceId: string
  depth: number
  toolCallName?: string
  toolCallArgs?: Record<string, unknown>
  [key: string]: unknown
}

export interface QueryResult<T = unknown> {
  channel: QueryChannel
  handlerName: string
  success: boolean
  value: T | null
  latencyMs: number
  error?: string
}

export interface AggregatedResult<T = unknown> {
  channel: QueryChannel
  results: QueryResult<T>[]
  composite: T | null
  traceId: string
  totalLatencyMs: number
  timedOut: boolean
}

export interface CommandResult<T = unknown> {
  success: boolean
  value: T | null
  error?: string
  latencyMs: number
}

export type QueryHandler<T = unknown> = (ctx: QueryContext) => Promise<T> | T

export type CommandHandler<T = unknown, P = unknown> = (payload: P) => Promise<CommandResult<T>> | CommandResult<T>

export interface HandlerRegistration {
  name: string
  channel: QueryChannel | CommandChannel
  type: 'query' | 'command'
  dependencies: string[]
  timeoutMs: number
  getFallback: () => unknown
}

// ───── 常量 ─────

const DEFAULT_QUERY_TIMEOUT_MS = 200
const MAX_BUS_DEPTH = 5

// ───── SystemBus ─────

export class SystemBus {
  private queryHandlers = new Map<QueryChannel, Map<string, { handler: QueryHandler; reg: HandlerRegistration }>>()
  private commandHandlers = new Map<CommandChannel, Map<string, { handler: CommandHandler; reg: HandlerRegistration }>>()
  private frozen = false
  private bridgeDisposers: (() => void)[] = []

  // ───── 桥接 ─────

  /**
   * bridgeFrom — 当 EventBus 事件触发时，自动转发到 SystemBus command/query。
   * 实现"事件→命令"闭环。
   * 每个桥接规则返回一个 disposer，调用 stopBridge() 可统一解除。
   */
  bridgeFrom(eventBus: EventBus, rules: BridgeRule[]): void {
    for (const rule of rules) {
      const disposer = eventBus.on(rule.event, (payload: any) => {
        const mapped = rule.mapPayload ? rule.mapPayload(payload) : payload

        if (rule.command) {
          this.execute(rule.command, mapped).catch((err: any) =>
            log('WARN', 'bridge_command_failed', { event: rule.event, command: rule.command, error: String(err) }),
          )
        }

        if (rule.query) {
          this.query(rule.query, mapped).catch((err: any) =>
            log('WARN', 'bridge_query_failed', { event: rule.event, query: rule.query, error: String(err) }),
          )
        }
      })
      this.bridgeDisposers.push(disposer)
      log('DEBUG', 'systembus_bridge_registered', { event: rule.event, command: rule.command, query: rule.query })
    }
  }

  stopBridge(): void {
    for (const d of this.bridgeDisposers) d()
    this.bridgeDisposers = []
  }

  // ───── 注册 ─────

  registerQuery<T>(
    channel: QueryChannel,
    name: string,
    handler: QueryHandler<T>,
    options?: {
      dependencies?: string[]
      timeoutMs?: number
      fallback?: T
    },
  ): void {
    if (this.frozen) throw new Error(`SystemBus frozen: cannot register "${name}" after boot`)
    if (!this.queryHandlers.has(channel)) this.queryHandlers.set(channel, new Map())

    const reg: HandlerRegistration = {
      name,
      channel,
      type: 'query',
      dependencies: options?.dependencies ?? [],
      timeoutMs: options?.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
      getFallback: () => options?.fallback ?? null,
    }
    this.queryHandlers.get(channel)!.set(name, { handler: handler as QueryHandler, reg })
    log('DEBUG', 'systembus_query_registered', { channel, name, deps: reg.dependencies.length })
  }

  registerCommand<T, P>(
    channel: CommandChannel,
    name: string,
    handler: CommandHandler<T, P>,
    options?: {
      dependencies?: string[]
      timeoutMs?: number
    },
  ): void {
    if (this.frozen) throw new Error(`SystemBus frozen: cannot register "${name}" after boot`)
    if (!this.commandHandlers.has(channel)) this.commandHandlers.set(channel, new Map())

    const reg: HandlerRegistration = {
      name,
      channel,
      type: 'command',
      dependencies: options?.dependencies ?? [],
      timeoutMs: options?.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
      getFallback: () => null,
    }
    this.commandHandlers.get(channel)!.set(name, { handler: handler as CommandHandler, reg })
    log('DEBUG', 'systembus_command_registered', { channel, name, deps: reg.dependencies.length })
  }

  freeze(): void {
    this.frozen = true
  }

  // ───── 查询 ─────

  /**
   * 向 channel 所有 handler 发起并行查询。
   * 超时 handler 自动降级为 fallback。
   * depth > MAX_BUS_DEPTH → 循环保护，直接 fallback。
   */
  async query<T>(channel: QueryChannel, context: Partial<QueryContext> = {}): Promise<AggregatedResult<T>> {
    const handlers = this.queryHandlers.get(channel)
    if (!handlers || handlers.size === 0) {
      return { channel, results: [], composite: null, traceId: context.traceId ?? 'noop', totalLatencyMs: 0, timedOut: false }
    }

    const traceId = context.traceId ?? createRequestId()
    const depth = (context.depth ?? 0) + 1
    const ctx: QueryContext = { ...context, traceId, depth } as QueryContext

    if (depth > MAX_BUS_DEPTH) {
      log('WARN', 'systembus_max_depth', { channel, traceId, depth })
      const fallbackResults: QueryResult<T>[] = [...handlers.entries()].map(([name, h]) => ({
        channel,
        handlerName: name,
        success: false,
        value: h.reg.getFallback() as T,
        latencyMs: 0,
        error: 'MAX_DEPTH',
      }))
      return { channel, results: fallbackResults, composite: null, traceId, totalLatencyMs: 0, timedOut: false }
    }

    const t0 = Date.now()

    const results = await Promise.allSettled(
      [...handlers.entries()].map(async ([name, h]) => {
        const t1 = Date.now()
        try {
          const value = await Promise.race([
            h.handler(ctx),
            new Promise<null>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), h.reg.timeoutMs)),
          ])
          return { channel, handlerName: name, success: true, value: value as T, latencyMs: Date.now() - t1 } as QueryResult<T>
        } catch (err) {
          const isTimeout = String(err).includes('TIMEOUT')
          if (isTimeout) log('WARN', 'systembus_query_timeout', { channel, handler: name, timeoutMs: h.reg.timeoutMs, traceId })
          return {
            channel,
            handlerName: name,
            success: false,
            value: h.reg.getFallback() as T,
            latencyMs: Date.now() - t1,
            error: isTimeout ? 'TIMEOUT' : String(err),
          } as QueryResult<T>
        }
      }),
    )

    const finalResults: QueryResult<T>[] = results.map((r, i) => {
      const name = [...handlers.keys()][i]
      if (r.status === 'fulfilled') return r.value
      return {
        channel,
        handlerName: name,
        success: false,
        value: (handlers.get(name)?.reg.getFallback() as T) ?? null,
        latencyMs: Date.now() - t0,
        error: 'UNHANDLED_REJECTION',
      } as QueryResult<T>
    })

    return {
      channel,
      results: finalResults,
      composite: this.aggregateChannel(channel, finalResults),
      traceId,
      totalLatencyMs: Date.now() - t0,
      timedOut: finalResults.some((r) => r.error === 'TIMEOUT'),
    }
  }

  async execute<T, P>(channel: CommandChannel, payload: P): Promise<CommandResult<T>> {
    const handlers = this.commandHandlers.get(channel)
    if (!handlers || handlers.size === 0) {
      return { success: false, value: null, error: `No handler: ${channel}`, latencyMs: 0 }
    }
    const [name, h] = [...handlers.entries()][0]
    const t0 = Date.now()
    try {
      const result = (await Promise.race([
        h.handler(payload),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), h.reg.timeoutMs)),
      ])) as CommandResult<T>
      return { ...result, latencyMs: Date.now() - t0 }
    } catch (err) {
      const isTimeout = String(err).includes('TIMEOUT')
      log(isTimeout ? 'WARN' : 'ERROR', 'systembus_command_failed', { channel, handler: name, error: String(err) })
      return { success: false, value: null, error: isTimeout ? 'TIMEOUT' : String(err), latencyMs: Date.now() - t0 }
    }
  }

  // ───── DAG 检测 ─────

  validateDAG(): { valid: boolean; cycles: string[][] } {
    const graph = new Map<string, string[]>()
    for (const handlers of this.queryHandlers.values()) {
      for (const [name, h] of handlers) graph.set(name, h.reg.dependencies)
    }
    for (const handlers of this.commandHandlers.values()) {
      for (const [name, h] of handlers) graph.set(name, h.reg.dependencies)
    }

    const cycles = findCycles(graph)
    if (cycles.length > 0) {
      log('ERROR', 'systembus_dag_cycle', { cycles: cycles.map((c) => c.join(' -> ')) })
    } else {
      log('INFO', 'systembus_dag_valid', { nodes: graph.size })
    }
    return { valid: cycles.length === 0, cycles }
  }

  getStats(): { queries: number; commands: number; frozen: boolean } {
    let q = 0,
      c = 0
    for (const h of this.queryHandlers.values()) q += h.size
    for (const h of this.commandHandlers.values()) c += h.size
    return { queries: q, commands: c, frozen: this.frozen }
  }

  // ───── 聚合 ─────

  private aggregateChannel<T>(channel: QueryChannel, results: QueryResult<T>[]): T | null {
    if (results.length === 0) return null
    if (channel === 'utility-score') {
      const nums = results.filter((r): r is QueryResult<number> => r.success && typeof r.value === 'number')
      if (nums.length === 0) return 0.5 as T
      const avg = nums.reduce((s, r) => s + r.value, 0) / nums.length
      return Math.max(0, Math.min(1, avg)) as T
    }
    return results.find((r) => r.success)?.value ?? null
  }
}

// ───── DAG 环检测（三色标记 DFS） ─────

function findCycles(graph: Map<string, string[]>): string[][] {
  const color = new Map<string, number>()
  const parent = new Map<string, string | null>()
  const cycles: string[][] = []

  for (const n of graph.keys()) color.set(n, 0)

  function dfs(node: string): void {
    color.set(node, 1)
    for (const dep of graph.get(node) ?? []) {
      if (!graph.has(dep)) continue
      if (color.get(dep) === 1) {
        const cycle: string[] = [dep, node]
        let cur = node
        while (cur !== dep && parent.has(cur)) {
          cur = parent.get(cur)!
          if (cur !== null && cur !== dep) cycle.push(cur)
        }
        cycle.reverse()
        cycles.push(cycle)
      } else if (color.get(dep) === 0) {
        parent.set(dep, node)
        dfs(dep)
      }
    }
    color.set(node, 2)
  }

  for (const n of graph.keys()) if (color.get(n) === 0) dfs(n)
  return cycles
}

export const systemBus = new SystemBus()
