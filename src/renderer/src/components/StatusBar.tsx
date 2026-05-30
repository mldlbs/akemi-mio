interface StatusBarProps {
  conversationActive: boolean
  ttsPlaying?: boolean
  error?: string
}

export function StatusBar({ conversationActive, ttsPlaying, error }: StatusBarProps) {
  return (
    <div className="status-bar">
      {conversationActive ? (
        ttsPlaying
          ? <span className="status-tts">♪ 说话中...</span>
          : <span className="status-recording">● 对话中</span>
      ) : (
        <span>🎤 点击开始对话</span>
      )}
      {error && <span className="status-error">{error}</span>}
    </div>
  )
}
