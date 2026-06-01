let micEnergy = 0
export function updateMicEnergy(rms: number) { micEnergy = Math.min(1, rms * 8) }
export function readMicEnergy(): number { return micEnergy }

// --- TTS 有限状态机 ---
type TTSState = 'idle' | 'loading' | 'playing'
let ttsState: TTSState = 'idle'
let ttsCtx: AudioContext | null = null
let ttsSource: AudioBufferSourceNode | null = null
let ttsAnalyser: AnalyserNode | null = null
let ttsEnergy = 0
let ttsAnimId = 0
let ttsStartCb: ((duration: number) => void) | null = null
let ttsErrorCb: ((err: string) => void) | null = null

export function onTTSStart(cb: (duration: number) => void) { ttsStartCb = cb }
export function onTTSError(cb: (err: string) => void) { ttsErrorCb = cb }

function safeCleanup() {
  if (ttsAnimId) { cancelAnimationFrame(ttsAnimId); ttsAnimId = 0 }
  ttsEnergy = 0
  try {
    if (ttsSource) { ttsSource.stop(); ttsSource.disconnect() }
  } catch { /* already stopped */ }
  ttsSource = null
  ttsAnalyser = null
  if (ttsCtx && ttsCtx.state !== 'closed') ttsCtx.close()
  ttsCtx = null
  ttsState = 'idle'
}

function doPlay(buf: ArrayBuffer) {
  safeCleanup()
  ttsState = 'loading'
  const ctx = new AudioContext()
  ttsCtx = ctx

  ctx.decodeAudioData(buf.slice(0))
    .then(audioBuf => {
      if (ttsState !== 'loading') { ctx.close(); return }
      ttsState = 'playing'

      const duration = audioBuf.duration
      ttsStartCb?.(duration)

      ttsAnalyser = ctx.createAnalyser()
      ttsAnalyser.fftSize = 256
      ttsAnalyser.smoothingTimeConstant = 0.85

      ttsSource = ctx.createBufferSource()
      ttsSource.buffer = audioBuf
      ttsSource.connect(ttsAnalyser)
      ttsAnalyser.connect(ctx.destination)
      ttsSource.start()

      const freqData = new Uint8Array(ttsAnalyser.frequencyBinCount)
      const poll = () => {
        if (ttsState !== 'playing') return
        ttsAnalyser?.getByteFrequencyData(freqData)
        let total = 0
        for (let b = 0; b < freqData.length; b++) total += freqData[b]
        ttsEnergy = total / (freqData.length * 255)
        ttsAnimId = requestAnimationFrame(poll)
      }
      poll()

      ttsSource.onended = () => { safeCleanup() }
    })
    .catch(err => {
      if (ttsCtx === ctx) safeCleanup()
      ttsErrorCb?.(String(err))
    })
}

export function playTTS(filePath: string): void {
  fetch(`file://${filePath.replace(/\\/g, '/')}`)
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer() })
    .then(buf => doPlay(buf))
    .catch(() => { /* fallback: wait for tts:play_audio_buffer IPC */ })
}

export function playTTSBuffer(buf: ArrayBuffer): void {
  doPlay(buf)
}

export function stopTTS(): void {
  safeCleanup()
}

export function readTTSEnergy(): number {
  return ttsEnergy
}
