/**
 * VoiceContinuationCapture — 语音引导的剧情续写 UI（含情感氛围感知）
 *
 * 流程：
 * 1. 用户点击"开始录音" → 打开麦克风
 * 2. 30 秒录音超时（或用户手动停止），同时采集 PCM 样本
 * 3. ASR 转写语音文本 + 音频特征提取 → 氛围映射
 * 4. 发送到主进程：合并语音文本 + 氛围参数 + 上下文 → 调用 LLM 续写
 * 5. 展示生成结果及情感氛围分析，用户确认后发送到对话
 */
import { useRef, useState, useCallback, useEffect } from 'react'

const RLOG = (level: string, event: string, meta?: Record<string, unknown>) => {
  const beijing = new Date(Date.now() + 8 * 3600 * 1000)
  const ts = beijing.toISOString().replace('Z', '+08:00')
  console.log(JSON.stringify({ level, timestamp: ts, event, ...(meta || {}) }))
}

// ── 类型 ──

interface ContinuationResult {
  success: boolean
  chapterTitle: string
  content: string
  sceneId: string | null
  userVoiceText: string
  atmosphere?: {
    tension: number
    joy: number
    sadness: number
    calmness: number
    mystery: number
    romance: number
    dominantLabel: string
    confidence: number
    description: string
  } | null
  error?: string
  processingMs: number
}

interface ContinuationInitData {
  storyName: string
  chapterNum: number
  storyId: string | null
  previousChapter: { title: string; content: string } | null
  totalChapters: number
  readerExpectations: string
}

interface AudioAtmosphere {
  tension: number
  joy: number
  sadness: number
  calmness: number
  mystery: number
  romance: number
  dominantLabel: string
  confidence: number
  description: string
}

interface VoiceContinuationCaptureProps {
  storyName: string
  chapterNum: number
  onSendContinuation: (content: string, title: string) => void
  onClose?: () => void
  disabled?: boolean
}

type CaptureState = 'idle' | 'initializing' | 'ready' | 'recording' | 'transcribing' | 'analyzing' | 'generating' | 'result' | 'error'

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

/** 将 Float32 PCM 转为 Int16 PCM ArrayBuffer */
function float32ToInt16Buffer(float32: Float32Array): ArrayBuffer {
  let peak = 0
  for (let i = 0; i < float32.length; i++) {
    const v = Math.abs(float32[i])
    if (v > peak) peak = v
  }
  const gain = peak > 0.001 ? Math.min(0.6 / peak, 20) : 1
  const pcm = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    pcm[i] = Math.max(-32768, Math.min(32767, float32[i] * gain * 32768))
  }
  return pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)
}

/** 氛围标签对应的 CSS 类名和图标 */
const ATMOSPHERE_META: Record<string, { icon: string; color: string }> = {
  tension: { icon: 'ri-flashlight-line', color: '#e74c3c' },
  joy: { icon: 'ri-emotion-happy-line', color: '#f39c12' },
  sadness: { icon: 'ri-emotion-sad-line', color: '#5b7db1' },
  calmness: { icon: 'ri-water-flash-line', color: '#3498db' },
  mystery: { icon: 'ri-moon-line', color: '#9b59b6' },
  romance: { icon: 'ri-heart-3-line', color: '#e91e63' },
}

/** 氛围维度的中文标签 */
const ATMOSPHERE_LABELS: Record<string, string> = {
  tension: '紧张',
  joy: '欢乐',
  sadness: '悲伤',
  calmness: '平静',
  mystery: '神秘',
  romance: '浪漫',
}

