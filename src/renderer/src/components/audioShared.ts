let micEnergy = 0
export function updateMicEnergy(rms: number) {
  micEnergy = Math.min(1, rms * 8)
}
export function readMicEnergy(): number {
  return micEnergy
}

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
let ttsStateCb: ((state: TTSState) => void) | null = null

/** 实时 FFT 频率数据缓冲区，供 VoiceWallpaper 读取 */
let ttsFreqData: Uint8Array = new Uint8Array(0)

export function onTTSStart(cb: (duration: number) => void) {
  ttsStartCb = cb
}
export function onTTSError(cb: (err: string) => void) {
  ttsErrorCb = cb
}
/** 注册 TTS 播放状态变更回调 */
export function onTTSStateChange(cb: (state: TTSState) => void): () => void {
  ttsStateCb = cb
  cb(ttsState)
  return () => { ttsStateCb = null }
}
/** 读取当前 TTS 播放状态 */
export function readTTSState(): TTSState {
  return ttsState
}
/** 读取最新 FFT 频率数据快照（长度 = frequencyBinCount，0 表示无数据） */
export function readTTSFreqData(): Uint8Array {
  return ttsFreqData
}

function safeCleanup() {
  if (ttsAnimId) {
    cancelAnimationFrame(ttsAnimId)
    ttsAnimId = 0
  }
  ttsEnergy = 0
  try {
    if (ttsSource) {
      ttsSource.stop()
      ttsSource.disconnect()
    }
  } catch {
    /* already stopped */
  }
  ttsSource = null
  ttsAnalyser = null
  if (ttsCtx && ttsCtx.state !== 'closed') ttsCtx.close()
  ttsCtx = null
  ttsState = 'idle'
  ttsStateCb?.(ttsState)
}

function doPlay(buf: ArrayBuffer) {
  safeCleanup()
  ttsState = 'loading'
  ttsStateCb?.(ttsState)
  const ctx = new AudioContext()
  ttsCtx = ctx

  ctx
    .decodeAudioData(buf.slice(0))
    .then((audioBuf) => {
      if (ttsState !== 'loading') {
        ctx.close()
        return
      }
      ttsState = 'playing'
      ttsStateCb?.(ttsState)

      const duration = audioBuf.duration
      ttsStartCb?.(duration)

      ttsAnalyser = ctx.createAnalyser()
      ttsAnalyser.fftSize = 256
      ttsAnalyser.smoothingTimeConstant = 0.85

      // 重设 FFT 数据缓冲区以匹配 analyser 的 frequencyBinCount
      if (ttsFreqData.length !== ttsAnalyser.frequencyBinCount) {
        ttsFreqData = new Uint8Array(ttsAnalyser.frequencyBinCount)
      }

      ttsSource = ctx.createBufferSource()
      ttsSource.buffer = audioBuf
      ttsSource.connect(ttsAnalyser)
      ttsAnalyser.connect(ctx.destination)
      ttsSource.start()

      const freqData = new Uint8Array(ttsAnalyser.frequencyBinCount)
      let ttsPollFrame = 0
      const poll = () => {
        if (ttsState !== 'playing') return
        // 每 2 帧（~30fps）采样一次，避免与 React 渲染竞争
        if (++ttsPollFrame % 2 === 0) {
          ttsAnalyser?.getByteFrequencyData(freqData)
          // 同步到共享缓冲区
          ttsFreqData.set(freqData)
          let total = 0
          for (let b = 0; b < freqData.length; b++) total += freqData[b]
          ttsEnergy = total / (freqData.length * 255)
        }
        ttsAnimId = requestAnimationFrame(poll)
      }
      poll()

      ttsSource.onended = () => {
        safeCleanup()
      }
    })
    .catch((err) => {
      if (ttsCtx === ctx) safeCleanup()
      ttsErrorCb?.(String(err))
    })
}

export function playTTS(filePath: string): void {
  try {
    fetch(`file://${filePath.replace(/\\/g, '/')}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.arrayBuffer()
      })
      .then((buf) => doPlay(buf))
      .catch((err) => {
        console.error('[TTS] playTTS fetch failed:', err)
        ttsErrorCb?.(`TTS 文件加载失败: ${err instanceof Error ? err.message : String(err)}`)
      })
  } catch (err) {
    console.error('[TTS] playTTS failed:', err)
    ttsErrorCb?.(`TTS 播放异常: ${err instanceof Error ? err.message : String(err)}`)
  }
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
