import { useCallback, useEffect, useRef, useState } from 'react'

interface VoiceInputProps {
  onResult: (text: string) => void
  disabled?: boolean
}

export function VoiceInput({ onResult, disabled }: VoiceInputProps) {
  const [recording, setRecording] = useState(false)
  const mediaRecorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])

  const handleKeyDown = useCallback(async (e: KeyboardEvent) => {
    if (e.code !== 'F2' || recording || disabled) return
    e.preventDefault()
    chunks.current = []

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      mediaRecorder.current = recorder

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.current.push(e.data)
      }

      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        const blob = new Blob(chunks.current, { type: 'audio/webm' })
        const arrayBuffer = await blob.arrayBuffer()
        const float32 = new Float32Array(arrayBuffer)

        const result = await window.electronAPI.transcribe(float32)
        if (result.text) onResult(result.text)
      }

      recorder.start()
      setRecording(true)
    } catch {
      setRecording(false)
    }
  }, [recording, disabled, onResult])

  const handleKeyUp = useCallback((e: KeyboardEvent) => {
    if (e.code !== 'F2') return
    e.preventDefault()
    if (mediaRecorder.current?.state === 'recording') {
      mediaRecorder.current.stop()
      setRecording(false)
    }
  }, [])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [handleKeyDown, handleKeyUp])

  return (
    <div className={`voice-input ${recording ? 'recording' : ''}`}>
      <span className="hint">按住 F2 说话，松开发送</span>
    </div>
  )
}
