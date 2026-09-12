/**
 * Agent Plugin 系统 — 入口
 *
 * 导出所有 Agent 插件相关的类型、注册表和适配器。
 *
 * 模式来源：src/main/speech/ 的 ServiceLoader 模式
 * 迁移到 Agent 领域，适配 Agent 的认知管线（OTPAR）和运行时特性。
 */

export { AgentPluginRegistry, agentPluginRegistry } from './AgentPluginRegistry'

export { ObserveStagePluginAdapter, ThinkStagePluginAdapter, ReflectStagePluginAdapter } from './adapters'

export type {
  AgentCapability,
  AgentPluginManifest,
  AgentPluginStatus,
  AgentPlugin,
  StageInput,
  StageOutput,
  ObserveStagePlugin,
  ThinkStagePlugin,
  ReflectStagePlugin,
} from './types'
