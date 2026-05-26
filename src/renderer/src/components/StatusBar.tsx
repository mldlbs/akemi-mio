interface StatusBarProps {
  asrStatus: string
  recording: boolean
  error?: string
}

export function StatusBar({ asrStatus, recording, error }: StatusBarProps) {
  return (
    <div className="status-bar">
      <span className={`status-asr ${asrStatus}`}>
        {asrStatus === 'ready' ? '✓ 语音就绪' : '⋯ 加载中'}
      </span>
      {recording && <span className="status-recording">● 录音中</span>}
      {error && <span className="status-error">{error}</span>}
    </div>
  )
}
