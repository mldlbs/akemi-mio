/**
 * 音频领域包 — 公共入口
 *
 * 本包包含 86 个源文件（ASR / TTS / 情感 / 声学分析），对外必须导出完整类型面。
 * `types.ts` 的 104 个类型既是 Speech Plugin 的契约，也是下游包
 * （voice-analytics / tts-core / piper-tts / asr / audio-tools）的公共依赖。
 *
 * 注意：生产代码多使用深层路径导入（如 '@akemi-mio/audio/AsrService'）绕过此处，
 * 但 barrel 导入必须完整 —— 否则下游报 TS2305。
 */

export { SpeechPluginRegistry } from './SpeechPluginRegistry'

export { WhisperGpuAsrPlugin, WhisperCpuAsrPlugin, BaiduAsrPlugin, PiperTtsPlugin, EdgeTtsPlugin } from './adapters'

export * from './types'
