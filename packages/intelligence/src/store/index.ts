/**
 * Store — Memory/Agent 统一抽象层
 *
 * 提供跨 Memory、Agent、Cognitive 的统一只读/可写接口，
 * 通过策略模式在运行时选择具体实现，降低系统整体复杂度。
 *
 * 使用方式：
 * ```typescript
 * import { StoreRegistry, ProceduralMemoryAdapter } from './store'
 *
 * const registry = new StoreRegistry()
 * registry.register(new ProceduralMemoryAdapter(proceduralMemory))
 * registry.register(new GoalEngineAdapter(goalEngine))
 *
 * // 跨所有存储搜索
 * const results = await registry.searchAll('some query')
 *
 * // 策略选择最佳存储
 * const store = registry.selectBest('some query')
 * const ctx = await store?.getContext()
 * ```
 */
export { StoreRegistry, NameSelector, TypeSelector, SmartSelector, FirstSelector } from '@akemi-mio/intelligence/store/StoreRegistry'

export {
  ProceduralMemoryAdapter,
  FailureAnalyzerAdapter,
  GoalEngineAdapter,
  StrategyEngineAdapter,
  EngineeringMemoryAdapter,
  DecisionStoreAdapter,
} from '@akemi-mio/intelligence/store/adapters'

export type { ReadableStore, WritableStore, StoreType, StoreSelector, SearchOptions, SearchResult, WriteInput, WriteResult } from '@akemi-mio/intelligence/store/types'
