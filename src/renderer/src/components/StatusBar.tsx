interface StatusBarProps {
  asrStatus: string
  voiceState: 'idle' | 'recording' | 'transcribing'
  error?: string
}

export function StatusBar({ asrStatus, voiceState, error }: StatusBarProps) {
  return (
    <div className="status-bar">
      <span className={`status-asr ${asrStatus}`}>
        {asrStatus === 'ready' ? '✓ ASR 就绪' : asrStatus === 'loading' ? '⏳ 加载中...' : '✗ ASR 异常'}
      </span>
      {voiceState === 'recording' && <span className="status-recording">● 录音中</span>}
      {voiceState === 'transcribing' && <span>↻ 识别中</span>}
      {error && <span className="status-error">{error}</span>}
    </div>
  )
}
