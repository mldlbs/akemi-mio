/**
 * core/patterns — 通用可复用模式
 *
 * 这些是从各领域组件中提取的无偏见通用逻辑，
 * 不依赖具体业务知识，通过策略/插件注入领域差异。
 */

export {
  ok,
  err,
  isOk,
  isErr,
  map,
  mapErr,
  flatMap,
  tryCatch,
  tryCatchAsync,
  unwrapOr,
  unwrapOrElse,
  collectOk,
  all,
} from './Result'
export type { Result, Success, Failure } from './Result'

export { AsyncQueue } from './AsyncQueue'
export type { AsyncQueueOptions, QueueStatus } from './AsyncQueue'

export { FallbackChain } from './FallbackChain'
export type {
  Resolver,
  ResolveAttempt,
  ResolveResult,
  FallbackChainOptions,
} from './FallbackChain'

export { DebounceGate } from './DebounceGate'
export type { DebounceGateOptions, GateStatus } from './DebounceGate'
