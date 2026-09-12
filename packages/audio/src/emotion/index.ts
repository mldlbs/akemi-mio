/**
 * tts/emotion — 叙事情感控制模块
 *
 * 为 TTS 提供基于记忆情感时间序列的叙事情绪曲线支持。
 * 使 AI 语音在叙述过程中根据内容情感自然变化语调。
 */

export { EmotionTimeSeriesStore, emotionTimeSeriesStore } from './EmotionTimeSeriesStore'
export { NarrativeEmotionController, narrativeEmotionController, type NarrativeEmotionConfig } from './NarrativeEmotionController'
export { SpeakingStyleGenerator, speakingStyleGenerator, type StyledTtsSegment, type SpeakingStyleResult } from './SpeakingStyleGenerator'
export {
  EmotionalNarrativeService,
  emotionalNarrativeService,
  type NarrativeSegmentEvent,
  type NarrativeStartEvent,
  type NarrativeEndEvent,
  type NarrativeState,
} from './EmotionalNarrativeService'
