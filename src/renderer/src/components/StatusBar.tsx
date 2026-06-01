interface StatusBarProps {
  conversationActive: boolean
  ttsPlaying?: boolean
  error?: string
}

export function StatusBar({ conversationActive, ttsPlaying, error }: StatusBarProps) {
  const status = ttsPlaying ? '回复中' : conversationActive ? '正在聆听' : '待命'
  const sub = ttsPlaying ? '· 播放回复' : conversationActive ? '· 等待语音输入' : ''

  return (
    <div className="status-bar" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div className="status-dot" style={{
        width: 9, height: 8, borderRadius: '50%',
        background: conversationActive ? 'rgba(139,92,246,1)' : 'rgba(139,92,246,0.3)',
        boxShadow: conversationActive ? '0 0 12px rgba(139,92,246,0.8)' : 'none',
      }} />
      <span style={{ fontSize: 14, fontWeight: 500, color: 'rgba(196,181,253,1)' }}>{status}</span>
      {sub && <span style={{ fontSize: 12, fontWeight: 400, color: 'rgba(196,181,253,0.5)' }}>{sub}</span>}
      {error && <span style={{ fontSize: 12, color: '#f87171' }}>{error}</span>}
    </div>
  )
}
