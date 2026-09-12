/**
 * VoiceNoteWidget — 语音便签壁纸 Widget
 *
 * 在桌面壁纸层显示实时语音转写文字的半透明文本框。
 * 用户通过快捷键 Ctrl+Shift+V 或托盘菜单激活麦克风后，
 * ASR 将实时转写文字直接显示在壁纸上。
 *
 * 功能：
 *   1. 麦克风录音 + VAD 语音检测
 *   2. 定期调用 ASR 转写
 *   3. 固定/滚动两种显示模式
 *   4. 一键保存/复制/清除
 *   5. 自动清除（固定模式 5s 后清除）
 *   6. 鼠标穿透（pointer-events: none，仅操作区可交互）
 *
 * 区：overlay（覆盖层，与快捷键指南同级）
 * 可见性：仅 voiceNote 启用且激活时显示
 */

import React, { useRef, useEffect, useState, useCallback } from 'react'
import type { IWallpaperWidgetDefinition, WallpaperWidgetContext } from '../types'

// =============================================================================
// 常量
// =============================================================================

const SAMPLE_RATE = 16000
const BUFFER_SIZE = 4096
const SILENCE_MS = 2000
const MIN_SPEAKING_FRAMES = 3
const NOISE_FLOOR_FRAMES = 30
const RMS_MULTIPLIER = 2.5
const SPEECH_ZCR_MAX = 0.25
const AUTO_CLEAR_MS = 5000
const MAX_AUDIO_SECONDS = 25

// =============================================================================
// 类型
// =============================================================================

interface VoiceNoteState {
  enabled: boolean
  text: string
  displayMode: 'fixed' | 'scroll'
  saving: boolean
  lastSavedAt: number | null
}

// =============================================================================
// 组件
// =============================================================================

