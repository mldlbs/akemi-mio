/**
 * Evolution Plugin 系统 — 入口
 *
 * 导出所有 EvolutionPlugin 相关的接口、加载器和内置插件。
 */

export { PluginServiceLoader } from './PluginServiceLoader'

export {
  PluginCollectorAdapter,
  PluginExecutorAdapter,
} from './types'

export { WallpaperPlugin } from './plugins/WallpaperPlugin'

export type {
  EvolutionPlugin,
  EvolutionPluginManifest,
  EvolutionCapability,
  PluginProblem,
  PluginFixResult,
} from './types'
