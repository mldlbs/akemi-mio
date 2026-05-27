interface StatusBarProps {
  asrStatus: string
  conversationActive: boolean
  error?: string
}

export function StatusBar({ asrStatus, conversationActive, error }: StatusBarProps) {
  return (
    <div className="status-bar">
      <span className={`status-asr ${asrStatus}`}>
        {asrStatus === 'ready' ? '✓ ASR 就绪' : asrStatus === 'loading' ? '⏳ 加载中...' : '✗ ASR 异常'}
      </span>
      {conversationActive && <span className="status-recording">● 对话中</span>}
      {error && <span className="status-error">{error}</span>}
    </div>
  )
}