function VoiceNoteContent(ctx: WallpaperWidgetContext) {
  const [vnState, setVnState] = useState<VoiceNoteState>({
    enabled: false,
    text: '',
    displayMode: 'fixed',
    saving: false,
    lastSavedAt: null,
  })
  const [recording, setRecording] = useState(false)
  const [recordingStatus, setRecordingStatus] = useState('')
  const [showActions, setShowActions] = useState(false)

  // Refs for mic capture
  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const samplesRef = useRef<Float32Array[]>([])
  const isSpeakingRef = useRef(false)
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastTranscribeRef = useRef(0)
  // ── Refs to avoid stale closures in audio processor ──
  const enabledRef = useRef(false)
  const displayModeRef = useRef<'fixed' | 'scroll'>('fixed')
  enabledRef.current = vnState.enabled
  displayModeRef.current = vnState.displayMode

  // ── 订阅服务状态 ──
  useEffect(() => {
    const unsub = window.electronAPI.onVoicenoteStateChange((state) => {
      setVnState(state)
    })
    // 初始加载状态
    window.electronAPI.voicenoteGetState().then((res) => {
      if (res.state) setVnState(res.state)
    })
    return unsub
  }, [])

  // ── 根据 enabled 状态启动/停止录音 ──
  useEffect(() => {
    if (vnState.enabled) {
      startCapture()
    } else {
      stopCapture()
      setRecording(false)
      setRecordingStatus('')
    }
  }, [vnState.enabled])

  // ── 自动清除（fixed 模式） ──
  useEffect(() => {
    if (autoClearTimerRef.current) {
      clearTimeout(autoClearTimerRef.current)
      autoClearTimerRef.current = null
    }
    if (vnState.enabled && vnState.displayMode === 'fixed' && vnState.text) {
      autoClearTimerRef.current = setTimeout(() => {
        window.electronAPI.voicenoteClear()
        setShowActions(false)
      }, AUTO_CLEAR_MS)
    }
    return () => {
      if (autoClearTimerRef.current) {
        clearTimeout(autoClearTimerRef.current)
      }
    }
  }, [vnState.text, vnState.enabled, vnState.displayMode])

  // ── 录音逻辑 ──
  const stopCapture = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current)
      silenceTimerRef.current = null
    }
    if (processorRef.current) {
      processorRef.current.onaudioprocess = null
      processorRef.current.disconnect()
      processorRef.current = null
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close()
      audioCtxRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    samplesRef.current = []
    isSpeakingRef.current = false
  }, [])

  /** 快速选择第 k 小元素 */
  function quickSelect(arr: number[], k: number): number {
    if (arr.length === 0) return 0
    const a = arr.slice()
    let lo = 0,
      hi = a.length - 1
    while (lo < hi) {
      const pivot = a[lo + ((hi - lo) >>> 1)]
      let i = lo - 1,
        j = hi + 1
      while (true) {
        while (a[++i] < pivot);
        while (a[--j] > pivot);
        if (i >= j) break
        ;[a[i], a[j]] = [a[j], a[i]]
      }
      if (k <= j) hi = j
      else lo = j + 1
    }
    return a[k]
  }

  /** 重采样 */
  function resample(audio: Float32Array, fromRate: number, toRate: number): Float32Array {
    if (fromRate === toRate) return audio
    const ratio = fromRate / toRate
    const result = new Float32Array(Math.ceil(audio.length / ratio))
    for (let i = 0; i < result.length; i++) {
      const pos = i * ratio
      const idx = Math.floor(pos)
      const frac = pos - idx
      result[i] = idx + 1 < audio.length ? audio[idx] * (1 - frac) + audio[idx + 1] * frac : audio[idx] || 0
    }
    return result
  }

  /** 发送音频到 ASR */
  const transcribeAudio = useCallback(
    async (samples: Float32Array[], sampleRate: number) => {
      if (!samples.length) return

      setRecordingStatus('识别中...')

      let totalLen = 0
      for (const s of samples) totalLen += s.length
      const merged = new Float32Array(totalLen)
      let off = 0
      for (const s of samples) {
        merged.set(s, off)
        off += s.length
      }
      samples.length = 0

      let resampled = sampleRate !== SAMPLE_RATE ? resample(merged, sampleRate, SAMPLE_RATE) : merged
      const maxSamples = MAX_AUDIO_SECONDS * SAMPLE_RATE
      if (resampled.length > maxSamples) {
        resampled = resampled.slice(resampled.length - maxSamples)
      }

      // 计算增益并转为 PCM
      let peak = 0
      for (let i = 0; i < resampled.length; i++) {
        const v = Math.abs(resampled[i])
        if (v > peak) peak = v
      }
      const gain = peak > 0.001 ? Math.min(0.6 / peak, 20) : 1
      const pcm = new Int16Array(resampled.length)
      for (let i = 0; i < resampled.length; i++) {
        pcm[i] = Math.max(-32768, Math.min(32767, resampled[i] * gain * 32768))
      }

      try {
        const result = await window.electronAPI.transcribe(pcm.buffer as ArrayBuffer)
        if (result.text?.trim()) {
          lastTranscribeRef.current = Date.now()
          if (vnState.displayMode === 'scroll') {
            await window.electronAPI.voicenoteAppendText(result.text.trim())
          } else {
            await window.electronAPI.voicenoteSetText(result.text.trim())
          }
          setShowActions(true)
        } else if (result.error) {
          setRecordingStatus(`识别失败: ${result.error}`)
          setTimeout(() => {
            if (vnState.enabled) setRecordingStatus('监听中...')
          }, 1500)
        }
      } catch (err) {
        setRecordingStatus('识别异常')
        setTimeout(() => {
          if (vnState.enabled) setRecordingStatus('监听中...')
        }, 1500)
      }

      if (vnState.enabled) setRecordingStatus('监听中...')
    },
    [vnState.enabled, vnState.displayMode],
  )

  /** 启动麦克风捕获 */
  const startCapture = useCallback(async () => {
    if (streamRef.current) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      streamRef.current = stream
      const audioCtx = new AudioContext()
      audioCtxRef.current = audioCtx
      const sr = audioCtx.sampleRate
      const source = audioCtx.createMediaStreamSource(stream)

      const highpass = audioCtx.createBiquadFilter()
      highpass.type = 'highpass'
      highpass.frequency.value = 80
      highpass.Q.value = 0.7
      const lowpass = audioCtx.createBiquadFilter()
      lowpass.type = 'lowpass'
      lowpass.frequency.value = 7600
      lowpass.Q.value = 0.7

      const processor = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1)
      processorRef.current = processor
      samplesRef.current = []
      isSpeakingRef.current = false
      let speechFrames = 0
      const noiseFloorHistory: number[] = []

      setRecording(true)
      setRecordingStatus('监听中...')

      processor.onaudioprocess = (e) => {
        if (!enabledRef.current) return
        const input = e.inputBuffer.getChannelData(0)

        // RMS & ZCR
        let sum = 0,
          zcr = 0
        for (let i = 0; i < input.length; i++) {
          sum += input[i] * input[i]
          if (i > 0 && ((input[i - 1] >= 0 && input[i] < 0) || (input[i - 1] < 0 && input[i] >= 0))) zcr++
        }
        const rms = Math.sqrt(sum / input.length)
        const zcrRate = zcr / input.length

        noiseFloorHistory.push(rms)
        if (noiseFloorHistory.length > NOISE_FLOOR_FRAMES) noiseFloorHistory.shift()
        const noiseFloor = quickSelect(noiseFloorHistory, Math.floor(noiseFloorHistory.length * 0.2)) || 0.001
        const dynamicThreshold = Math.max(0.06, noiseFloor * RMS_MULTIPLIER)
        const speaking = rms > dynamicThreshold && zcrRate < SPEECH_ZCR_MAX

        // 语音检测
        if (speaking) {
          speechFrames = Math.min(speechFrames + 1, MIN_SPEAKING_FRAMES + 1)
          samplesRef.current.push(new Float32Array(input))
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current)
            silenceTimerRef.current = null
          }
          setRecordingStatus('说话中...')
        } else {
          speechFrames = 0
          if (isSpeakingRef.current && !silenceTimerRef.current) {
            silenceTimerRef.current = setTimeout(() => {
              silenceTimerRef.current = null
              if (!enabledRef.current) return
              transcribeAudio(samplesRef.current.splice(0), sr)
            }, SILENCE_MS)
            setRecordingStatus('等待结尾...')
          } else if (!isSpeakingRef.current) {
            // 静音时丢弃（不积累无语音片段）
          }
        }

        isSpeakingRef.current = speechFrames >= MIN_SPEAKING_FRAMES
      }

      source.connect(highpass)
      highpass.connect(lowpass)
      lowpass.connect(processor)
      processor.connect(audioCtx.destination)
    } catch (err) {
      console.error('语音便签麦克风启动失败:', err)
      setRecordingStatus('麦克风不可用')
    }
  }, [vnState.enabled, transcribeAudio])

  // ── 清理 ──
  useEffect(() => {
    return () => {
      stopCapture()
    }
  }, [stopCapture])

  // ── 操作按钮 ──
  const handleSave = useCallback(async () => {
    await window.electronAPI.voicenoteSave()
    setShowActions(false)
  }, [])

  const handleCopy = useCallback(async () => {
    await window.electronAPI.voicenoteCopy()
    setShowActions(false)
  }, [])

  const handleClear = useCallback(async () => {
    await window.electronAPI.voicenoteClear()
    setShowActions(false)
  }, [])

  const handleToggleMode = useCallback(async () => {
    const newMode = vnState.displayMode === 'fixed' ? 'scroll' : 'fixed'
    await window.electronAPI.voicenoteSetDisplayMode(newMode)
  }, [vnState.displayMode])

  const handleToggle = useCallback(async () => {
    await window.electronAPI.voicenoteToggle()
  }, [])

  if (!vnState.enabled && !vnState.text) return null

  return (
    <div
      className="voicenote-widget"
      style={{
        position: 'fixed',
        bottom: '15%',
        left: '50%',
        transform: 'translateX(-50%)',
        minWidth: 360,
        maxWidth: 'min(600px, 80vw)',
        background: 'var(--corner-float-paper)',
        backdropFilter: 'none',
        WebkitBackdropFilter: 'none',
        border: '1px solid var(--corner-float-border, oklch(0.58 0.014 92 / 0.13))',
        borderRadius: 12,
        padding: '14px 18px',
        color: 'var(--corner-float-ink)',
        fontSize: 15,
        lineHeight: 1.6,
        zIndex: 10000,
        pointerEvents: 'auto',
        transition: 'opacity 0.3s ease, transform 0.3s ease',
        boxShadow: 'var(--corner-float-shadow, 0 10px 26px oklch(0.24 0.018 92 / 0.055))',
      }}
    >
      {/* ── 状态指示器 ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
          fontSize: 12,
          color: 'var(--corner-float-muted)',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {recording && vnState.enabled && (
            <span
              style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: '#ff4444',
                animation: 'voicenote-pulse 1.2s ease-in-out infinite',
              }}
            />
          )}
          {recordingStatus || (vnState.enabled ? '就绪' : '')}
        </span>
        <span style={{ fontSize: 11 }}>{vnState.displayMode === 'fixed' ? '固定' : '滚动'}</span>
      </div>

      {/* ── 文本内容 ── */}
      <div
        style={{
          minHeight: 28,
          maxHeight: 200,
          overflowY: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          opacity: vnState.text ? 1 : 0.5,
        }}
      >
        {vnState.text || (vnState.enabled ? '等待语音输入...' : '')}
      </div>

      {/* ── 操作按钮 ── */}
      {showActions && vnState.text && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            marginTop: 10,
            justifyContent: 'flex-end',
            flexWrap: 'wrap',
          }}
        >
          <ActionButton label="复制" onClick={handleCopy} />
          <ActionButton label="保存笔记" onClick={handleSave} primary />
          <ActionButton label="清除" onClick={handleClear} />
          <ActionButton label={vnState.displayMode === 'fixed' ? '切换滚动' : '切换固定'} onClick={handleToggleMode} />
        </div>
      )}

      {/* ── 关闭按钮 ── */}
      {vnState.enabled && (
        <button
          onClick={handleToggle}
          style={{
            position: 'absolute',
            top: 6,
            right: 8,
            background: 'none',
            border: 'none',
            color: 'var(--corner-float-muted)',
            cursor: 'pointer',
            fontSize: 14,
            lineHeight: 1,
            padding: '2px 6px',
            borderRadius: 4,
          }}
          title="关闭语音便签"
        >
          ✕
        </button>
      )}
    </div>
  )
}

// =============================================================================
// 操作按钮子组件
// =============================================================================

function ActionButton({ label, onClick, primary }: { label: string; onClick: () => void; primary?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 12px',
        fontSize: 12,
        borderRadius: 6,
        border: primary ? '1px solid var(--accent)' : '1px solid var(--border-hairline, oklch(0.56 0.014 92 / 0.14))',
        background: primary ? 'var(--accent-bg)' : 'var(--bg-glass)',
        color: 'var(--corner-float-ink)',
        cursor: 'pointer',
        transition: 'background 0.15s',
      }}
    >
      {label}
    </button>
  )
}

// =============================================================================
// Widget 定义
// =============================================================================

export const voiceNoteWidget: IWallpaperWidgetDefinition = {
  id: 'voice-note',
  name: '语音便签',
  priority: 5,
  zone: 'overlay',
  shouldShow: () => true,
  Component: VoiceNoteContent,
}
