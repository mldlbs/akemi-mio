/**
 * useVoiceState — 语音动态壁纸状态 Hook
 *
 * 订阅 TTS 语音状态 IPC，配合 audioShared 的 FFT 数据，
 * 为 VoiceVisualizer 提供实时的语音状态、情感参数和频谱数据。
 *
 * 数据流：
 *   Main Process (TTS subtitle + emotion) → IPC 'tts:voice-state' → hook
 *   Renderer (AudioContext AnalyserNode)  → audioShared.readTTSFreqData()  → hook (每帧读取)
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { readTTSFreqData, readTTSEnergy, onTTSStateChange } from '../../../components/audioShared'
import {
  DEFAULT_EMOTION_COLORS,
  DEFAULT_VOICE_WALLPAPER_CONFIG,
} from './types'
import type {
  VoiceVisualizationState,
  VoiceWallpaperConfig,
  EmotionColorScheme,
} from './types'

// =============================================================================
// 常量
// =============================================================================

/** 无语音活动超时后自动切换到 idle（ms） */
const VOICE_IDLE_TIMEOUT_MS = 2000

/** 默认情感参数（无语音时回退） */
const DEFAULT_EMOTION_PARAMS = {
  voice: 'zh-CN-XiaoxiaoNeural',
  rate: '+10%',
  pitch: '+8Hz',
  label: '中性·默认',
}

const DEFAULT_COLOR_SCHEME: EmotionColorScheme = {
  primaryColor: '#1a2a4a',
  secondaryColor: '#0d1a2a',
  accentColor: '#4a8aff',
  highlightColor: '#7ab8ff',
  labelPattern: /.*/,
}

// =============================================================================
// 情感标签 → 色彩方案匹配
// =============================================================================

/**
 * 根据情感标签匹配对应的色彩方案。
 * 按顺序匹配第一条 labelPattern 匹配的。
 */
function matchColorScheme(label: string): EmotionColorScheme {
  for (const scheme of DEFAULT_EMOTION_COLORS) {
    if (scheme.labelPattern.test(label)) {
      return scheme
    }
  }
  return DEFAULT_EMOTION_COLORS[DEFAULT_EMOTION_COLORS.length - 1]
}

// =============================================================================
// Hook
// =============================================================================

export interface UseVoiceStateOptions {
  /** 视觉配置 */
  config?: VoiceWallpaperConfig
}

export interface UseVoiceStateResult {
  /** 当前可视化状态 */
  state: VoiceVisualizationState
  /** 用户配置 */
  config: VoiceWallpaperConfig
  /** 更新配置 */
  updateConfig: (patch: Partial<VoiceWallpaperConfig>) => void
  /** 重置状态 */
  reset: () => void
}

export function useVoiceState(options?: UseVoiceStateOptions): UseVoiceStateResult {
  const { config: initialConfig = DEFAULT_VOICE_WALLPAPER_CONFIG } = options ?? {}

  // ── 状态 ──
  const [config, setConfig] = useState<VoiceWallpaperConfig>(initialConfig)
  const [state, setState] = useState<VoiceVisualizationState>({
    isPlaying: false,
    emotionParams: { ...DEFAULT_EMOTION_PARAMS },
    text: '',
    colorScheme: { ...DEFAULT_COLOR_SCHEME },
    energy: 0,
    freqData: new Uint8Array(0),
    timestamp: 0,
  })

  // ── Refs ──
  const stateRef = useRef(state)
  stateRef.current = state

  const configRef = useRef(config)
  configRef.current = config

  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const animFrameRef = useRef<number>(0)
  const isPlayingRef = useRef(false)

  // ===========================================================================
  // IPC 订阅：接收 TTS 语音状态
  // ===========================================================================

  useEffect(() => {
    if (!window.electronAPI?.onTTSVoiceState) return

    const unsub = window.electronAPI.onTTSVoiceState((payload) => {
      // 收到语音状态 → 标记播放中，更新情感参数
      isPlayingRef.current = true

      // 清除静默定时器
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current)
        idleTimerRef.current = null
      }

      const colorScheme = matchColorScheme(payload.emotionParams?.label ?? '')

      setState((prev) => ({
        ...prev,
        isPlaying: true,
        emotionParams: payload.emotionParams ?? prev.emotionParams,
        text: payload.text ?? '',
        colorScheme,
        timestamp: payload.timestamp ?? Date.now(),
      }))
    })

    return () => {
      unsub()
    }
  }, [])

  // ===========================================================================
  // 动画循环：每帧从 audioShared 读取 FFT/能量数据
  // ===========================================================================

  useEffect(() => {
    const tick = () => {
      animFrameRef.current = requestAnimationFrame(tick)

      const freqData = readTTSFreqData()
      const energy = readTTSEnergy()

      setState((prev) => {
        // 检测 TTS 是否已停止播放（能量归零且无 IPC 信号时）
        if (energy < 0.01 && prev.energy < 0.01 && prev.isPlaying) {
          // 启动静默定时器
          if (!idleTimerRef.current) {
            idleTimerRef.current = setTimeout(() => {
              isPlayingRef.current = false
              setState((s) => ({
                ...s,
                isPlaying: false,
                energy: 0,
                freqData: new Uint8Array(0),
              }))
            }, VOICE_IDLE_TIMEOUT_MS)
          }
          return prev
        }

        // 有能量活动 → 更新数据
        if (energy > 0.01) {
          if (idleTimerRef.current) {
            clearTimeout(idleTimerRef.current)
            idleTimerRef.current = null
          }
          return {
            ...prev,
            isPlaying: true,
            energy,
            freqData: freqData.length > 0 ? new Uint8Array(freqData) : prev.freqData,
            timestamp: Date.now(),
          }
        }

        return prev
      })
    }

    animFrameRef.current = requestAnimationFrame(tick)

    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current)
      }
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current)
      }
    }
  }, [])

  // ===========================================================================
  // 清理 TTS 状态变化
  // ===========================================================================

  useEffect(() => {
    const unsub = onTTSStateChange((newState) => {
      if (newState === 'idle' && isPlayingRef.current) {
        // AudioContext 已关闭，静默降级
        isPlayingRef.current = false
      }
    })
    return () => unsub()
  }, [])

  // ===========================================================================
  // 公开方法
  // ===========================================================================

  const updateConfig = useCallback((patch: Partial<VoiceWallpaperConfig>) => {
    setConfig((prev) => ({ ...prev, ...patch }))
  }, [])

  const reset = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
    isPlayingRef.current = false
    setState({
      isPlaying: false,
      emotionParams: { ...DEFAULT_EMOTION_PARAMS },
      text: '',
      colorScheme: { ...DEFAULT_COLOR_SCHEME },
      energy: 0,
      freqData: new Uint8Array(0),
      timestamp: 0,
    })
  }, [])

  return {
    state,
    config,
    updateConfig,
    reset,
  }
}
