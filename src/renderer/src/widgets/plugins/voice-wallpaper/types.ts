/**
 * Voice Dynamic Wallpaper — 类型定义
 *
 * 定义语音动态壁纸的配置、状态和可视化参数类型。
 */

// =============================================================================
// 可视化风格
// =============================================================================

/** 内置可视化风格 */
export type VisualStyle =
  /** 频谱波形：以 FFT 频率数据驱动的柱状频谱图 */
  | 'spectrum'
  /** 声波涟漪：从中心扩散的圆形波纹 */
  | 'ripple'
  /** 粒子律动：粒子系统随语音节奏跳动 */
  | 'particle'

// =============================================================================
// 触发模式
// =============================================================================

/** 可视化触发模式 */
export type TriggerMode =
  /** 仅 TTS 播放时显示 */
  | 'tts_only'
  /** 持续可见（TTS 播放时进入活跃模式） */
  | 'always'

// =============================================================================
// 情感映射 — 从 TTS 情感参数到可视化颜色
// =============================================================================

/**
 * 情感 → 色彩方案映射
 * 根据语音情感标签（label）选择背景色调和粒子颜色
 */
export interface EmotionColorScheme {
  /** 背景主色调（CSS 颜色） */
  primaryColor: string
  /** 背景次色调（CSS 颜色） */
  secondaryColor: string
  /** 波形/粒子颜色 */
  accentColor: string
  /** 高光颜色 */
  highlightColor: string
  /** 情感标签匹配模式 */
  labelPattern: RegExp
}

/** 默认情感-色彩映射表 */
export const DEFAULT_EMOTION_COLORS: EmotionColorScheme[] = [
  {
    labelPattern: /常规|默认|日常|中性|neutral/i,
    primaryColor: '#1a2a4a',
    secondaryColor: '#0d1a2a',
    accentColor: '#4a8aff',
    highlightColor: '#7ab8ff',
  },
  {
    labelPattern: /开心|欢快|cheerful|happy|活力|表现/i,
    primaryColor: '#2a1a4a',
    secondaryColor: '#1a0d2a',
    accentColor: '#ff6b9d',
    highlightColor: '#ff9ec4',
  },
  {
    labelPattern: /安抚|悲伤|sad|轻柔|gentle/i,
    primaryColor: '#1a2a3a',
    secondaryColor: '#0d1a2a',
    accentColor: '#6ba8ff',
    highlightColor: '#9ec8ff',
  },
  {
    labelPattern: /平和|平静|calm|沉稳|empathetic/i,
    primaryColor: '#1a3a2a',
    secondaryColor: '#0d1f15',
    accentColor: '#4ac89a',
    highlightColor: '#7ae0b8',
  },
  {
    labelPattern: /高效|专注|focused|严肃|serious|determined/i,
    primaryColor: '#2a2a1a',
    secondaryColor: '#1a1a0d',
    accentColor: '#ffaa44',
    highlightColor: '#ffcc77',
  },
  {
    labelPattern: /.*/,
    primaryColor: '#1a2a4a',
    secondaryColor: '#0d1a2a',
    accentColor: '#4a8aff',
    highlightColor: '#7ab8ff',
  },
]

// =============================================================================
// 运行时状态
// =============================================================================

/**
 * 语音可视化运行时状态
 * 由 useVoiceState hook 维护，通过 props 传递给 Visualizer
 */
export interface VoiceVisualizationState {
  /** TTS 是否正在播放 */
  isPlaying: boolean
  /** 当前情感参数 */
  emotionParams: {
    voice: string
    rate: string
    pitch: string
    label: string
  }
  /** 当前播放文本 */
  text: string
  /** 匹配到的色彩方案 */
  colorScheme: EmotionColorScheme
  /** 归一化能量值 (0-1) */
  energy: number
  /** FFT 频率数据快照（128 bins） */
  freqData: Uint8Array
  /** 上次更新时间戳 */
  timestamp: number
}

// =============================================================================
// 用户配置
// =============================================================================

/** 语音动态壁纸用户配置 */
export interface VoiceWallpaperConfig {
  /** 可视化风格 */
  style: VisualStyle
  /** 触发模式 */
  triggerMode: TriggerMode
  /** 透明度 (0-1) */
  opacity: number
  /** 是否显示波形 */
  showWaveform: boolean
  /** 是否显示粒子效果 */
  showParticles: boolean
  /** 是否显示背景光晕 */
  showGlow: boolean
  /** 波形敏感度 (0.5-2.0) */
  sensitivity: number
  /** 是否启用 */
  enabled: boolean
}

/** 默认配置 */
export const DEFAULT_VOICE_WALLPAPER_CONFIG: VoiceWallpaperConfig = {
  style: 'spectrum',
  triggerMode: 'tts_only',
  opacity: 0.6,
  showWaveform: true,
  showParticles: true,
  showGlow: true,
  sensitivity: 1.0,
  enabled: true,
}
