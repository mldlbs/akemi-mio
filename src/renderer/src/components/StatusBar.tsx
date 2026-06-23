interface StatusBarProps {
  conversationActive: boolean
  ttsPlaying?: boolean
  error?: string
  sessionHealth?: string
}

export function StatusBar({ conversationActive, ttsPlaying, error, sessionHealth }: StatusBarProps) {
  const status = ttsPlaying ? '回复中' : conversationActive ? '正在聆听' : '待命'
  const sub = ttsPlaying ? '· 播放回复' : conversationActive ? '· 等待语音输入' : ''

  let healthDisplay: string | null = null
  let healthClass = ''
  if (sessionHealth) {
    const parts = sessionHealth.split(':')
    if (parts.length === 3) {
      const score = parseInt(parts[0], 10)
      const level = parts[1]
      healthDisplay = `${score} ${level}`
      healthClass = score >= 70 ? 'health-ok' : score >= 50 ? 'health-warn' : 'health-bad'
    }
  }

  return (
    <div className="status-bar">
      <div className={`status-dot${conversationActive ? ' active' : ''}`} />
      <span className="status-label">{status}</span>
      {sub && <span className="status-sub">{sub}</span>}
      {healthDisplay && <span className={`status-health ${healthClass}`}>{healthDisplay}</span>}
      {error && <span className="status-error">{error}</span>}
    </div>
  )
}
