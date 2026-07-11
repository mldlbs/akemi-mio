/**
 * Plugin Registry — 统一抽象层入口
 *
 * 从 ASR SpeechPluginRegistry、Wallpaper Widget Registry 等
 * 多个注册表中提取的共用接口和工具。
 *
 * 使用方式：
 *   import type { IPluginRegistry, IPlugin } from '../plugin/registry'
 *   import { StrategySelector } from '../plugin/registry'
 */

export type {
  IPluginManifest,
  IPluginStatus,
  IPlugin,
  IPluginRegistryReadonly,
  IPluginRegistry,
  IRegistryStats,
  ServiceState,
  ServiceStatus,
  IService,
  IStrategyProvider,
} from './types'

export { StrategySelector } from './StrategySelector'
