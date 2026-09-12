/**
 * FallbackChain — 优先级链式解析器 / 优雅降级链
 *
 * 核心抽象：将多个解析器按优先级排序，依次尝试直到成功。
 * 替代手动 if-else 优先链 + 回退重试的 ad-hoc 模式。
 *
 * 用法：
 *   const chain = new FallbackChain<string, string>({
 *     resolvers: [
 *       { priority: 10, name: 'explicit', resolve: (ctx) => findExplicit(ctx) },
 *       { priority: 20, name: 'recommended', resolve: (ctx) => findRecommended(ctx) },
 *       { priority: 30, name: 'default', resolve: () => 'zh_CN-huayan-medium' },
 *     ],
 *   })
 *   const result = await chain.resolve(input)  // Result<string>
 *
 * 设计原则：
 * - 无偏见：解析器类型通过泛型指定，不依赖具体领域知识
 * - 透明：记录每次尝试的结果，提供诊断信息
 * - 容错：一个解析器失败自动尝试下一个
 * - 可组合：支持动态添加/移除解析器
 *
 * 来源分析（PiperOrchestrator + DualModeController）：
 * - PiperOrchestrator.resolveModel(): 4 级优先链 (explicit > taskTag > current > default)
 * - DualModeController.evaluatePlanModeConditions(): 6 个加权因子的累积评估
 */
import { ok, err, type Result } from './Result'
import { log } from '@akemi-mio/core/logger/Logger'

// ── 类型 ──

/** 解析器定义 */
export interface Resolver<TContext, TResult> {
  /** 优先级（数字越小越优先） */
  priority: number
  /** 解析器名称（日志/诊断用） */
  name: string
  /** 解析函数：接收上下文，返回结果或 null（表示此解析器无法处理） */
  resolve: (context: TContext) => Promise<TResult | null> | (TResult | null)
}

/** 单次解析尝试的记录 */
export interface ResolveAttempt<TContext, TResult> {
  resolverName: string
  priority: number
  /** 是否解析成功 */
  success: boolean
  /** 解析到的值（成功时） */
  value?: TResult
  /** 失败原因（失败时） */
  error?: string
  /** 耗时 ms */
  durationMs: number
}

/** 完整解析结果 */
export interface ResolveResult<TContext, TResult> {
  /** 最终选择的解析器名称 */
  selectedResolver: string | null
  /** 解析到的最终值（成功时） */
  value?: TResult
  /** 是否触发了回退 */
  fallbackUsed: boolean
  /** 所有尝试的记录 */
  attempts: ResolveAttempt<TContext, TResult>[]
  /** 总耗时 ms */
  totalDurationMs: number
}

/** FallbackChain 配置 */
export interface FallbackChainOptions<TContext, TResult> {
  /** 有序解析器列表 */
  resolvers?: Array<Resolver<TContext, TResult>>
  /** 日志分类名（用于统一日志前缀） */
  loggerName?: string
  /** 是否启用诊断记录（默认 true） */
  recordAttempts?: boolean
}

// ── 核心类 ──

export class FallbackChain<TContext, TResult> {
  private resolvers: Array<Resolver<TContext, TResult>> = []
  private readonly loggerName: string
  private readonly recordAttempts: boolean

  constructor(options?: FallbackChainOptions<TContext, TResult>) {
    this.loggerName = options?.loggerName ?? 'fallback_chain'
    this.recordAttempts = options?.recordAttempts ?? true

    if (options?.resolvers) {
      for (const r of options.resolvers) {
        this.addResolver(r)
      }
    }
  }

  // ── 解析器管理 ──

  /**
   * 添加一个解析器。按 priority 排序插入。
   */
  addResolver(resolver: Resolver<TContext, TResult>): void {
    this.resolvers.push(resolver)
    this.resolvers.sort((a, b) => a.priority - b.priority)
  }

  /**
   * 按名称移除一个解析器。
   * 返回是否成功移除。
   */
  removeResolver(name: string): boolean {
    const idx = this.resolvers.findIndex((r) => r.name === name)
    if (idx < 0) return false
    this.resolvers.splice(idx, 1)
    return true
  }

  /** 获取当前所有解析器（按优先级排序的副本） */
  getResolvers(): Array<Resolver<TContext, TResult>> {
    return [...this.resolvers]
  }

  // ── 核心解析 ──

  /**
   * 按优先级依次尝试解析器，直到某个解析器返回非 null 值。
   *
   * @param context 解析上下文
   * @returns 完整解析结果（含所有尝试记录）
   */
  async resolve(context: TContext): Promise<ResolveResult<TContext, TResult>> {
    const t0 = Date.now()
    const attempts: ResolveAttempt<TContext, TResult>[] = []

    for (const resolver of this.resolvers) {
      const attemptT0 = Date.now()

      try {
        const result = await resolver.resolve(context)

        if (result !== null && result !== undefined) {
          // 成功
          const attempt: ResolveAttempt<TContext, TResult> = {
            resolverName: resolver.name,
            priority: resolver.priority,
            success: true,
            value: result,
            durationMs: Date.now() - attemptT0,
          }
          if (this.recordAttempts) attempts.push(attempt)

          log('INFO', `${this.loggerName}_resolved`, {
            resolver: resolver.name,
            priority: resolver.priority,
            durationMs: Date.now() - t0,
          })

          return {
            selectedResolver: resolver.name,
            value: result,
            fallbackUsed: attempts.length > 1,
            attempts,
            totalDurationMs: Date.now() - t0,
          }
        }

        // null → 此解析器跳过
        if (this.recordAttempts) {
          attempts.push({
            resolverName: resolver.name,
            priority: resolver.priority,
            success: false,
            error: '返回 null，跳过',
            durationMs: Date.now() - attemptT0,
          })
        }
      } catch (e) {
        // 解析器抛出异常 → 跳过
        if (this.recordAttempts) {
          attempts.push({
            resolverName: resolver.name,
            priority: resolver.priority,
            success: false,
            error: e instanceof Error ? e.message : String(e),
            durationMs: Date.now() - attemptT0,
          })
        }

        log('WARN', `${this.loggerName}_resolver_failed`, {
          resolver: resolver.name,
          error: String(e).slice(0, 100),
        })
      }
    }

    // 所有解析器均失败
    log('WARN', `${this.loggerName}_all_failed`, {
      totalResolvers: this.resolvers.length,
      durationMs: Date.now() - t0,
    })

    return {
      selectedResolver: null,
      fallbackUsed: false,
      attempts,
      totalDurationMs: Date.now() - t0,
    }
  }

  /**
   * resolve 的简化版：只返回 Result<TResult>。
   * 失败时错误信息包含所有失败尝试的摘要。
   */
  async resolveToResult(context: TContext): Promise<Result<TResult, string>> {
    const result = await this.resolve(context)

    if (result.value !== undefined) {
      return ok(result.value)
    }

    const summaries = result.attempts.filter((a) => !a.success).map((a) => `${a.resolverName}: ${a.error}`)

    return err(`所有解析器均失败 (${summaries.join('; ') || '无可用解析器'})`)
  }
}
