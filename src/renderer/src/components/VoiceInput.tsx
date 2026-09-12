import { useRef, useState, useCallback, useEffect } from 'react'
import { updateMicEnergy, stopTTS } from './audioShared'
import { useDeviceStore } from '../store/deviceStore'

const RLOG = (level: string, event: string, meta?: Record<string, unknown>) => {
  const beijing = new Date(Date.now() + 8 * 3600 * 1000)
  const ts = beijing.toISOString().replace('Z', '+08:00')
  console.log(JSON.stringify({ level, timestamp: ts, event, ...(meta || {}) }))
}

interface VoiceInputProps {
  onResult: (text: string, requestId?: string) => void
  disabled?: boolean
  onWakeWord?: () => void
}

const SILENCE_MS = 6000
const BUFFER_SIZE = 2048
const ASR_SAMPLE_RATE = 16000
const MIN_SPEAKING_FRAMES = 2
const GRACE_FRAMES = 40
const NOISE_FLOOR_FRAMES = 50
const RMS_MULTIPLIER = 2.5
const SPEECH_ZCR_MAX = 0.25
const MAX_ASR_AUDIO_SECONDS = 25
const INTERRUPTION_MIN_FRAMES = 18
const INTERRUPTION_RMS_MULTIPLIER = 3.5
const MIN_ASR_SAMPLES = 8000
const DEFAULT_WAKE_WORDS = ['澪', '秋山澪', 'mio', 'Mio', '开始对话']
const NOISE_COOLDOWN_THRESHOLD = 3
const NOISE_COOLDOWN_MS = 8000
const TAIL_MS = 4000
const POST_TAIL_QUIET_MS = 4000

type Mode = 'idle' | 'wake' | 'listening' | 'processing' | 'playing_tts' | 'echo_tail'
const TAIL_SPEECH_RMS_MULTIPLIER = 5.0

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

/**
 * 快速选择第 k 小元素（k 从 0 开始），期望 O(n)，避免全排序 O(n log n)
 */
