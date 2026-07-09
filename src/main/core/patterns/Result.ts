/**
 * Result — 成功/失败结果类型
 *
 * 核心抽象：用一个联合类型统一表达"成功带值"或"失败带错误"，
 * 替代 ad-hoc 的 {success: boolean, error?: string, ...} 模式。
 *
 * 用法：
 *   const r = ok(42)           // Result<number, string>
 *   const e = err('fail')      // Result<never, string>
 *   if (r.ok) use(r.value)
 *   else console.error(r.error)
 *
 * 设计原则：
 * - 无偏见：不假定错误类型（默认 string，可替换为 Error 或自定义枚举）
 * - 不可变：类型是只读联合，通过工厂函数创建
 * - 可组合：提供 map / flatMap / unwrapOr 等常用操作
 */

/** 成功分支 */
export interface Success<T> {
  readonly ok: true
  readonly value: T
}

/** 失败分支 */
export interface Failure<E = string> {
  readonly ok: false
  readonly error: E
}

/** Result 联合类型 */
export type Result<T, E = string> = Success<T> | Failure<E>

// ── 工厂 ──

/** 创建一个成功值 */
export function ok<T, E = never>(value: T): Result<T, E> {
  return { ok: true, value }
}

/** 创建一个失败值 */
export function err<T = never, E = string>(error: E): Result<T, E> {
  return { ok: false, error }
}

// ── 类型守卫 ──

export function isOk<T, E>(r: Result<T, E>): r is Success<T> {
  return r.ok
}

export function isErr<T, E>(r: Result<T, E>): r is Failure<E> {
  return !r.ok
}

// ── 转换 ──

/** 转换成功值 */
export function map<T, U, E>(r: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return r.ok ? ok(fn(r.value)) : r
}

/** 转换失败值 */
export function mapErr<T, E, F>(r: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return r.ok ? r : err(fn(r.error))
}

/** 链式操作：如果成功则执行返回 Result 的函数 */
export function flatMap<T, U, E>(r: Result<T, E>, fn: (value: T) => Result<U, E>): Result<U, E> {
  return r.ok ? fn(r.value) : r
}

/** 尝试执行可能抛出异常的函数，将异常转换为 Result */
export function tryCatch<T, E = string>(fn: () => T, onError: (e: unknown) => E): Result<T, E> {
  try {
    return ok(fn())
  } catch (e) {
    return err(onError(e))
  }
}

/** 异步版 tryCatch */
export async function tryCatchAsync<T, E = string>(
  fn: () => Promise<T>,
  onError: (e: unknown) => E,
): Promise<Result<T, E>> {
  try {
    return ok(await fn())
  } catch (e) {
    return err(onError(e))
  }
}

// ── 解构 ──

/** 如果成功返回值，否则返回默认值 */
export function unwrapOr<T, E>(r: Result<T, E>, defaultValue: T): T {
  return r.ok ? r.value : defaultValue
}

/** 如果成功返回值，否则调用 fallback 函数 */
export function unwrapOrElse<T, E>(r: Result<T, E>, fallback: (error: E) => T): T {
  return r.ok ? r.value : fallback(r.error)
}

/**
 * 从一系列 Result 中收集所有成功值。
 * 跳过失败结果，保留成功值。
 */
export function collectOk<T, E>(results: Array<Result<T, E>>): T[] {
  return results.filter(isOk).map((r) => r.value)
}

/**
 * 将 [Result<T, E>] 转为 Result<T[], E>。
 * 如果有任何一个失败，返回第一个错误。
 */
export function all<T, E>(results: Array<Result<T, E>>): Result<T[], E> {
  const values: T[] = []
  for (const r of results) {
    if (!r.ok) return r
    values.push(r.value)
  }
  return ok(values)
}
