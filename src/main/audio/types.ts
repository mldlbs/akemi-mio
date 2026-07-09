/**
 * audio/types.ts — 音频特征与故事氛围参数类型定义
 *
 * 用于语音情感引导续写氛围功能：
 * 1. AudioFeatureExtractor → 从 PCM 提取韵律特征
 * 2. AtmosphereMapper → 特征 → 故事氛围分值
 * 3. VoiceContinuationService → 氛围分值作为生成约束
 */

// ══════════════════════════════════════════
//  音频韵律特征（从 PCM 原始音频计算）
// ══════════════════════════════════════════

export interface AudioFeatures {
  /** 平均能量 (RMS)，归一化 0–1 */
  energy: number
  /** 能量方差 0–1，越高表示情绪波动越大 */
  energyVariance: number
  /** 能量变化趋势：-1（持续下降）到 +1（持续上升），0=平稳 */
  energyTrend: number
  /** 估计的平均基频 (Hz)，0=无声/无法估计 */
  pitchHz: number
  /** 基频方差 (Hz)，越高表示语调变化越剧烈 */
  pitchVariance: number
  /** 基频范围 (Hz)，最高音与最低音的差值 */
  pitchRange: number
  /** 过零率平均值 0–1，衡量语音粗糙度/紧张度 */
  avgZeroCrossingRate: number
  /** 过零率方差 */
  zcrVariance: number
  /** 语速（有效语音段的平均帧数/秒） */
  speechRate: number
  /** 无声段比例 0–1（总时长中静音占比） */
  silenceRatio: number
  /** 有效语音段的数量（反映说话的连续性） */
  voiceSegmentCount: number
  /** 音频总时长（秒） */
  durationSec: number
}

// ══════════════════════════════════════════
//  故事氛围参数（用于约束 LLM 生成）
// ══════════════════════════════════════════

export interface StoryAtmosphere {
  /** 紧张度 0–1 */
  tension: number
  /** 欢乐度 0–1 */
  joy: number
  /** 悲伤度 0–1 */
  sadness: number
  /** 平静度 0–1 */
  calmness: number
  /** 神秘度 0–1 */
  mystery: number
  /** 浪漫度 0–1 */
  romance: number
  /** 主导氛围标签（取分值最高者） */
  dominantLabel: string
  /** 置信度 0–1 */
  confidence: number
  /** 该氛围标签的中文描述（用于注入 prompt） */
  description: string
}

// ══════════════════════════════════════════
//  氛围映射权重配置（可调参数 ≡ "简单映射模型"）
// ══════════════════════════════════════════

/**
 * 音频特征 → 氛围维度的线性映射权重。
 * 每个氛围维度由一组特征加权求和得到。
 * 可视为一个轻量可训练的线性模型（调整 weights 即训练）。
 */
export interface AtmosphereMappingWeights {
  /** 紧张度权重: {高能量, 高能量方差, 高音调, 高音调方差, 高过零率, 低平静度} */
  tension: {
    energy: number
    energyVariance: number
    pitch: number
    pitchVariance: number
    zcr: number
  }
  /** 欢乐度权重: {中高能量, 中高音调, 低过零率, 低静音比, 多语音段} */
  joy: {
    energy: number
    pitch: number
    zcr: number
    silence: number
    segments: number
  }
  /** 悲伤度权重: {低能量, 低音调, 低音调方差, 高静音比, 单调能量} */
  sadness: {
    energy: number
    pitch: number
    pitchVariance: number
    silence: number
    energyVariance: number
  }
  /** 平静度权重: {中低能量, 低能量方差, 低过零率, 低静音比, 稳定} */
  calmness: {
    energy: number
    energyVariance: number
    zcr: number
    pitchRange: number
    energyTrend: number
  }
  /** 神秘度权重: {低声, 低音调, 高静音比, 低能量方差, 低语速} */
  mystery: {
    energy: number
    pitch: number
    silence: number
    energyVariance: number
    speechRate: number
  }
  /** 浪漫度权重: {中能量, 中音调, 低过零率, 低静音比, 稳定语调} */
  romance: {
    energy: number
    pitch: number
    zcr: number
    silence: number
    pitchRange: number
  }
}

/** 默认映射权重（经验值） */
export const DEFAULT_ATMOSPHERE_WEIGHTS: AtmosphereMappingWeights = {
  tension: { energy: 0.3, energyVariance: 0.25, pitch: 0.15, pitchVariance: 0.15, zcr: 0.15 },
  joy: { energy: 0.25, pitch: 0.2, zcr: -0.2, silence: -0.15, segments: 0.2 },
  sadness: { energy: -0.3, pitch: -0.2, pitchVariance: -0.15, silence: 0.2, energyVariance: -0.15 },
  calmness: { energy: -0.15, energyVariance: -0.25, zcr: -0.2, pitchRange: -0.2, energyTrend: 0.2 },
  mystery: { energy: -0.2, pitch: -0.15, silence: 0.25, energyVariance: -0.2, speechRate: -0.2 },
  romance: { energy: 0.15, pitch: 0.2, zcr: -0.2, silence: -0.2, pitchRange: 0.25 },
}

// ══════════════════════════════════════════
//  氛围标签定义
// ══════════════════════════════════════════

export interface AtmosphereLabelDef {
  /** 英文标识 */
  key: string
  /** 中文标签 */
  label: string
  /** 描述（用于生成指令） */
  description: string
  /** 对应的写作风格指令片段 */
  writingHint: string
}

export const ATMOSPHERE_LABELS: AtmosphereLabelDef[] = [
  {
    key: 'tension',
    label: '紧张',
    description: '紧张、压迫感、悬疑笼罩',
    writingHint: '营造紧张氛围，节奏紧凑，悬念迭起，读者心跳加速',
  },
  {
    key: 'joy',
    label: '欢乐',
    description: '欢乐、温馨、轻松愉快',
    writingHint: '氛围明亮欢快，文字轻快流畅，充满温暖与笑容',
  },
  {
    key: 'sadness',
    label: '悲伤',
    description: '悲伤、忧郁、感伤',
    writingHint: '营造伤感氛围，文字舒缓低沉，带有淡淡的忧伤与怀念',
  },
  {
    key: 'calmness',
    label: '平静',
    description: '平静、安宁、祥和',
    writingHint: '氛围平和安宁，描写舒缓自然，节奏平缓有序',
  },
  {
    key: 'mystery',
    label: '神秘',
    description: '神秘、诡异、未知',
    writingHint: '营造神秘氛围，悬念伏笔交错，文字朦胧含蓄',
  },
  {
    key: 'romance',
    label: '浪漫',
    description: '浪漫、温柔、甜蜜',
    writingHint: '氛围温馨浪漫，文字柔软细腻，情感含蓄而动人',
  },
]
