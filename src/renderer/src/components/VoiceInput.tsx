import { useRef, useState, useCallback, useEffect } from 'react'

const RLOG = (level: string, event: string, meta?: Record<string, unknown>) => {
  const entry: Record<string, unknown> = {
    level,
    timestamp: new Date().toISOString(),
    event,
    ...(meta || {})
  }
  console.log(JSON.stringify(entry))
}

interface VoiceInputProps {
  onResult: (text: string) => void
  disabled?: boolean
  onConversationChange?: (active: boolean) => void
  ttsPlaying?: boolean
}

const SILENCE_MS = 1200
const RMS_THRESHOLD = 0.06
const BUFFER_SIZE = 2048
const ASR_SAMPLE_RATE = 16000
const MIN_SPEAKING_FRAMES = 2
const NOISE_FLOOR_FRAMES = 50
const RMS_MULTIPLIER = 2.5
const SPEECH_ZCR_MAX = 0.25

function resample(audio: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return audio
  const ratio = fromRate / toRate
  const len = Math.ceil(audio.length / ratio)
  const result = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    const pos = i * ratio
    const idx = Math.floor(pos)
    const frac = pos - idx
    if (idx + 1 < audio.length) {
      result[i] = audio[idx] * (1 - frac) + audio[idx + 1] * frac
    } else {
      result[i] = audio[idx] || 0
    }
  }
  return result
}

