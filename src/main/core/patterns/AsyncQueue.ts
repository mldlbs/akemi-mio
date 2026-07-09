/**
 * AsyncQueue — 通用异步串行队列
 *
 * 核心抽象：将一组异步任务排队，按顺序串行执行。
 * 替代手动管理的队列数组 + processQueue + isProcessing 模式。
 *
 * 用法：
 *   const queue = new AsyncQueue<string, number>({
 *     processor: async (s) => s.length,
 *     maxSize: 100,
 *     timeoutMs: 5000,
 *   })
 *   const result = await queue.enqueue('hello')  // Result<number>
 *   queue.getStatus()  // { pending: 0, isProcessing: false }
 *
 * 设计原则：
 * - 无偏见：processor 由调用方注入，队列只负责串行调度
 * - 容错：单个任务失败不影响队列中其他任务
 * - 生命周期：支持 stop() 终止所有等待任务，reset() 恢复
 * - 超时：支持每个任务的单独超时
 *
 * 来源分析（PiperOrchestrator + DualModeController）：
 * - PiperOrchestrator: QueuedTask[] + processQueue() + isProcessing + stopped
 * - DualModeController: 隐式时间段评估（非队列，但具有类似串行性质的模式）
 */
import { err, ok, type Result } from './Result'

// ── 类型 ──

/** 队列配置 */
export interface AsyncQueueOptions<TInput, TOutput> {
  /** 处理单个输入项的函数 */
  processor: (item: TInput) => Promise<TOutput>
  /** 最大队列长度（默认 100），超限立即拒绝 */
  maxSize?: number
  /** 每个任务超时 ms（默认 30000），0 表示不设超时 */
  timeoutMs?: number
}

/** 内部排队任务 */
interface QueuedItem<TInput, TOutput> {
  input: TInput
  resolve: (result: Result<TOutput, string>) => void
  /** 入队时间戳（用于诊断） */
  enqueuedAt: number
}

/** 队列状态快照（调试/UI 用） */
export interface QueueStatus {
  /** 等待中的任务数 */
  pending: number
  /** 是否正在处理 */
  isProcessing: boolean
  /** 是否已停止 */
  stopped: boolean
  /** 队列总容量 */
  maxSize: number
}

// ── 核心类 ──

export class AsyncQueue<TInput, TOutput> {
  private readonly processor: (item: TInput) => Promise<TOutput>
  private readonly maxSize: number
  private readonly timeoutMs: number

  private queue: Array<QueuedItem<TInput, TOutput>> = []
  private _isProcessing = false
  private _stopped = false

  constructor(options: AsyncQueueOptions<TInput, TOutput>) {
    this.processor = options.processor
    this.maxSize = options.maxSize ?? 100
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  // ── 公共 API ──

  /**
   * 将一个任务加入队列。
   * 如果队列已满或已停止，立即返回 err。
   * 返回 Promise<Result<TOutput>>，在串行处理完成后 resolve。
   */
  enqueue(input: TInput): Promise<Result<TOutput, string>> {
    if (this._stopped) {
      return Promise.resolve(err('队列已停止'))
    }

    if (this.queue.length >= this.maxSize) {
      return Promise.resolve(err(`队列已满 (${this.maxSize})`))
    }

    return new Promise<Result<TOutput, string>>((resolve) => {
      this.queue.push({ input, resolve, enqueuedAt: Date.now() })
      if (!this._isProcessing) {
        this.processNext()
      }
    })
  }

  /**
   * 停止队列：拒绝所有等待中的任务，停止处理后续任务。
   * 正在处理的任务会完成但不启动新任务。
   */
  stop(): void {
    this._stopped = true
    this.drainAll('队列已停止')
  }

  /**
   * 重置停止状态，允许重新入队和处理。
   */
  reset(): void {
    this._stopped = false
  }

  /** 获取队列当前状态快照 */
  getStatus(): QueueStatus {
    return {
      pending: this.queue.length,
      isProcessing: this._isProcessing,
      stopped: this._stopped,
      maxSize: this.maxSize,
    }
  }

  // ── 内部 ──

  /**
   * 串行处理队列中的下一个任务。
   * 每次只处理一个，处理完成后递归调用自身。
   */
  private async processNext(): Promise<void> {
    if (this._isProcessing || this._stopped) return

    const item = this.queue.shift()
    if (!item) return

    this._isProcessing = true

    try {
      const result = await this.processWithTimeout(item)
      item.resolve(result)
    } catch (e) {
      // processor 不应抛出（由 processWithTimeout 捕获），
      // 但兜底防御
      item.resolve(err(e instanceof Error ? e.message : String(e)))
    } finally {
      this._isProcessing = false
      // 继续处理下一个
      if (this.queue.length > 0 && !this._stopped) {
        this.processNext()
      }
    }
  }

  /**
   * 执行单个任务，支持超时。
   */
  private async processWithTimeout(
    item: QueuedItem<TInput, TOutput>,
  ): Promise<Result<TOutput, string>> {
    try {
      const result = await (this.timeoutMs > 0
        ? withTimeout(this.processor(item.input), this.timeoutMs)
        : this.processor(item.input))
      return ok(result)
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * 拒绝所有等待中的任务。
   */
  private drainAll(reason: string): void {
    while (this.queue.length > 0) {
      const item = this.queue.shift()!
      item.resolve(err(reason))
    }
    this._isProcessing = false
  }
}

// ── 辅助 ──

/**
 * 为一个 Promise 添加超时。
 * 超时后 reject 而非 resolve。
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`超时 (${ms}ms)`)), ms)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
