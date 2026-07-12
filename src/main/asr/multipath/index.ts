/**
 * Multi-Path Decoding Anomaly Fusion — 模块入口
 *
 * 导出所有多路径解码异常融合相关的类、类型和单例。
 */

export { FusionEngine, fusionEngine } from './FusionEngine'
export { MultiPathDecoderManager, multiPathDecoderManager } from './MultiPathDecoderManager'
export {
  WhisperGpuDecoderInstance,
  WhisperCpuDecoderInstance,
  BaiduDecoderInstance,
} from './DecoderInstance'

export type {
  DecoderConfig,
  DecoderHealth,
  DecoderHealthState,
  DecoderBackend,
  DecoderResult,
  DecoderErrorMessage,
  ErrorMessageCallback,
  FusionMethod,
  HeartbeatEvent,
  IDecoderInstance,
  MultiPathFusionConfig,
  MultiPathFusionResult,
} from './types'

export {
  DEFAULT_DECODER_CONFIG,
  DEFAULT_FUSION_CONFIG,
} from './types'