function quickSelect(arr: number[], k: number): number {
  if (arr.length === 0) return 0
  const a = arr.slice() // 不修改原数组
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

export function VoiceInput({ onResult, disabled, onWakeWord }: VoiceInputProps) {
  const ttsPlaying = useDeviceStore((s) => s.ttsPlaying)
  const setActive = useDeviceStore((s) => s.setActive)

  const [active, setActiveLocal] = useState(false)
  const [status, setStatus] = useState('')
  const modeRef = useRef<Mode>('idle')
  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const samplesRef = useRef<Float32Array[]>([])
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isSpeakingRef = useRef(false)
  const interruptSamplesRef = useRef<Float32Array[]>([])
  const wakeWordsRef = useRef<string[]>(DEFAULT_WAKE_WORDS)
  const ttsEchoBufferRef = useRef<Float32Array[]>([])
  const ttsEndTimeRef = useRef(0)
  const postTailNoCaptureUntilRef = useRef(0)

  useEffect(() => {
    window.electronAPI
      .getWakeWords()
      .then((words) => {
        wakeWordsRef.current = words
        RLOG('INFO', 'wake_words_loaded', { words })
      })
      .catch((err) => {
        RLOG('WARN', 'wake_words_load_failed', { error: String(err) })
      })
  }, [])

  const noiseCooldownRef = useRef(0)
  const consecutiveEmptyResultsRef = useRef(0)

  const setMode = useCallback((m: Mode) => {
    modeRef.current = m
    RLOG('INFO', 'mode_change', { mode: m })
  }, [])
  const isMode = (m: Mode) => modeRef.current === m
  const isWake = () => isMode('wake')
  const isListening = () => isMode('listening') || isMode('wake') || isMode('echo_tail')

  const closeAudio = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current)
      silenceTimerRef.current = null
    }
    if (processorRef.current) {
      processorRef.current.onaudioprocess = null
      processorRef.current.disconnect()
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close()
      audioCtxRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    processorRef.current = null
  }, [])

  const processAudio = useCallback(
    async (samples: Float32Array[], sampleRate: number) => {
      if (!samples.length) return
      setMode('processing')

      let totalLen = 0
      for (const s of samples) totalLen += s.length
      const merged = new Float32Array(totalLen)
      let off = 0
      for (const s of samples) {
        merged.set(s, off)
        off += s.length
      }
      samples.length = 0

      let resampled = sampleRate !== ASR_SAMPLE_RATE ? resample(merged, sampleRate, ASR_SAMPLE_RATE) : merged
      const maxSamples = MAX_ASR_AUDIO_SECONDS * ASR_SAMPLE_RATE
      if (resampled.length > maxSamples) resampled = resampled.slice(resampled.length - maxSamples)
      if (resampled.length < MIN_ASR_SAMPLES) {
        RLOG('WARN', 'asr_audio_too_short', { samples: resampled.length })
        if (isListening()) setStatus('监听中...')
        modeRef.current = isWake() ? 'wake' : 'listening'
        return
      }

      let peak = 0
      for (let i = 0; i < resampled.length; i++) {
        const v = Math.abs(resampled[i])
        if (v > peak) peak = v
      }
      const gain = peak > 0.001 ? Math.min(0.6 / peak, 20) : 1
      const pcm = new Int16Array(resampled.length)
      for (let i = 0; i < resampled.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, resampled[i] * gain * 32768))

      const audioBuf = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)
      setStatus('识别中...')

      let result: { text: string; request_id?: string; error?: string }
      if (Date.now() - ttsEndTimeRef.current < 1500) {
        RLOG('INFO', 'asr_skip_echo_tail', { sinceTtsEnd: Date.now() - ttsEndTimeRef.current })
        if (isListening()) setStatus('监听中...')
        modeRef.current = isWake() ? 'wake' : 'listening'
        return
      }
      try {
        result = await window.electronAPI.transcribe(audioBuf)
      } catch (err) {
        RLOG('ERROR', 'asr_transcribe_crash', { error: String(err) })
        setStatus('识别异常')
        setTimeout(() => {
          if (isListening()) setStatus('监听中...')
        }, 1500)
        modeRef.current = isWake() ? 'wake' : 'listening'
        return
      }

      if (result.text && result.text.trim()) {
        consecutiveEmptyResultsRef.current = 0
        noiseCooldownRef.current = 0

        if (modeRef.current === 'idle') {
          RLOG('INFO', 'asr_skip_conversation_closed', { text: result.text })
          return
        }

        if (isWake()) {
          const wakeHit = wakeWordsRef.current.some((w) => result.text.includes(w))
          if (wakeHit) {
            RLOG('INFO', 'wake_word_detected', { text: result.text })
            setMode('listening')
            setActiveLocal(true)
            setActive(true)
            onWakeWord?.()
            setStatus('监听中...')
            samplesRef.current = []
            return
          }
          modeRef.current = 'wake'
          return
        }
        onResult(result.text, result.request_id)
        modeRef.current = 'listening'
      } else if (result.error) {
        setStatus(`识别失败: ${result.error}`)
        consecutiveEmptyResultsRef.current++
        setTimeout(() => {
          if (isListening()) setStatus('监听中...')
        }, 1500)
        modeRef.current = isWake() ? 'wake' : 'listening'
      } else {
        consecutiveEmptyResultsRef.current++
        if (consecutiveEmptyResultsRef.current >= NOISE_COOLDOWN_THRESHOLD) {
          noiseCooldownRef.current = Date.now() + NOISE_COOLDOWN_MS
          consecutiveEmptyResultsRef.current = 0
          RLOG('INFO', 'asr_noise_cooldown_activated', { cooldown_ms: NOISE_COOLDOWN_MS })
          setStatus(`背景音已忽略 ${NOISE_COOLDOWN_MS / 1000}s`)
          setTimeout(() => {
            if (isListening()) setStatus('监听中...')
          }, 1500)
        } else {
          setStatus('没听清，请再说一遍')
          setTimeout(() => {
            if (isListening()) setStatus('监听中...')
          }, 800)
        }
        modeRef.current = isWake() ? 'wake' : 'listening'
      }
    },
    [onResult, onWakeWord, setActive],
  )

  const setupAudio = useCallback(async () => {
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
      let graceFrames = 0
      const noiseFloorHistory: number[] = []
      let dynamicThreshold = 0.06
      let lastVadEvent = 0
      let interruptionFrames = 0
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current)
        silenceTimerRef.current = null
      }

      let tailTimer: ReturnType<typeof setTimeout> | null = null

      RLOG('INFO', 'audio_capture_start', { sampleRate: sr })
      RLOG('INFO', 'vad_config', { silenceMs: SILENCE_MS })

      processor.onaudioprocess = (e) => {
        const mode = modeRef.current
        if (mode === 'idle') return
        const input = e.inputBuffer.getChannelData(0)

        let sum = 0,
          zcr = 0
        for (let i = 0; i < input.length; i++) {
          sum += input[i] * input[i]
          if (i > 0 && ((input[i - 1] >= 0 && input[i] < 0) || (input[i - 1] < 0 && input[i] >= 0))) zcr++
        }
        const rms = Math.sqrt(sum / input.length)
        const zcrRate = zcr / input.length
        updateMicEnergy(rms)

        noiseFloorHistory.push(rms)
        if (noiseFloorHistory.length > NOISE_FLOOR_FRAMES) noiseFloorHistory.shift()
        // 快速选择第 20 百分位，避免 O(n log n) 全排序
        const noiseFloor = quickSelect(noiseFloorHistory, Math.floor(noiseFloorHistory.length * 0.2)) || 0.001
        dynamicThreshold = Math.max(0.06, noiseFloor * RMS_MULTIPLIER)
        const aboveNoise = rms > dynamicThreshold && zcrRate < SPEECH_ZCR_MAX
        const aboveInterruption = rms > dynamicThreshold * INTERRUPTION_RMS_MULTIPLIER && zcrRate < SPEECH_ZCR_MAX

        if (mode === 'playing_tts') {
          if (aboveInterruption) {
            interruptionFrames++
          } else {
            interruptionFrames = 0
          }
          ttsEchoBufferRef.current.push(new Float32Array(input))

          if (interruptionFrames >= INTERRUPTION_MIN_FRAMES) {
            RLOG('INFO', 'tts_interruption_detected', {
              rms,
              threshold: dynamicThreshold * INTERRUPTION_RMS_MULTIPLIER,
              frames: interruptionFrames,
            })
            window.electronAPI.stopSpeaking()
            stopTTS()
            ttsEchoBufferRef.current = []
            interruptSamplesRef.current = []
            samplesRef.current = []
            interruptionFrames = 0
            isSpeakingRef.current = false
            ttsEndTimeRef.current = Date.now()
            setMode('echo_tail')
            setStatus('尾音保护...')
          }
          return
        }

        if (mode === 'echo_tail') {
          ttsEchoBufferRef.current.push(new Float32Array(input))
          const aboveRealVoice = rms > dynamicThreshold * TAIL_SPEECH_RMS_MULTIPLIER && zcrRate < SPEECH_ZCR_MAX
          if (aboveRealVoice) {
            speechFrames = Math.min(speechFrames + 1, MIN_SPEAKING_FRAMES + 1)
          } else {
            speechFrames = 0
          }
          if (speechFrames >= MIN_SPEAKING_FRAMES) {
            if (tailTimer) {
              clearTimeout(tailTimer)
              tailTimer = null
            }
            ttsEchoBufferRef.current = []
            samplesRef.current = []
            isSpeakingRef.current = false
            setMode('listening')
            setStatus('说话中...')
          }
          return
        }

        interruptionFrames = 0

        if (Date.now() < postTailNoCaptureUntilRef.current) {
          if (aboveNoise) graceFrames = GRACE_FRAMES
          isSpeakingRef.current = false
          return
        }

        if (aboveNoise) {
          speechFrames = Math.min(speechFrames + 1, MIN_SPEAKING_FRAMES + 1)
        } else {
          speechFrames = 0
        }
        const speaking = speechFrames >= MIN_SPEAKING_FRAMES
        const buf = interruptSamplesRef.current.length > 0 ? interruptSamplesRef.current : samplesRef.current

        if (aboveNoise || isSpeakingRef.current || speaking || graceFrames > 0) {
          buf.push(new Float32Array(input))
          if (aboveNoise) graceFrames = GRACE_FRAMES
          else if (graceFrames > 0) graceFrames--
        }

        if (aboveNoise && !isSpeakingRef.current && Date.now() - lastVadEvent > 5000) {
          lastVadEvent = Date.now()
          RLOG('PERF', 'vad_speech_detected', { rms, zcr: zcrRate, threshold: dynamicThreshold })
        }
        if (isSpeakingRef.current && !speaking && Date.now() - lastVadEvent > 1000) {
          lastVadEvent = Date.now()
          RLOG('PERF', 'vad_speech_ended', { noiseFloor })
        }

        if (speaking) {
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current)
            silenceTimerRef.current = null
          }
          setStatus('说话中...')
        } else if (isSpeakingRef.current && !silenceTimerRef.current && mode === 'listening') {
          if (Date.now() < noiseCooldownRef.current) {
            RLOG('INFO', 'asr_skip_noise_cooldown', { until: noiseCooldownRef.current })
            buf.splice(0)
            isSpeakingRef.current = false
            samplesRef.current = []
            setStatus('监听中...')
            return
          }
          const captured = buf
          silenceTimerRef.current = setTimeout(() => {
            silenceTimerRef.current = null
            if (modeRef.current !== 'listening' && modeRef.current !== 'wake') return
            setStatus('识别中...')
            processAudio(captured.splice(0), sr)
          }, SILENCE_MS)
          setStatus('等待结尾...')
        }

        isSpeakingRef.current = speaking
      }

      source.connect(highpass)
      highpass.connect(lowpass)
      lowpass.connect(processor)
      processor.connect(audioCtx.destination)
    } catch (err) {
      console.error('启动录音失败:', err)
      setStatus('麦克风不可用')
    }
  }, [processAudio])

  useEffect(() => {
    if (ttsPlaying && isListening()) {
      setMode('playing_tts')
      ttsEchoBufferRef.current = []
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current)
        silenceTimerRef.current = null
      }
      setStatus('回复中...')
      return
    }

    if (!ttsPlaying && modeRef.current === 'playing_tts') {
      RLOG('INFO', 'vad_enter_echo_tail', { tailMs: TAIL_MS })
      setMode('echo_tail')
      ttsEndTimeRef.current = Date.now()
      setStatus('尾音保护...')

      const t = setTimeout(() => {
        if (modeRef.current === 'echo_tail') {
          RLOG('INFO', 'vad_tts_tail_ended', { discarded: ttsEchoBufferRef.current.length })
          ttsEchoBufferRef.current = []
          postTailNoCaptureUntilRef.current = Date.now() + POST_TAIL_QUIET_MS
          modeRef.current = isWake() ? 'wake' : 'listening'
          setStatus('监听中...')
        }
      }, TAIL_MS)
      return () => clearTimeout(t)
    }
  }, [ttsPlaying, setMode])

  useEffect(() => {
    return () => {
      closeAudio()
      modeRef.current = 'idle'
    }
  }, [closeAudio])

  const toggleConversation = useCallback(() => {
    if (active) {
      window.electronAPI.stopConversation().catch(() => {})
      window.electronAPI.stopSpeaking().catch(() => {})
      closeAudio()
      modeRef.current = 'idle'
      samplesRef.current = []
      interruptSamplesRef.current = []
      ttsEchoBufferRef.current = []
      isSpeakingRef.current = false
      setActiveLocal(false)
      setActive(false)
      setStatus('')
    } else {
      setMode('listening')
      setActiveLocal(true)
      setActive(true)
      setStatus('监听中...')
      if (!streamRef.current) {
        setupAudio().catch((err) => {
          RLOG('ERROR', 'mic_setup_failed', { error: String(err) })
          setStatus('麦克风启动失败')
          setActiveLocal(false)
          setActive(false)
          setMode('idle')
        })
      }
    }
  }, [active, closeAudio, setupAudio, setActive])

  return (
    <div className="voice-input">
      <button className={`btn-voice ${active ? 'active' : ''}`} onClick={toggleConversation} disabled={disabled}>
        <i className={`${active ? 'ri-stop-fill' : 'ri-mic-fill'}`} />
      </button>
      <button
        className="btn-icon btn-danger"
        onClick={() => {
          window.electronAPI?.stopSpeaking?.()
          stopTTS()
        }}
        disabled={!ttsPlaying}
      >
        <i className="ri-stop-circle-line" />
      </button>
    </div>
  )
}
