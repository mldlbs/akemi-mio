/**
 * Evolution × PiperTTS 深度融合 — 模块入口
 *
 * 导出所有 Piper 融合相关的类型、桥接器和插件。
 */

export { EvolutionPiperBridge, evolutionPiperBridge } from './EvolutionPiperBridge'
export { PiperEvolutionPlugin } from './PiperEvolutionPlugin'

export type {
  EvolutionToPiperState,
  PiperToEvolutionFeedback,
  EvolutionPiperSharedContext,
  EvolutionPiperBridgeConfig,
  EvolutionSchedulerExposure,
  EvolutionSafetyExposure,
  PiperModelPerformanceSnapshot,
  PiperProblemDescriptor,
  PiperProblemCategory,
} from './types'

export { DEFAULT_EVOLUTION_PIPER_BRIDGE_CONFIG } from './types'
