import { useRef, useState } from 'react'

interface VoiceInputProps {
  onResult: (text: string) => void
  onStateChange?: (state: 'idle' | 'recording' | 'transcribing') => void
  disabled?: boolean
}

export function VoiceInput({ onResult, onStateChange, disabled }: VoiceInputProps) {
  const [state, setState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const mediaRecorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)

  const updateState = (s: 'idle' | 'recording' | 'transcribing') => {
    setState(s)
    onStateChange?.(s)
  }

  const stopRecording = () => {
    if (mediaRecorder.current?.state === 'recording') {
      mediaRecorder.current.stop()
    }
  }

  const startRecording = async () => {
    chunks.current = []
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      mediaRecorder.current = recorder

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.current.push(e.data)
      }

      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        streamRef.current = null
        updateState('transcribing')

        const blob = new Blob(chunks.current, { type: 'audio/webm' })
        const arrayBuffer = await blob.arrayBuffer()
        const result = await window.electronAPI.transcribe(arrayBuffer)
        if (result.text) {
          onResult(result.text)
        }
        updateState('idle')
      }

      recorder.start()
      updateState('recording')
    } catch {
      updateState('idle')
    }
  }

  const toggle = () => {
    if (state === 'recording') {
      stopRecording()
    } else if (state === 'idle') {
      startRecording()
    }
  }

  return (
    <div className={`voice-input ${state}`}>
      <button
        className="mic-button"
        onClick={toggle}
        disabled={disabled || state === 'transcribing'}
        title={state === 'recording' ? '点击停止录音' : '点击开始录音'}
      >
        {state === 'idle' && '🎤 点击说话'}
        {state === 'recording' && '⏹ 停止录音'}
        {state === 'transcribing' && '⏳ 识别中...'}
      </button>
      {state === 'idle' && !disabled && <span className="hint">点击麦克风开始语音输入</span>}
      {state === 'recording' && <span className="hint recording-hint">正在录音，点击停止</span>}
    </div>
  )
}
