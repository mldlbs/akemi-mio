import { useState, useEffect, useRef, useCallback } from 'react'

// =============================================================================
// EmotionalWaveform — 情感记忆语音叙事波形动画
// =============================================================================
//
// 在桌面壁纸底部 TTS 字幕上方显示实时情感波形动画：
//   - 叙事开始时显示波形
//   - 每段的情感强度（valence + arousal）驱动波形幅值和颜色
//   - 波形条数随情感强度变化（高潮段落更密集）
//   - 叙事结束后渐隐消失
//
// 配色方案（基于情感）：
//   - 开心/兴奋: 暖色橙黄 (#fbbf24 → #f59e0b)
//   - 悲伤: 冷色蓝紫 (#818cf8 → #6366f1)
//   - 平静/中性: 柔和青 (#34d399 → #10b981)
//   - 生气/焦虑: 警示红橙 (#f87171 → #ef4444)
//
// =============================================================================

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

interface WaveformBar {
  /** 柱条高度 (0–1) */
  height: number
  /** 柱条偏移延迟（动画用） */
  delay: number
  /** 柱条宽度（px） */
  width: number
}

/** 波形状态 */
type WaveformState = 'hidden' | 'entering' | 'active' | 'exiting'

/** 情感调色板 */
const EMOTION_COLORS: Record<string, { primary: string; secondary: string; glow: string }> = {
  happy:    { primary: '#fbbf24', secondary: '#f59e0b', glow: 'rgba(251,191,36,0.3)' },
  sad:      { primary: '#818cf8', secondary: '#6366f1', glow: 'rgba(129,140,248,0.3)' },
  angry:    { primary: '#f87171', secondary: '#ef4444', glow: 'rgba(248,113,113,0.3)' },
  calm:     { primary: '#34d399', secondary: '#10b981', glow: 'rgba(52,211,153,0.3)' },
  anxious:  { primary: '#fb923c', secondary: '#f97316', glow: 'rgba(251,146,60,0.3)' },
  neutral:  { primary: '#94a3b8', secondary: '#64748b', glow: 'rgba(148,163,184,0.3)' },
  // 中文标签映射
  '开心': { primary: '#fbbf24', secondary: '#f59e0b', glow: 'rgba(251,191,36,0.3)' },
  '温暖': { primary: '#a78bfa', secondary: '#8b5cf6', glow: 'rgba(167,139,250,0.3)' },
  '严肃': { primary: '#f87171', secondary: '#ef4444', glow: 'rgba(248,113,113,0.3)' },
  '悲伤': { primary: '#818cf8', secondary: '#6366f1', glow: 'rgba(129,140,248,0.3)' },
  '兴奋': { primary: '#fbbf24', secondary: '#f59e0b', glow: 'rgba(251,191,36,0.3)' },
  '平静': { primary: '#34d399', secondary: '#10b981', glow: 'rgba(52,211,153,0.3)' },
  '中性': { primary: '#94a3b8', secondary: '#64748b', glow: 'rgba(148,163,184,0.3)' },
}

/** 默认中性色 */
const DEFAULT_COLOR = EMOTION_COLORS.neutral

/** 波形柱条数量 */
const BAR_COUNT = 48

/** 波形动画帧间隔（ms） */
const ANIMATION_INTERVAL = 50

/** 入场/出场动画持续（ms） */
const TRANSITION_DURATION = 600

// ══════════════════════════════════════════
//  EmotionalWaveform 组件
// ══════════════════════════════════════════

