/**
 * Memory 边车模块入口
 *
 * MemorySidecar 是 Memory 附属的边车进程钩子系统。
 * 通过 MemoryService.setSidecar() 注入后，边车在 Memory 请求到达
 * MemoryService 主逻辑之前执行横切关注点处理。
 *
 * 边车遵循无状态、无依赖、可提取、零开销的设计原则。
 *
 * 业务模块通过实现 ISidecarPlugin 接口并调用 registerPlugin() 注册。
 * 注册的插件在对应的 Memory 操作（addEntry, getEntries, getFormattedContext
 * 等）的 pre/post 钩子中被调用。
 *
 * 使用示例（在 AppRuntime 中）：
 *
 *   import { MemorySidecar } from './memory/sidecar'
 *   import { RadarMemorySidecarPlugin } from './startup-radar/RadarMemorySidecarPlugin'
 *
 *   const sidecar = new MemorySidecar()
 *   sidecar.registerPlugin(new RadarMemorySidecarPlugin({ debug: true }))
 *   memoryService.setSidecar(sidecar)
 */

export { MemorySidecar } from './MemorySidecar'
export type { MemorySidecarConfig } from './MemorySidecar'

export type {
  ISidecarPlugin,
  SidecarHookPhase,
  AddEntryContext,
  AddEntryResult,
  GetEntriesContext,
  GetEntriesResult,
  GetFormattedContextResult,
  MemorySidecarStats,
  SidecarCacheConfig,
} from './types'