export function VoiceContinuationCapture({ storyName, chapterNum, onSendContinuation, onClose, disabled }: VoiceContinuationCaptureProps) {
  const [state, setState] = useState<CaptureState>('idle')
  const [initData, setInitData] = useState<ContinuationInitData | null>(null)
  const [result, setResult] = useState<ContinuationResult | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [recordDuration, setRecordDuration] = useState(0)
  const [voiceText, setVoiceText] = useState('')
  const [atmosphere, setAtmosphere] = useState<AudioAtmosphere | null>(null)
  const [analysisError, setAnalysisError] = useState<string | null>(null)

  const stateRef = useRef(state)
  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const samplesRef = useRef<Float32Array[]>([])
  const sampleRateRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const durRef = useRef(0)
  const voiceRef = useRef('')
  const atmosphereRef = useRef<AudioAtmosphere | null>(null)

  // Sync stateRef
  useEffect(() => {
    stateRef.current = state
  }, [state])

  // Initialize continuation context on mount
  useEffect(() => {
    if (state === 'idle') {
      setState('initializing')
      ;(async () => {
        try {
          const data = await window.electronAPI.initVoiceContinuation({ storyName, chapterNum })
          setInitData(data)
          setState('ready')
          RLOG('INFO', 'continuation_init_ok', {
            storyName,
            chapterNum,
            storyId: data.storyId,
            hasPrevious: !!data.previousChapter,
            totalChapters: data.totalChapters,
          })
        } catch (err) {
          RLOG('ERROR', 'continuation_init_failed', { error: String(err) })
          setErrorMsg('初始化续写上下文失败')
          setState('error')
        }
      })()
    }
  }, [])

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

  /**
   * 分析音频特征 → 氛围映射（在 main 进程完成）
   */
  const analyzeAudioAtmosphere = useCallback(async (pcmBuffer: ArrayBuffer): Promise<AudioAtmosphere | null> => {
    try {
      const analysisResult = await window.electronAPI.analyzeAudioFeatures(pcmBuffer)
      if (analysisResult.success && analysisResult.atmosphere) {
        RLOG('INFO', 'atmosphere_analysis_ok', {
          dominant: analysisResult.atmosphere.dominantLabel,
          confidence: analysisResult.atmosphere.confidence,
          tension: analysisResult.atmosphere.tension.toFixed(2),
          joy: analysisResult.atmosphere.joy.toFixed(2),
        })
        return analysisResult.atmosphere as AudioAtmosphere
      }
      RLOG('WARN', 'atmosphere_analysis_failed', { error: analysisResult.error })
      return null
    } catch (err) {
      RLOG('ERROR', 'atmosphere_analysis_crash', { error: String(err) })
      return null
    }
  }, [])

  // Process accumulated samples through ASR + Audio Feature Analysis
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
    // 清空 samples 引用（不再需要保留原始块）
    samples.length = 0

    // Resample to 16kHz
    const resampled = sr !== ASR_SAMPLE_RATE ? resample(merged, sr, ASR_SAMPLE_RATE) : merged
    if (resampled.length < MIN_RECORD_SAMPLES) {
      // If too short, treat as silence (use empty voice text)
      RLOG('INFO', 'continuation_recording_too_short', { samples: resampled.length })
      voiceRef.current = ''
      setVoiceText('')
      atmosphereRef.current = null
      proceedToGenerate('', null)
      closeAudio()
      return
    }

    // Normalize and convert to Int16 PCM
    const audioBuf = float32ToInt16Buffer(resampled)

    // ── Step 1: ASR transcribe ──
    let transcribedText = ''
    try {
      const transcribeResult = await window.electronAPI.transcribe(audioBuf)
      transcribedText = transcribeResult.text?.trim() || ''

      if (transcribedText) {
        voiceRef.current = transcribedText
        setVoiceText(transcribedText)
        RLOG('INFO', 'continuation_asr_ok', { text: transcribedText.slice(0, 100) })
      } else {
        voiceRef.current = ''
        setVoiceText('')
        RLOG('INFO', 'continuation_asr_empty', { error: transcribeResult.error })
      }
    } catch (err) {
      RLOG('ERROR', 'continuation_asr_failed', { error: String(err) })
      voiceRef.current = ''
      setVoiceText('')
    }

    // ── Step 2: Audio Feature Analysis → Atmosphere ──
    setState('analyzing')
    let atmo: AudioAtmosphere | null = null
    try {
      atmo = await analyzeAudioAtmosphere(audioBuf)
      atmosphereRef.current = atmo
      setAtmosphere(atmo)
      if (atmo) {
        setAnalysisError(null)
      }
    } catch (err) {
      RLOG('ERROR', 'atmosphere_analysis_err', { error: String(err) })
      setAnalysisError('氛围分析失败（不影响续写）')
      atmosphereRef.current = null
    }

    // ── Step 3: Generate continuation with atmosphere ──
    proceedToGenerate(voiceRef.current, atmosphereRef.current)
    closeAudio()
  }, [closeAudio, analyzeAudioAtmosphere])

  // Generate continuation via main process
  const proceedToGenerate = useCallback(
    async (text: string, atmo: AudioAtmosphere | null) => {
      setState('generating')
      try {
        RLOG('INFO', 'continuation_generating', {
          storyName,
          chapterNum,
          hasVoice: text.length > 0,
          hasAtmosphere: !!atmo,
          atmoDominant: atmo?.dominantLabel || 'none',
        })
        const genResult = await window.electronAPI.executeVoiceContinuation({
          storyName,
          chapterNum,
          userVoiceText: text,
          atmosphere: atmo,
        })
        setResult(genResult)
        setState('result')
        RLOG('INFO', 'continuation_generated', {
          success: genResult.success,
          contentLength: genResult.content.length,
          tookMs: genResult.processingMs,
        })
      } catch (err) {
        RLOG('ERROR', 'continuation_generate_failed', { error: String(err) })
        setState('error')
        setErrorMsg(String(err))
      }
    },
    [storyName, chapterNum],
  )

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
      voiceRef.current = ''
      atmosphereRef.current = null
      setAtmosphere(null)
      setAnalysisError(null)

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

      // Max recording timeout (30 seconds)
      maxTimerRef.current = setTimeout(() => {
        RLOG('INFO', 'continuation_max_duration_reached', { seconds: MAX_RECORD_SECONDS })
        if (stateRef.current === 'recording') {
          stopRecording()
        }
      }, MAX_RECORD_SECONDS * 1000)

      setState('recording')
      RLOG('INFO', 'continuation_recording_started', { sampleRate: sr })
    } catch (err) {
      RLOG('ERROR', 'continuation_mic_failed', { error: String(err) })
      setState('error')
      setErrorMsg('麦克风不可用，请检查权限设置')
    }
  }, [])

  // Stop recording (manual or auto)
  const stopRecording = useCallback(() => {
    if (stateRef.current !== 'recording') return
    RLOG('INFO', 'continuation_recording_stopped', { duration: durRef.current })
    processRecording()
  }, [processRecording])

  // Handle toggle button click
  const handleToggle = useCallback(() => {
    if (disabled) return

    const cur = stateRef.current
    if (cur === 'recording') {
      stopRecording()
    } else if (cur === 'ready') {
      setErrorMsg('')
      startRecording()
    }
  }, [disabled, stopRecording, startRecording])

  // Send generated content to chat
  const handleSend = useCallback(() => {
    if (result?.content) {
      onSendContinuation(result.content, result.chapterTitle)
    }
    if (onClose) onClose()
  }, [result, onSendContinuation, onClose])

  // Close/dismiss
  const handleClose = useCallback(() => {
    closeAudio()
    if (onClose) onClose()
  }, [closeAudio, onClose])

  // Retry from error
  const handleRetry = useCallback(() => {
    setErrorMsg('')
    setResult(null)
    setAtmosphere(null)
    setAnalysisError(null)
    setState('ready')
  }, [])

  // Skip recording and use default prompt
  const handleSkipVoice = useCallback(() => {
    if (stateRef.current !== 'ready') return
    RLOG('INFO', 'continuation_skip_voice', { storyName, chapterNum })
    voiceRef.current = ''
    setVoiceText('')
    atmosphereRef.current = null
    proceedToGenerate('', null)
  }, [storyName, chapterNum, proceedToGenerate])

  // Auto-dismiss error
  useEffect(() => {
    if (state === 'error') {
      const t = setTimeout(() => {
        if (stateRef.current === 'error') {
          setState('ready')
          setErrorMsg('')
        }
      }, 5000)
      return () => clearTimeout(t)
    }
  }, [state])

  // Clean up on unmount
  useEffect(() => {
    return () => {
      closeAudio()
    }
  }, [closeAudio])

  const isBusy = state === 'initializing' || state === 'transcribing' || state === 'analyzing' || state === 'generating'
  const showPanel = state !== 'idle'

  if (!showPanel) return null

  return (
    <div className="inspiration-panel-overlay" onClick={handleClose}>
      <div className="inspiration-panel" onClick={(e) => e.stopPropagation()}>
        {/* ── Header ── */}
        <div className="inspiration-panel-header">
          <span className="inspiration-panel-title">
            <i className="ri-mic-line" /> 语音续写 · 情感氛围
          </span>
          <button className="inspiration-panel-close" onClick={handleClose}>
            <i className="ri-close-line" />
          </button>
        </div>

        {/* ── Body ── */}
        <div className="inspiration-panel-body">
          {/* Story context info */}
          <div className="continuation-context-info">
            <span className="continuation-context-badge">
              《{storyName}》 第{chapterNum}章
            </span>
            {initData && (
              <span className="continuation-context-meta">
                已存在 {initData.totalChapters} 章{initData.previousChapter && ` · 前章: ${initData.previousChapter.title}`}
              </span>
            )}
          </div>

          {/* Initializing */}
          {state === 'initializing' && (
            <div className="continuation-status">
              <i className="ri-loader-4-line ri-spin" />
              <span>正在获取故事上下文...</span>
            </div>
          )}

          {/* Ready — waiting for user to start recording */}
          {state === 'ready' && (
            <div className="continuation-ready">
              <div className="continuation-ready-icon">
                <i className="ri-mic-line" />
              </div>
              <p className="continuation-ready-text">请说出你对第{chapterNum}章的剧情期望或情感诉求</p>
              <p className="continuation-ready-hint">
                你可以描述希望加入的转折、情绪、场景等。系统会自动从你的语音中提取情感氛围。最多录音 {MAX_RECORD_SECONDS} 秒。
              </p>
              <div className="continuation-ready-actions">
                <button className="inspiration-btn-primary" onClick={handleToggle} disabled={disabled}>
                  <i className="ri-mic-fill" /> 开始录音
                </button>
                <button className="inspiration-btn-secondary" onClick={handleSkipVoice} disabled={disabled}>
                  跳过语音，使用默认提示
                </button>
              </div>
            </div>
          )}

          {/* Recording */}
          {state === 'recording' && (
            <div className="continuation-recording">
              <div className="continuation-recording-indicator">
                <span className="rec-dot-pulse" />
                <span className="continuation-recording-text">录音中...</span>
              </div>
              <div className="continuation-timer">
                {recordDuration}s / {MAX_RECORD_SECONDS}s
              </div>
              <button className="inspiration-btn-primary" onClick={stopRecording}>
                <i className="ri-stop-fill" /> 停止录音
              </button>
            </div>
          )}

          {/* Transcribing */}
          {state === 'transcribing' && (
            <div className="continuation-status">
              <i className="ri-loader-4-line ri-spin" />
              <span>正在识别语音...</span>
            </div>
          )}

          {/* Analyzing — new state for atmosphere analysis */}
          {state === 'analyzing' && (
            <div className="continuation-status">
              <i className="ri-loader-4-line ri-spin" />
              <span>正在分析语音情感氛围...</span>
              {voiceText && (
                <div className="continuation-voice-text-preview">
                  <div className="inspiration-section-label">
                    <i className="ri-chat-voice-line" /> 语音内容
                  </div>
                  <div className="inspiration-raw-text">{voiceText}</div>
                </div>
              )}
            </div>
          )}

          {/* Generating */}
          {state === 'generating' && (
            <div className="continuation-status">
              <i className="ri-loader-4-line ri-spin" />
              <span>正在生成续写内容...</span>
              {voiceText && (
                <div className="continuation-voice-text-preview">
                  <div className="inspiration-section-label">
                    <i className="ri-chat-voice-line" /> 语音需求
                  </div>
                  <div className="inspiration-raw-text">{voiceText}</div>
                </div>
              )}
              {/* 显示检测到的氛围 */}
              {atmosphere && atmosphere.confidence > 0.2 && (
                <div className="continuation-atmosphere-preview" style={{ marginTop: 8 }}>
                  <div className="inspiration-section-label">
                    <i className="ri-magic-line" /> 检测到的情感氛围
                  </div>
                  <div
                    className="continuation-atmo-badge"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '4px 10px',
                      borderRadius: 12,
                      background: (ATMOSPHERE_META[atmosphere.dominantLabel]?.color || '#888') + '22',
                      color: ATMOSPHERE_META[atmosphere.dominantLabel]?.color || '#888',
                      fontSize: 13,
                      marginTop: 4,
                    }}
                  >
                    <i className={ATMOSPHERE_META[atmosphere.dominantLabel]?.icon || 'ri-empathize-line'} />
                    {atmosphere.description}
                  </div>
                </div>
              )}
              {analysisError && <div style={{ color: '#e74c3c', fontSize: 12, marginTop: 4 }}>{analysisError}</div>}
            </div>
          )}

          {/* Error */}
          {state === 'error' && (
            <div className="continuation-error">
              <i className="ri-error-warning-line" />
              <p>{errorMsg}</p>
              <button className="inspiration-btn-secondary" onClick={handleRetry}>
                重试
              </button>
            </div>
          )}

          {/* Result */}
          {state === 'result' && result && (
            <div className="continuation-result">
              {result.success ? (
                <>
                  {/* Voice text if any */}
                  {result.userVoiceText && (
                    <div className="inspiration-section">
                      <span className="inspiration-section-label">
                        <i className="ri-chat-voice-line" /> 语音需求
                      </span>
                      <div className="inspiration-raw-text">{result.userVoiceText}</div>
                    </div>
                  )}

                  {/* Atmosphere visualization — NEW */}
                  {result.atmosphere && result.atmosphere.confidence > 0.2 && (
                    <div className="inspiration-section">
                      <span className="inspiration-section-label">
                        <i className="ri-magic-line" /> 语音情感氛围分析
                      </span>
                      <div className="atmosphere-bars" style={{ marginTop: 8 }}>
                        {(['tension', 'joy', 'sadness', 'calmness', 'mystery', 'romance'] as const).map((key) => {
                          const value = result.atmosphere![key]
                          const meta = ATMOSPHERE_META[key]
                          return (
                            <div
                              key={key}
                              className="atmosphere-bar-row"
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                marginBottom: 4,
                              }}
                            >
                              <i className={meta.icon} style={{ color: meta.color, width: 16, fontSize: 14 }} />
                              <span style={{ width: 40, fontSize: 12, color: '#888' }}>{ATMOSPHERE_LABELS[key]}</span>
                              <div
                                className="atmosphere-bar-track"
                                style={{
                                  flex: 1,
                                  height: 8,
                                  background: '#333',
                                  borderRadius: 4,
                                  overflow: 'hidden',
                                }}
                              >
                                <div
                                  className="atmosphere-bar-fill"
                                  style={{
                                    width: `${Math.round(value * 100)}%`,
                                    height: '100%',
                                    background: meta.color,
                                    borderRadius: 4,
                                    transition: 'width 0.3s ease',
                                  }}
                                />
                              </div>
                              <span style={{ width: 32, fontSize: 11, color: '#aaa', textAlign: 'right' }}>{Math.round(value * 100)}%</span>
                            </div>
                          )
                        })}
                      </div>
                      <div
                        style={{
                          marginTop: 6,
                          fontSize: 12,
                          color: '#aaa',
                          fontStyle: 'italic',
                        }}
                      >
                        主导氛围：{result.atmosphere.description}
                        （置信度: {(result.atmosphere.confidence * 100).toFixed(0)}%）
                      </div>
                    </div>
                  )}

                  {/* Generated title */}
                  <div className="inspiration-section">
                    <span className="inspiration-section-label">
                      <i className="ri-quill-pen-line" /> 生成章节
                    </span>
                    <div className="continuation-result-title">{result.chapterTitle}</div>
                  </div>

                  {/* Generated content (preview) */}
                  <div className="inspiration-section">
                    <span className="inspiration-section-label">
                      <i className="ri-file-text-line" /> 内容预览
                    </span>
                    <div className="continuation-result-content">
                      {result.content.slice(0, 800)}
                      {result.content.length > 800 && (
                        <span className="continuation-content-truncate">...（共 {result.content.length} 字）</span>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <div className="continuation-error">
                  <i className="ri-error-warning-line" />
                  <p>{result.error || '生成失败'}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="inspiration-panel-footer">
          <span className="inspiration-meta">
            {result && `处理耗时: ${(result.processingMs / 1000).toFixed(1)}s`}
            {initData && !result && `故事: 《${storyName}》`}
          </span>
          <div className="inspiration-footer-actions">
            {state !== 'recording' && state !== 'initializing' && !isBusy && (
              <button className="inspiration-btn-secondary" onClick={handleClose}>
                取消
              </button>
            )}
            {state === 'result' && result?.success && (
              <button className="inspiration-btn-primary" onClick={handleSend}>
                <i className="ri-send-plane-2-fill" /> 发送到对话
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
