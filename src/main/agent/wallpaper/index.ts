/**
 * Agent 模块 Wallpaper 化改造 — 入口
 *
 * 提供 Agent 子模块的 Wallpaper 替换基础设施：
 * 1. AgentWallpaperBridge — 增量迁移桥梁
 * 2. Wallpaper 插件实现 — 每个可替换的子模块对应一个插件
 * 3. wallpaper-mapping — 子模块分解与能力映射分析
 *
 * 使用方式：
 *   // 初始化桥梁（AppRuntime 启动时）
 *   import { agentWallpaperBridge } from './agent/wallpaper'
 *   agentWallpaperBridge.initialize()
 *
 *   // 注册第一个替换（SleepCycle）
 *   import { registerSleepCyclePlugin } from './agent/wallpaper'
 *   const plugin = registerSleepCyclePlugin()
 *   plugin.setDeps({ memoryService, failureAnalyzer, ... })
 *
 * @see AgentWallpaperBridge — 桥梁类
 * @see SleepCyclePlugin — 第一个 Wallpaper 插件替换
 * @see AGENT_SUB_MODULE_MAPPINGS — 完整子模块分析
 */

export {
  AgentWallpaperBridge,
  agentWallpaperBridge,
  type ReplacementStatus,
  wallpaperReplacements,
} from './AgentWallpaperBridge'

export {
  SleepCyclePlugin,
  registerSleepCyclePlugin,
} from './plugins'

export type {
  AgentSubModuleMapping,
  IndependenceLevel,
  WallpaperSuitability,
  MigrationPriority,
} from '../wallpaper-mapping'

export {
  AGENT_SUB_MODULE_MAPPINGS,
  MIGRATION_PHASES,
  getByIndependence,
  getByWallpaperSuitability,
  getByPriority,
  getPriorityReplacementQueue,
  getByName,
} from '../wallpaper-mapping'
