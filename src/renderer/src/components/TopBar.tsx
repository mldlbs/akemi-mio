import type { ReactNode } from 'react'
import { useSlots } from '../slots/SlotContext'
import { StatusBar } from './StatusBar'
import type { AgentState } from '../hooks/useAIOutput'

interface TopBarProps {
  conversationActive: boolean
  ttsPlaying?: boolean
  error?: string
  sessionHealth?: string
  personaLevel?: string
  /** Agent window toggle button — renders into actions area if provided */
  agentSlot?: ReactNode
  onOpenSettings?: () => void
  agentState?: AgentState
}

export function TopBar({
  conversationActive,
  ttsPlaying,
  error,
  sessionHealth,
  personaLevel,
  agentSlot,
  onOpenSettings,
  agentState,
}: TopBarProps) {
  const { uiState, toggleSidebar } = useSlots()

  return (
    <header className="topbar">
      <button className="topbar-btn" onClick={toggleSidebar} title={uiState.sidebarOpen ? '收起侧栏' : '展开侧栏'}>
        <i className={`ri-menu-${uiState.sidebarOpen ? 'fold' : 'unfold'}-line`} />
      </button>
      <span className="topbar-logo">秋山澪</span>

      <div className="topbar-center">
        <StatusBar
          conversationActive={conversationActive}
          ttsPlaying={ttsPlaying}
          error={error}
          sessionHealth={sessionHealth}
          personaLevel={personaLevel}
          agentState={agentState}
        />
      </div>

      <div className="topbar-actions">
        <button className="cap-toggle-btn" onClick={onOpenSettings} title="设置">
          <i className="ri-settings-3-line" />
        </button>
        {agentSlot}
        <button className="topbar-close" onClick={() => window.electronAPI.closeWindow()} title="关闭">
          <i className="ri-close-line" />
        </button>
      </div>
    </header>
  )
}
