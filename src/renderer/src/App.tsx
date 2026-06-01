import { useState, useEffect, useCallback, useRef } from 'react'
import { VoiceInput } from './components/VoiceInput'
import { StatusBar } from './components/StatusBar'
import { WaveRibbon } from './components/WaveRibbon'
import { playTTS, playTTSBuffer, stopTTS, onTTSStart, onTTSError } from './components/audioShared'
import './App.css'

function App() {
  const [active, setActive] = useState(false)
  const [ttsPlaying, setTtsPlaying] = useState(false)
  const [text, setText] = useState('')
  const [transcribed, setTranscribed] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [displayText, setDisplayText] = useState('')
  const [overflow, setOverflow] = useState(false)
  const fadeTimer = useRef<ReturnType<typeof setTimeout>>()
  const revealTimer = useRef<ReturnType<typeof setInterval>>()
  const textRef = useRef('')
  const marqueeRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = marqueeRef.current
    if (el) setOverflow(el.scrollWidth > el.clientWidth)
  }, [transcribed])

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver(() => {
      const el = marqueeRef.current
      if (el) setOverflow(el.scrollWidth > el.clientWidth)
    })
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  useEffect(() => { textRef.current = text }, [text])

  useEffect(() => {
    onTTSStart((duration) => {
      const t = textRef.current
      if (!t) return
      if (revealTimer.current) clearInterval(revealTimer.current)
      setDisplayText('')
      const totalMs = duration * 1000
      const intervalMs = Math.max(20, totalMs / t.length)
      let i = 0
      revealTimer.current = setInterval(() => {
        i++
        setDisplayText(t.slice(0, i))
        if (i >= t.length) {
          clearInterval(revealTimer.current)
          revealTimer.current = undefined
        }
      }, intervalMs)
    })
    onTTSError((err) => {
      setError(err)
    })
  }, [])

  useEffect(() => {
    const c1 = window.electronAPI.onStateUpdate((s) => {
      if (s.error) setError(s.error as string)
      if (s.ttsPlaying !== undefined) setTtsPlaying(s.ttsPlaying as boolean)
    })
    const c2 = window.electronAPI.onAIChunk((chunk) => {
      setText(prev => prev + chunk)
      if (fadeTimer.current) clearTimeout(fadeTimer.current)
    })
    const c3 = window.electronAPI.onTTSAudio((filePath) => {
      playTTS(filePath)
    })
    const c4 = window.electronAPI.onTTSBuffer((buf) => {
      playTTSBuffer(buf)
    })
    return () => { c1?.(); c2?.(); c3?.(); c4?.(); stopTTS() }
  }, [])

  const handleResult = useCallback(async (t: string) => {
    if (!t) return
    setTranscribed(t)
    setText('')
    setDisplayText('')
    setError(undefined)
    if (revealTimer.current) { clearInterval(revealTimer.current); revealTimer.current = undefined }
    await window.electronAPI.chat(t)
    if (fadeTimer.current) clearTimeout(fadeTimer.current)
    fadeTimer.current = setTimeout(() => { setText(''); setDisplayText('') }, 10000)
  }, [])

  return (
    <div className="shell">
      <div className="app">
      {/* 音频可视化 */}
      <div className="viz-area">
        <div className="viz-glow" />
        <div className="viz-ring" />
        <WaveRibbon ttsPlaying={ttsPlaying} />
        <div className="particle p1" /><div className="particle p2" /><div className="particle p3" /><div className="particle p4" /><div className="particle p5" />
        <div className="particle p6" /><div className="particle p7" /><div className="particle p8" /><div className="particle p9" /><div className="particle p10" />
      </div>

      {/* 状态指示器 */}
      <StatusBar conversationActive={active} ttsPlaying={ttsPlaying} error={error} />

        {/* 转录显示 — 始终可见 */}
        <div className="transcript-card">
          <div className="marquee-wrap" ref={wrapRef}>
            <div className={`marquee-inner${overflow ? ' scrolling' : ''}`} key={transcribed || ' '} ref={marqueeRef}>
              {transcribed || '\u00A0'}
            </div>
          </div>
          {displayText && <p className="reply-text">{displayText}</p>}
        </div>

        {/* 控制区 */}
        <VoiceInput
          onResult={handleResult}
          onConversationChange={setActive}
          ttsPlaying={ttsPlaying}
        />

      </div>
    </div>
  )
}

export default App
