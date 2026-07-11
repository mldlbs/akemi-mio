/**
 * RetryBackoff — 指数退避重试与延迟计算
 *
 * 核心抽象：提供标准化的指数退避计算和可配置的重试包装器。
 * 替代各模块中重复的 Math.pow(2, attempt) * base 模式。
 *
 * 用法：
 *   // 仅计算退避延迟
 *   const delay = computeBackoff(2000, 2)  // 8000 + jitter
 *
 *   // 完整重试包装
 *   const result = await retryWithBackoff(
 *     () => someApiCall(),
 *     { maxRetries: 3, baseMs: 1000 },
 *   )
 *
 * 设计原则：
 * - 无偏见：不关心重试的业务逻辑，只提供机制
 * - 可配置：支持自定义最大重试次数、基础延迟、错误判定、jitter
 * - 可组合：返回 Result 类型，便于链式操作
 *
 * 来源分析（ErrorClassifier + EvolutionExecutor）：
 * - ErrorClassifier.computeBackoff() — 指数退避延迟计算
 * - EvolutionExecutor.executeStep() — 带指数退避的重试循环
 * - 两者退避公式一致：base * 2^attempt + optional jitter
 */

import { ok, err, type Result } from './Result'

// ── 配置 ──

export interface RetryOptions {
  /** 最大重试次数（默认 3） */
  maxRetries?: number
  /** 基础退避延迟 ms（默认 1000） */
  baseMs?: number
  /** 是否添加随机 jitter ms（默认 true） */
  jitter?: boolean
  /**
   * 自定义错误判定函数。
   * 返回 false 表示该错误不应重试（直接失败）。
   * 默认全部可重试。
   */
  shouldRetry?: (error: unknown, attempt: number) => boolean
  /** 每次重试前的回调（日志等） */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void
  /** 总超时 ms（超过此时间不再重试，默认 0=不限） */
  totalTimeoutMs?: number
}

// ── 退避计算 ──

/**
 * 计算指数退避延迟（毫秒）。
 *
 * @param baseMs 基础延迟
 * @param attempt 第几次尝试（0-based）
 * @param jitter 是否添加随机 jitter（默认 true，最多 +1000ms）
 * @returns 退避延迟毫秒数
 */
export function computeBackoff(baseMs: number, attempt: number, jitter = true): number {
  const delay = baseMs * Math.pow(2, attempt)
  return jitter ? delay + Math.floor(Math.random() * 1000) : delay
}

// ── 重试包装器 ──

/**
 * 带指数退避的重试包装器。
 *
 * @param fn 需要重试的异步函数
 * @param options 重试配置
 * @returns Promise<Result<T>> — 成功时 ok(value)，超过重试次数时 err(lastError)
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<Result<T, string>> {
  const maxRetries = options?.maxRetries ?? 3
  const baseMs = options?.baseMs ?? 1000
  const jitter = options?.jitter ?? true
  const shouldRetry = options?.shouldRetry ?? (() => true)
  const onRetry = options?.onRetry
  const totalTimeoutMs = options?.totalTimeoutMs ?? 0
  const startedAt = Date.now()

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn()
      return ok(result)
    } catch (error: unknown) {
      const isLastAttempt = attempt >= maxRetries

      // 检查总超时
      if (totalTimeoutMs > 0 && Date.now() - startedAt >= totalTimeoutMs) {
        return err(`retry_total_timeout: ${String(error)}`)
      }

      // 检查是否应该重试
      if (isLastAttempt || !shouldRetry(error, attempt)) {
        return err(String(error))
      }

      const delay = computeBackoff(baseMs, attempt, jitter)
      onRetry?.(error, attempt, delay)

      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  return err('retry_unreachable')
}

/**
 * retryWithBackoff 的非 Result 版本。
 * 失败时直接抛出最后的错误。
 */
export async function retryWithBackoffOrThrow<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const result = await retryWithBackoff(fn, options)
  if (result.ok) return result.value
  throw new Error(result.error)
}
