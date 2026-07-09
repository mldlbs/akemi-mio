import { useRef, useState, useCallback, useEffect } from 'react'

const RLOG = (level: string, event: string, meta?: Record<string, unknown>) => {
  const beijing = new Date(Date.now() + 8 * 3600 * 1000)
  const ts = beijing.toISOString().replace('Z', '+08:00')
  console.log(JSON.stringify({ level, timestamp: ts, event, ...(meta || {}) }))
}

interface InspirationEntities {
  characters: string[]
  events: string[]
  emotions: string[]
  plotTurns: string[]
}

interface InspirationResult {
  rawText: string
  entities: InspirationEntities
  guidedPrompt: string
  processingMs: number
  hasContent: boolean
}

interface WritingInspirationCaptureProps {
  onSendInspiration: (text: string) => void
  disabled?: boolean
}

type CaptureState = 'idle' | 'recording' | 'transcribing' | 'processing' | 'result' | 'error'

const BUFFER_SIZE = 4096
const ASR_SAMPLE_RATE = 16000
const MAX_RECORD_SECONDS = 30
const MIN_RECORD_SAMPLES = 8000

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

export function WritingInspirationCapture({ onSendInspiration, disabled }: WritingInspirationCaptureProps) {
  const [state, setState] = useState<CaptureState>('idle')
  const [result, setResult] = useState<InspirationResult | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [recordDuration, setRecordDuration] = useState(0)
  const [showPanel, setShowPanel] = useState(false)

  const stateRef = useRef(state)
  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const samplesRef = useRef<Float32Array[]>([])
  const sampleRateRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const durRef = useRef(0)

  // Sync stateRef whenever state changes
  useEffect(() => { stateRef.current = state }, [state])

  // Cleanup audio resources
  const closeAudio = useCallback(() => {
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current)
      maxTimerRef.current = null
    }
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
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
    setRecordDuration(0)
    durRef.current = 0
  }, [])

  // Process accumulated samples through ASR
  const processRecording = useCallback(async () => {
    const samples = samplesRef.current
    const sr = sampleRateRef.current
    if (!samples.length || !sr) {
      setState('error')
      setErrorMsg('无录音数据')
      closeAudio()
      return
    }

    setState('transcribing')

    // Merge all sample chunks
    let totalLen = 0
    for (const s of samples) totalLen += s.length
    const merged = new Float32Array(totalLen)
    let off = 0
    for (const s of samples) {
      merged.set(s, off)
      off += s.length
    }
    samples.length = 0

    // Resample to 16kHz
    let resampled = sr !== ASR_SAMPLE_RATE ? resample(merged, sr, ASR_SAMPLE_RATE) : merged
    if (resampled.length < MIN_RECORD_SAMPLES) {
      setState('error')
      setErrorMsg('录音太短，请多说一些')
      closeAudio()
      return
    }

    // Normalize gain and convert to Int16 PCM
    let peak = 0
    for (let i = 0; i < resampled.length; i++) {
      const v = Math.abs(resampled[i])
      if (v > peak) peak = v
    }
    const gain = peak > 0.001 ? Math.min(0.6 / peak, 20) : 1
    const pcm = new Int16Array(resampled.length)
    for (let i = 0; i < resampled.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, resampled[i] * gain * 32768))

    const audioBuf = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)

    try {
      // Step 1: ASR transcribe
      const transcribeResult = await window.electronAPI.transcribe(audioBuf)
      const transcribedText = transcribeResult.text?.trim()

      if (!transcribedText) {
        setState('error')
        setErrorMsg(transcribeResult.error || '未能识别语音内容')
        RLOG('WARN', 'inspiration_asr_empty', { error: transcribeResult.error })
        closeAudio()
        return
      }

      RLOG('INFO', 'inspiration_asr_success', { text: transcribedText.slice(0, 80) })

      // Step 2: NER extraction
      setState('processing')
      const inspiration = await window.electronAPI.processWritingInspiration(transcribedText)

      setResult(inspiration)
      setState('result')
      setShowPanel(true)
    } catch (err) {
      RLOG('ERROR', 'inspiration_process_failed', { error: String(err) })
      setState('error')
      setErrorMsg(String(err))
    } finally {
      closeAudio()
    }
  }, [closeAudio])

  // Start recording
  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      streamRef.current = stream
      const audioCtx = new AudioContext()
      audioCtxRef.current = audioCtx
      const sr = audioCtx.sampleRate
      sampleRateRef.current = sr
      const source = audioCtx.createMediaStreamSource(stream)

      const processor = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1)
      processorRef.current = processor
      samplesRef.current = []

      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0)
        samplesRef.current.push(new Float32Array(input))
      }

      source.connect(processor)
      processor.connect(audioCtx.destination)

      // Duration tracking
      durRef.current = 0
      timerRef.current = setInterval(() => {
        durRef.current++
        setRecordDuration(durRef.current)
      }, 1000)

      // Max recording timeout
      maxTimerRef.current = setTimeout(() => {
        RLOG('INFO', 'inspiration_max_duration_reached', { seconds: MAX_RECORD_SECONDS })
        if (stateRef.current === 'recording') {
          stopRecording()
        }
      }, MAX_RECORD_SECONDS * 1000)

      setState('recording')
      RLOG('INFO', 'inspiration_recording_started', { sampleRate: sr })
    } catch (err) {
      RLOG('ERROR', 'inspiration_mic_failed', { error: String(err) })
      setState('error')
      setErrorMsg('麦克风不可用')
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Stop recording
  const stopRecording = useCallback(() => {
    if (stateRef.current !== 'recording') return
    RLOG('INFO', 'inspiration_recording_stopped', { duration: durRef.current })
    processRecording()
  }, [processRecording])

  // Cancel/dismiss
  const dismissPanel = useCallback(() => {
    setShowPanel(false)
    setResult(null)
    setState('idle')
    setErrorMsg('')
  }, [])

  // Send inspiration prompt
  const handleGenerate = useCallback(() => {
    if (result?.guidedPrompt) {
      onSendInspiration(result.guidedPrompt)
    }
    dismissPanel()
  }, [result, onSendInspiration, dismissPanel])

  // Clean up on unmount
  useEffect(() => {
    return () => {
      closeAudio()
    }
  }, [closeAudio])

  // Auto-dismiss error after a few seconds
  useEffect(() => {
    if (state === 'error') {
      const t = setTimeout(() => {
        setState('idle')
        setErrorMsg('')
      }, 4000)
      return () => clearTimeout(t)
    }
  }, [state])

  const handleToggle = useCallback(() => {
    if (disabled) return

    const cur = stateRef.current
    if (cur === 'recording') {
      stopRecording()
    } else if (cur === 'idle' || cur === 'error') {
      setErrorMsg('')
      startRecording()
    }
  }, [disabled, stopRecording, startRecording])

  const isBusy = state === 'transcribing' || state === 'processing'

  return (
    <>
      <div className={`writing-inspiration-btn${state === 'recording' ? ' recording' : ''}${isBusy ? ' busy' : ''}`}>
        <button
          className={`btn-inspiration${state === 'recording' ? ' active' : ''}`}
          onClick={handleToggle}
          disabled={disabled || isBusy}
          title={state === 'recording' ? '停止录音' : '语音灵感'}
        >
          {isBusy ? (
            <i className="ri-loader-4-line ri-spin" />
          ) : state === 'recording' ? (
            <i className="ri-stop-fill" />
          ) : (
            <i className="ri-pencil-line" />
          )}
        </button>
        {state === 'recording' && (
          <span className="inspiration-rec-dot">
            <span className="rec-dot-pulse" />
            {recordDuration}s
          </span>
        )}
        {state === 'error' && (
          <span className="inspiration-error-tip">{errorMsg}</span>
        )}
      </div>

      {/* 结果面板 */}
      {showPanel && result && (
        <div className="inspiration-panel-overlay" onClick={dismissPanel}>
          <div className="inspiration-panel" onClick={(e) => e.stopPropagation()}>
            <div className="inspiration-panel-header">
              <span className="inspiration-panel-title">
                <i className="ri-pencil-line" /> 语音灵感
              </span>
              <button className="inspiration-panel-close" onClick={dismissPanel}>
                <i className="ri-close-line" />
              </button>
            </div>

            <div className="inspiration-panel-body">
              {/* 原始文本 */}
              <div className="inspiration-section">
                <span className="inspiration-section-label">
                  <i className="ri-file-text-line" /> 口述内容
                </span>
                <div className="inspiration-raw-text">{result.rawText}</div>
              </div>

              {/* 角色 */}
              {result.entities.characters.length > 0 && (
                <div className="inspiration-section">
                  <span className="inspiration-section-label">
                    <i className="ri-group-line" /> 角色
                  </span>
                  <div className="inspiration-tags">
                    {result.entities.characters.map((c, i) => (
                      <span key={i} className="inspiration-tag tag-character">{c}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* 事件 */}
              {result.entities.events.length > 0 && (
                <div className="inspiration-section">
                  <span className="inspiration-section-label">
                    <i className="ri-flashlight-line" /> 事件
                  </span>
                  <div className="inspiration-tags">
                    {result.entities.events.map((e, i) => (
                      <span key={i} className="inspiration-tag tag-event">{e}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* 情绪 */}
              {result.entities.emotions.length > 0 && (
                <div className="inspiration-section">
                  <span className="inspiration-section-label">
                    <i className="ri-heart-line" /> 情绪基调
                  </span>
                  <div className="inspiration-tags">
                    {result.entities.emotions.map((em, i) => (
                      <span key={i} className="inspiration-tag tag-emotion">{em}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* 剧情转折 */}
              {result.entities.plotTurns.length > 0 && (
                <div className="inspiration-section">
                  <span className="inspiration-section-label">
                    <i className="ri-shuffle-line" /> 剧情方向
                  </span>
                  <div className="inspiration-tags">
                    {result.entities.plotTurns.map((pt, i) => (
                      <span key={i} className="inspiration-tag tag-plot-turn">{pt}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* 引导 prompt 预览 */}
              {result.guidedPrompt && (
                <div className="inspiration-section">
                  <span className="inspiration-section-label">
                    <i className="ri-question-answer-line" /> 续写引导
                  </span>
                  <div className="inspiration-guided-preview">{result.guidedPrompt}</div>
                </div>
              )}
            </div>

            <div className="inspiration-panel-footer">
              <span className="inspiration-meta">
                处理耗时: {(result.processingMs / 1000).toFixed(1)}s
              </span>
              <div className="inspiration-footer-actions">
                <button className="inspiration-btn-secondary" onClick={dismissPanel}>
                  取消
                </button>
                <button className="inspiration-btn-primary" onClick={handleGenerate}>
                  <i className="ri-send-plane-2-fill" /> 生成续写
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
