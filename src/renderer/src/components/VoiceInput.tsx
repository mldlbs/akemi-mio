import { useRef, useState, useCallback } from 'react'

interface VoiceInputProps {
  onResult: (text: string) => void
  disabled?: boolean
  onConversationChange?: (active: boolean) => void
}

const SILENCE_MS = 1500
const VAD_INTERVAL_MS = 200

export function VoiceInput({ onResult, disabled, onConversationChange }: VoiceInputProps) {
  const [active, setActive] = useState(false)
  const [status, setStatus] = useState('')
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isSpeakingRef = useRef(false)
  const activeRef = useRef(false)
  const processingRef = useRef(false)
  const vadTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const processChunk = useCallback(async () => {
    if (processingRef.current) return
    processingRef.current = true
    const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
    chunksRef.current = []
    const arrayBuffer = await blob.arrayBuffer()
    const result = await window.electronAPI.transcribe(arrayBuffer)
    if (result.text) {
      onResult(result.text)
    }
    processingRef.current = false
  }, [onResult])

  const stopConversation = useCallback(() => {
    activeRef.current = false
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current)
      silenceTimerRef.current = null
    }
    if (vadTimerRef.current) {
      clearInterval(vadTimerRef.current)
      vadTimerRef.current = null
    }
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop()
    }
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    audioCtxRef.current?.close()
    audioCtxRef.current = null
    recorderRef.current = null
    analyserRef.current = null
    chunksRef.current = []
    isSpeakingRef.current = false
    processingRef.current = false
    setActive(false)
    setStatus('')
    onConversationChange?.(false)
  }, [onConversationChange])

  const startListening = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const audioCtx = new AudioContext()
      audioCtxRef.current = audioCtx
      const source = audioCtx.createMediaStreamSource(stream)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      analyserRef.current = analyser

      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      recorderRef.current = recorder

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      recorder.start(200)
      setStatus('监听中...')

      const buf = new Uint8Array(analyser.fftSize)
      vadTimerRef.current = setInterval(() => {
        if (!activeRef.current) return

        analyser.getByteTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) {
          const v = buf[i] - 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / buf.length)
        const speaking = rms > 8

        if (speaking) {
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current)
            silenceTimerRef.current = null
          }
          setStatus('说话中...')
        } else if (isSpeakingRef.current && !silenceTimerRef.current) {
          silenceTimerRef.current = setTimeout(() => {
            if (!activeRef.current) return
            recorder.stop()
            processChunk().then(() => {
              if (activeRef.current) {
                chunksRef.current = []
                const r = new MediaRecorder(stream, { mimeType: 'audio/webm' })
                recorderRef.current = r
                r.ondataavailable = recorder.ondataavailable
                r.start(200)
                setStatus('监听中...')
              }
            })
          }, SILENCE_MS)
          setStatus('等待结尾...')
        }

        isSpeakingRef.current = speaking
      }, VAD_INTERVAL_MS)
    } catch (err) {
      console.error('VAD start failed:', err)
      stopConversation()
    }
  }, [processChunk, stopConversation])

  const toggleConversation = useCallback(() => {
    if (active) {
      stopConversation()
    } else {
      activeRef.current = true
      setActive(true)
      onConversationChange?.(true)
      startListening()
    }
  }, [active, startListening, stopConversation, onConversationChange])

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