export function VoiceInput({ onResult, disabled, onConversationChange, ttsPlaying }: VoiceInputProps) {
  const [active, setActive] = useState(false)
  const [status, setStatus] = useState('')
  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const samplesRef = useRef<Float32Array[]>([])
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isSpeakingRef = useRef(false)
  const activeRef = useRef(false)
  const processingRef = useRef(false)
  const ttsPlayingRef = useRef(false)
  const interruptionRef = useRef(false)
  const interruptSamplesRef = useRef<Float32Array[]>([])

  ttsPlayingRef.current = !!ttsPlaying

  const cleanupAll = useCallback(() => {
    activeRef.current = false
    RLOG('INFO', 'conversation_stopped')
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null }
    processorRef.current?.disconnect()
    audioCtxRef.current?.close()
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    audioCtxRef.current = null
    processorRef.current = null
    samplesRef.current = []
    interruptSamplesRef.current = []
    isSpeakingRef.current = false
    processingRef.current = false
    setActive(false)
    setStatus('')
    onConversationChange?.(false)
  }, [onConversationChange])

  const processAudio = useCallback(async (samples: Float32Array[], sampleRate: number) => {
    if (!samples.length) return
    processingRef.current = true

    let totalLen = 0
    for (const s of samples) totalLen += s.length
    const merged = new Float32Array(totalLen)
    let off = 0
    for (const s of samples) {
      merged.set(s, off)
      off += s.length
    }
    samples.length = 0

    const resampled = sampleRate !== ASR_SAMPLE_RATE ? resample(merged, sampleRate, ASR_SAMPLE_RATE) : merged
    let peak = 0
    for (let i = 0; i < resampled.length; i++) {
      const v = Math.abs(resampled[i])
      if (v > peak) peak = v
    }
    const gain = peak > 0.01 ? 0.5 / peak : 1
    const pcm = new Int16Array(resampled.length)
    for (let i = 0; i < resampled.length; i++) {
      pcm[i] = Math.max(-32768, Math.min(32767, resampled[i] * gain * 32768))
    }

    const audioBuf = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)
    setStatus('识别中...')
    const result = await window.electronAPI.transcribe(audioBuf)
    processingRef.current = false

    if (result.text) {
      onResult(result.text)
    } else if (result.error) {
      setStatus(`识别失败: ${result.error}`)
      setTimeout(() => { if (activeRef.current) setStatus('监听中...') }, 1500)
    } else {
      setStatus('没听清，请再说一遍')
      setTimeout(() => { if (activeRef.current) setStatus('监听中...') }, 800)
    }
  }, [onResult])

  const setupAudio = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } })
      streamRef.current = stream

      const audioCtx = new AudioContext()
      audioCtxRef.current = audioCtx
      const actualSampleRate = audioCtx.sampleRate
      const source = audioCtx.createMediaStreamSource(stream)

      const highpass = audioCtx.createBiquadFilter()
      highpass.type = 'highpass'
      highpass.frequency.value = 300
      highpass.Q.value = 0.7

      const lowpass = audioCtx.createBiquadFilter()
      lowpass.type = 'lowpass'
      lowpass.frequency.value = 3000
      lowpass.Q.value = 0.7

      const processor = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1)
      processorRef.current = processor

      samplesRef.current = []
      isSpeakingRef.current = false
      let speechFrames = 0
      const noiseFloorHistory: number[] = []
      let dynamicThreshold = RMS_THRESHOLD
      let lastVadEvent = 0
      if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null }
      setStatus('监听中...')
    RLOG('INFO', 'audio_capture_start', { sampleRate: actualSampleRate })
    RLOG('INFO', 'vad_started', { sampleRate: actualSampleRate })
    RLOG('INFO', 'vad_config', { filter: '300-3000Hz', silenceMs: SILENCE_MS, minSpeechFrames: MIN_SPEAKING_FRAMES })

      processor.onaudioprocess = (e) => {
        if (!activeRef.current) return
        const input = e.inputBuffer.getChannelData(0)

        let sum = 0
        let zcr = 0
        for (let i = 0; i < input.length; i++) {
          sum += input[i] * input[i]
          if (i > 0 && ((input[i - 1] >= 0 && input[i] < 0) || (input[i - 1] < 0 && input[i] >= 0))) {
            zcr++
          }
        }
        const rms = Math.sqrt(sum / input.length)
        const zcrRate = zcr / input.length

        noiseFloorHistory.push(rms)
        if (noiseFloorHistory.length > NOISE_FLOOR_FRAMES) noiseFloorHistory.shift()
        const sorted = [...noiseFloorHistory].sort((a, b) => a - b)
        const noiseFloor = sorted[Math.floor(sorted.length * 0.2)] || 0.001
        dynamicThreshold = Math.max(RMS_THRESHOLD, noiseFloor * RMS_MULTIPLIER)

        const aboveNoise = rms > dynamicThreshold && zcrRate < SPEECH_ZCR_MAX

        const buf = interruptionRef.current ? interruptSamplesRef.current : samplesRef.current
        buf.push(new Float32Array(input))

        if (ttsPlayingRef.current) {
          if (aboveNoise) {
            window.electronAPI.stopSpeaking()
            interruptionRef.current = true
            interruptSamplesRef.current = [new Float32Array(input)]
          }
          return
        }

        if (aboveNoise) {
          speechFrames = Math.min(speechFrames + 1, MIN_SPEAKING_FRAMES + 1)
        } else {
          speechFrames = 0
        }
        const speaking = speechFrames >= MIN_SPEAKING_FRAMES

        if (aboveNoise && !isSpeakingRef.current && Date.now() - lastVadEvent > 5000) {
          lastVadEvent = Date.now()
          RLOG('PERF', 'vad_speech_detected', { rms: Number(rms.toFixed(4)), zcr: Number(zcrRate.toFixed(3)), threshold: Number(dynamicThreshold.toFixed(4)) })
        }
        if (isSpeakingRef.current && !speaking && Date.now() - lastVadEvent > 1000) {
          lastVadEvent = Date.now()
          RLOG('PERF', 'vad_speech_ended', { noiseFloor: Number(noiseFloor.toFixed(4)) })
        }

        if (speaking) {
          if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null }
          setStatus('说话中...')
        } else if (isSpeakingRef.current && !silenceTimerRef.current && !processingRef.current) {
          const captured = interruptionRef.current ? interruptSamplesRef.current : samplesRef.current
          silenceTimerRef.current = setTimeout(() => {
            if (!activeRef.current || processingRef.current) return
            setStatus('识别中...')
            processAudio(captured.splice(0), actualSampleRate)
            interruptionRef.current = false
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

  const toggleConversation = useCallback(() => {
    if (active) {
      cleanupAll()
    } else {
      activeRef.current = true
      setActive(true)
      onConversationChange?.(true)
      setupAudio()
    }
  }, [active, setupAudio, cleanupAll, onConversationChange])

  useEffect(() => {
    if (!ttsPlaying && activeRef.current && !processingRef.current && !interruptionRef.current) {
      samplesRef.current = []
      setTimeout(() => {
        if (activeRef.current && !ttsPlayingRef.current) {
          setStatus('监听中...')
        }
      }, 400)
    }
  }, [ttsPlaying])

  return (
    <div className="voice-input">
      <button
        className={`conversation-button ${active ? 'active' : ''}`}
        onClick={toggleConversation}
        disabled={disabled}
      >
        {active ? '⏹ 结束对话' : '🎤 开始对话'}
      </button>
      {active && <span className="conversation-status">{status}</span>}
      {!active && <span className="hint">点击开始，就像打电话一样</span>}
    </div>
  )
}
