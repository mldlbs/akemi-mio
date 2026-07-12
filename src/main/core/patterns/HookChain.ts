/**
 * HookChain — 通用钩子链执行器
 *
 * 核心抽象：将顺序钩子执行与错误隔离标准化。
 * 从 WorkspaceCleanupLayer / IndustrialOdeLayer / MCP 的共性中提取。
 *
 * 用法：
 *   const chain = new HookChain<PreProcessContext>()
 *   chain.add(ctx => ({ ...ctx, processedText: ctx.rawText.trim() }))
 *   const result = await chain.execute(ctx)
 *
 * 设计原则：
 * - 无偏见：不关心 context 的具体结构，只管理钩子注册和执行
 * - 领域差异通过泛型 T 表达
 * - 单个钩子失败不阻断整体流程（错误隔离）
 * - 支持链的可变：添加/移除/清空
 */

import { log } from '../../logger/Logger'

// ════════════════════════════════════════════════════════════════
//  钩子签名
// ════════════════════════════════════════════════════════════════

/** 处理钩子：接收一个上下文，返回（可能修改后的）上下文 */
export type Hook<T> = (ctx: T) => T | Promise<T>

/** 映射钩子：接收一个上下文，返回一个不同类型的结果 */
export type MapHook<TCtx, TResult> = (ctx: TCtx) => TResult | Promise<TResult>

// ════════════════════════════════════════════════════════════════
//  HookChain — 同类型输入输出的钩子链
// ════════════════════════════════════════════════════════════════

export interface HookChainOptions {
  /** 日志分类名前缀，默认 'hook_chain' */
  loggerName?: string
  /** 调试模式 */
  debug?: boolean
}

export class HookChain<T> {
  private hooks: Array<Hook<T>> = []
  private loggerName: string
  private debug: boolean

  constructor(options?: HookChainOptions) {
    this.loggerName = options?.loggerName ?? 'hook_chain'
    this.debug = options?.debug ?? false
  }

  /** 添加一个钩子到链尾 */
  add(hook: Hook<T>): void {
    this.hooks.push(hook)
    if (this.debug) {
      log('DEBUG', `${this.loggerName}_hook_added`, { total: this.hooks.length })
    }
  }

  /** 从链中移除指定钩子（引用相等比较） */
  remove(hook: Hook<T>): boolean {
    const index = this.hooks.indexOf(hook)
    if (index === -1) return false
    this.hooks.splice(index, 1)
    if (this.debug) {
      log('DEBUG', `${this.loggerName}_hook_removed`, { total: this.hooks.length })
    }
    return true
  }

  /**
   * 依次执行所有已注册的钩子，每个钩子的输出作为下一个的输入。
   * 单个钩子失败不阻断整体流程：
   * - 抛出异常的钩子被跳过
   * - 后续钩子继续执行
   * - 异常前的修改保留
   */
  async execute(ctx: T): Promise<T> {
    let current = ctx
    for (let i = 0; i < this.hooks.length; i++) {
      try {
        current = await this.hooks[i](current)
      } catch (err: any) {
        log('WARN', `${this.loggerName}_hook_error`, {
          index: i,
          error: err.message,
        })
        // 错误隔离：单个钩子失败不阻断
      }
    }

    if (this.debug) {
      log('DEBUG', `${this.loggerName}_execute_done`, {
        hookCount: this.hooks.length,
      })
    }

    return current
  }

  /** 清空所有钩子 */
  clear(): void {
    this.hooks = []
    if (this.debug) {
      log('DEBUG', `${this.loggerName}_cleared`)
    }
  }

  /** 获取当前钩子数量 */
  get size(): number {
    return this.hooks.length
  }

  /** 获取所有钩子的副本 */
  getHooks(): ReadonlyArray<Hook<T>> {
    return [...this.hooks]
  }
}

// ════════════════════════════════════════════════════════════════
//  MapHookChain — 不同输入输出类型的映射钩子链
// ════════════════════════════════════════════════════════════════

/**
 * 结果合并策略。
 * 后处理场景中，多个钩子的结果需要合并为一个最终结果。
 */
export interface MergeStrategy<TResult> {
  /** 将 incoming 合并到 base 上，返回合并后的新结果 */
  merge(base: TResult, incoming: Partial<TResult>): TResult
}

/** 默认合并策略：后一个覆盖前一个的同名字段 */
export function createDefaultMerge<TResult extends Record<string, any>>(
  overrides?: Partial<MergeStrategy<TResult>>,
): MergeStrategy<TResult> {
  const mergeFn = overrides?.merge ?? ((base, incoming) => ({ ...base, ...incoming }))
  return { merge: mergeFn }
}

export interface MapHookChainOptions {
  loggerName?: string
  debug?: boolean
}

/**
 * MapHookChain — 将上下文映射到不同结果的钩子链。
 *
 * 适用于后处理场景：输入是处理上下文（PostProcessContext），
 * 每个钩子产生一个结果片段，最终合并为一个完整结果。
 */
export class MapHookChain<TCtx, TResult> {
  private hooks: Array<MapHook<TCtx, TResult>> = []
  private merger: MergeStrategy<TResult>
  private loggerName: string
  private debug: boolean

  constructor(merger?: MergeStrategy<TResult>, options?: MapHookChainOptions) {
    this.merger = merger ?? createDefaultMerge<TResult>()
    this.loggerName = options?.loggerName ?? 'map_hook_chain'
    this.debug = options?.debug ?? false
  }

  /** 设置合并策略（可在钩子注册后修改） */
  setMerger(merger: MergeStrategy<TResult>): void {
    this.merger = merger
  }

  /** 添加一个映射钩子到链尾 */
  add(hook: MapHook<TCtx, TResult>): void {
    this.hooks.push(hook)
    if (this.debug) {
      log('DEBUG', `${this.loggerName}_hook_added`, { total: this.hooks.length })
    }
  }

  /** 从链中移除指定钩子 */
  remove(hook: MapHook<TCtx, TResult>): boolean {
    const index = this.hooks.indexOf(hook)
    if (index === -1) return false
    this.hooks.splice(index, 1)
    return true
  }

  /**
   * 依次执行所有映射钩子，每个结果通过合并策略合并到最终结果。
   * 单个钩子失败不阻断整体流程。
   */
  async execute(ctx: TCtx): Promise<TResult> {
    let result: TResult = {} as TResult

    for (let i = 0; i < this.hooks.length; i++) {
      try {
        const partial = await this.hooks[i](ctx)
        result = this.merger.merge(result, partial as Partial<TResult>)
      } catch (err: any) {
        log('WARN', `${this.loggerName}_hook_error`, {
          index: i,
          error: err.message,
        })
      }
    }

    if (this.debug) {
      log('DEBUG', `${this.loggerName}_execute_done`, {
        hookCount: this.hooks.length,
      })
    }

    return result
  }

  /** 清空所有钩子 */
  clear(): void {
    this.hooks = []
  }

  /** 获取当前钩子数量 */
  get size(): number {
    return this.hooks.length
  }
}