export function EmotionalWaveform() {
  const [waveformState, setWaveformState] = useState<WaveformState>('hidden')
  const [bars, setBars] = useState<WaveformBar[]>([])
  const [currentColor, setCurrentColor] = useState(DEFAULT_COLOR)
  const [segmentLabel, setSegmentLabel] = useState('')
  const [progress, setProgress] = useState({ current: 0, total: 0 })
  const [narrativeActive, setNarrativeActive] = useState(false)

  const animationRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const intensityRef = useRef(0.5)
  const frameRef = useRef(0)

  // ══════════════════════════════════════════
  //  波形生成
  // ══════════════════════════════════════════

  const generateBars = useCallback((intensity: number, frame: number): WaveformBar[] => {
    const result: WaveformBar[] = []
    const center = BAR_COUNT / 2

    for (let i = 0; i < BAR_COUNT; i++) {
      // 波形形状: 中间高、两边低，叠加随时间变化的相位
      const distance = Math.abs(i - center) / center
      const phase = (frame * 0.3) + (i * 0.4)
      const wave = Math.sin(phase) * 0.4 + 0.6

      // 基础高度由 intensity 和 wave 共同决定
      const baseHeight = (1 - distance * 0.3) * intensity * 0.8
      const dynamicHeight = baseHeight * (0.5 + wave * 0.5)

      // 加入随机微调
      const jitter = Math.sin(frame * 0.1 + i * 0.7) * 0.1

      result.push({
        height: Math.max(0.05, Math.min(1, dynamicHeight + jitter)),
        delay: i * 0.02,
        width: Math.max(2, Math.min(6, 4 + intensity * 2)),
      })
    }
    return result
  }, [])

  // ══════════════════════════════════════════
  //  情感标签 → 颜色映射
  // ══════════════════════════════════════════

  const labelToColor = useCallback((label: string) => {
    return EMOTION_COLORS[label] || DEFAULT_COLOR
  }, [])

  // ══════════════════════════════════════════
  //  IPC 事件订阅
  // ══════════════════════════════════════════

  // 叙事开始
  useEffect(() => {
    const unsub = window.electronAPI.onEmotionalNarrativeStart?.((data) => {
      setProgress({ current: 0, total: data.totalSegments })
      setNarrativeActive(true)
      setWaveformState('entering')
      setSegmentLabel('')

      // 入场动画结束后进入 active
      setTimeout(() => {
        setWaveformState('active')
      }, TRANSITION_DURATION)
    })
    return () => { unsub?.() }
  }, [])

  // 叙事段落更新
  useEffect(() => {
    const unsub = window.electronAPI.onEmotionalNarrativeSegment?.((data) => {
      setProgress({ current: data.index + 1, total: data.total })
      setSegmentLabel(data.label)
      setCurrentColor(labelToColor(data.label))

      // 根据段落持续时间调整 intensity
      const intensity = Math.min(1, data.durationMs / 5000) * 0.7 + 0.3
      intensityRef.current = intensity
    })
    return () => { unsub?.() }
  }, [labelToColor])

  // 叙事结束
  useEffect(() => {
    const unsub = window.electronAPI.onEmotionalNarrativeEnd?.((data) => {
      setWaveformState('exiting')

      // 出场动画结束后隐藏
      setTimeout(() => {
        setWaveformState('hidden')
        setNarrativeActive(false)
        setSegmentLabel('')
        setProgress({ current: 0, total: 0 })
      }, TRANSITION_DURATION)
    })
    return () => { unsub?.() }
  }, [])

  // 叙事取消
  useEffect(() => {
    const unsub = window.electronAPI.onEmotionalNarrativeCancel?.(() => {
      setWaveformState('exiting')
      setTimeout(() => {
        setWaveformState('hidden')
        setNarrativeActive(false)
        setSegmentLabel('')
        setProgress({ current: 0, total: 0 })
      }, TRANSITION_DURATION)
    })
    return () => { unsub?.() }
  }, [])

  // ══════════════════════════════════════════
  //  波形动画循环
  // ══════════════════════════════════════════

  useEffect(() => {
    if (waveformState !== 'active') {
      if (animationRef.current) {
        clearInterval(animationRef.current)
        animationRef.current = null
      }
      return
    }

    // 启动动画循环
    animationRef.current = setInterval(() => {
      frameRef.current++
      setBars(generateBars(intensityRef.current, frameRef.current))
    }, ANIMATION_INTERVAL)

    return () => {
      if (animationRef.current) {
        clearInterval(animationRef.current)
        animationRef.current = null
      }
    }
  }, [waveformState, generateBars])

  // ══════════════════════════════════════════
  //  入场/出场时的过渡柱条
  // ══════════════════════════════════════════

  useEffect(() => {
    if (waveformState === 'entering') {
      // 生成初始柱条
      setBars(generateBars(0.3, 0))
    } else if (waveformState === 'hidden') {
      setBars([])
    }
  }, [waveformState, generateBars])

  // ══════════════════════════════════════════
  //  样式计算
  // ══════════════════════════════════════════

  const containerOpacity =
    waveformState === 'hidden' ? 0 :
    waveformState === 'entering' ? 0.8 :
    waveformState === 'exiting' ? 0 : 1

  if (!narrativeActive && waveformState === 'hidden') return null

  return (
    <div
      className="wp-emotional-waveform"
      style={{
        opacity: containerOpacity,
        transition: `opacity ${TRANSITION_DURATION}ms ease`,
      }}
    >
      {/* 渐变背景 */}
      <div
        className="wp-emotional-waveform-bg"
        style={{
          background: `linear-gradient(90deg, transparent 0%, ${currentColor.glow} 30%, ${currentColor.glow} 70%, transparent 100%)`,
        }}
      />

      {/* 波形柱状图 */}
      <div className="wp-emotional-waveform-bars">
        {bars.slice(0, BAR_COUNT).map((bar, i) => (
          <div
            key={`bar-${i}`}
            className="wp-emotional-waveform-bar"
            style={{
              height: `${bar.height * 100}%`,
              width: `${bar.width}px`,
              background: currentColor.primary,
              boxShadow: `0 0 6px ${currentColor.glow}`,
              animationDelay: `${bar.delay}s`,
              transition: 'height 0.1s ease, background 0.3s ease',
            }}
          />
        ))}
      </div>

      {/* 进度指示器 */}
      <div className="wp-emotional-waveform-footer">
        {progress.total > 0 && (
          <div className="wp-emotional-waveform-progress">
            {Array.from({ length: progress.total }, (_, i) => (
              <div
                key={`dot-${i}`}
                className="wp-emotional-waveform-dot"
                style={{
                  background: i < progress.current ? currentColor.primary : 'rgba(255,255,255,0.2)',
                  boxShadow: i < progress.current ? `0 0 4px ${currentColor.primary}` : 'none',
                }}
              />
            ))}
          </div>
        )}
        {segmentLabel && (
          <span
            className="wp-emotional-waveform-label"
            style={{ color: currentColor.primary }}
          >
            {segmentLabel}
          </span>
        )}
      </div>
    </div>
  )
}
