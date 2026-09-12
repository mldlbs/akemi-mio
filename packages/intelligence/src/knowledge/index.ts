/**
 * knowledge — Memory/Agent 统一知识源抽象层
 *
 * 导出统一接口、聚合查询引擎、适配器。
 */

export { isMutable } from './IKnowledgeSource'
export type { IKnowledgeSource, IMutableKnowledgeSource, KnowledgeItem, QueryOptions, SaveInput } from './IKnowledgeSource'

export { UnifiedKnowledgeQuery } from './UnifiedKnowledgeQuery'

export {
  MemoryPluginAdapter,
  ProceduralMemoryAdapter,
  ReflectLoopAdapter,
  FailureAnalyzerAdapter,
  ContextOnlyAdapter,
  adaptMemoryPlugin,
  adaptProceduralMemory,
  adaptReflectLoop,
  adaptFailureAnalyzer,
} from './adapters'
