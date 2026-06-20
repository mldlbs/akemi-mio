interface StatusBarProps {
  conversationActive: boolean
  ttsPlaying?: boolean
  error?: string
}

export function StatusBar({ conversationActive, ttsPlaying, error }: StatusBarProps) {
  const status = ttsPlaying ? '回复中' : conversationActive ? '正在聆听' : '待命'
  const sub = ttsPlaying ? '· 播放回复' : conversationActive ? '· 等待语音输入' : ''

  return (
    <div className="status-bar">
      <div className={`status-dot${conversationActive ? ' active' : ''}`} />
      <span className="status-label">{status}</span>
      {sub && <span className="status-sub">{sub}</span>}
      {error && <span className="status-error">{error}</span>}
    </div>
  )
}
