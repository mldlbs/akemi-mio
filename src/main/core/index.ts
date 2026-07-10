export { EventBus, eventBus } from './EventBus'
export type { EventName, EventPayload } from './EventBus'
export { StateManager } from './StateManager'
export type { UIState } from './StateManager'
export { Kernel, KERNEL_PREFIXES, KERNEL_NAMES } from './Kernel'
export type { KernelModule } from './Kernel'
export { SystemBus, systemBus } from './SystemBus'
export type { QueryChannel, CommandChannel, QueryContext, AggregatedResult, CommandResult } from './SystemBus'
import { SyscallBus, HealthChecker } from './lifecycle/index'
export type { ISubsystem, IModule, SubsystemState, HealthCheckResult } from './lifecycle/types'

// ── 通用模式库（无偏见核心抽象） ──
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
  AsyncQueue,
  FallbackChain,
  DebounceGate,
  SlidingWindow,
} from './patterns'
export type {
  Result,
  Success,
  Failure,
  AsyncQueueOptions,
  QueueStatus,
  Resolver,
  ResolveAttempt,
  ResolveResult,
  FallbackChainOptions,
  DebounceGateOptions,
  GateStatus,
} from './patterns'

// ── 持久化抽象层 ──
export { JsonStore, IdentifiableJsonStore } from './persistence'
export type { JsonStoreOptions } from './persistence'
