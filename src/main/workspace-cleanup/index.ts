/**
 * Plan:清理工作区 - 整理文件目录 — 模块入口
 *
 * 作为 Agent 的上层增强层，拦截其输入输出进行预处理/后处理增强。
 * 通过环境变量 WORKSPACE_CLEANUP_FEATURES 控制特性。
 */

export { WorkspaceCleanupLayer } from './WorkspaceCleanupLayer'

export {
  parseFeaturesFromEnv,
} from './types'

export type {
  WorkspaceCleanupFeature,
  WorkspaceCleanupFeatureMap,
  WorkspaceStats,
  CleanupResult,
  PreProcessContext,
  PostProcessContext,
  PostProcessResult,
  PreProcessHook,
  PostProcessHook,
  WorkspaceCleanupLayerConfig,
} from './types'
