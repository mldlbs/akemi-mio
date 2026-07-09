/**
 * Speech Plugin 系统 — 入口
 *
 * 导出所有语音插件相关的类型、注册表和适配器。
 */

export { SpeechPluginRegistry } from './SpeechPluginRegistry'

export {
  WhisperGpuAsrPlugin,
  WhisperCpuAsrPlugin,
  BaiduAsrPlugin,
  PiperTtsPlugin,
  EdgeTtsPlugin,
} from './adapters'

export type {
  SpeechCapability,
  SpeechPluginManifest,
  AsrPlugin,
  AsrPluginStatus,
  AsrTranscribeOptions,
  AsrTranscribeResult,
  TtsPlugin,
  TtsPluginStatus,
  TtsSynthesizeOptions,
  TtsSynthesizeResult,
} from './types'
