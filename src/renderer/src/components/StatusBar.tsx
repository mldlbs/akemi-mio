import type { AgentState } from '../hooks/useAIOutput'

interface StatusBarProps {
  conversationActive: boolean
  ttsPlaying?: boolean
  error?: string
  sessionHealth?: string
  personaLevel?: string
  agentState?: AgentState
}

const PERSONA_LABELS: Record<string, string> = {
  core: '日常',
  hybrid: '混合',
  writer: '写作',
}

const AGENT_STATUS_TEXT: Record<AgentState, string | null> = {
  idle: null,
  thinking: '思考中',
  tool_executing: '执行工具',
  replying: '回复中',
}

export function StatusBar({ conversationActive, ttsPlaying, error, sessionHealth, personaLevel, agentState }: StatusBarProps) {
  const status = ttsPlaying
    ? '回复中'
    : agentState && AGENT_STATUS_TEXT[agentState]
      ? AGENT_STATUS_TEXT[agentState]!
      : conversationActive
        ? '正在聆听'
        : '待命'
  const sub = ttsPlaying ? '· 播放回复' : conversationActive && !agentState ? '· 等待语音输入' : ''

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
      {personaLevel && personaLevel !== 'core' && (
        <span className={`persona-badge persona-${personaLevel}`}>{PERSONA_LABELS[personaLevel] || personaLevel}</span>
      )}
      {healthDisplay && <span className={`status-health ${healthClass}`}>{healthDisplay}</span>}
      {error && <span className="status-error">{error}</span>}
    </div>
  )
}
