import type { ReactNode } from 'react'
import { useSlots } from '../slots/SlotContext'
import { StatusBar } from './StatusBar'

interface TopBarProps {
  conversationActive: boolean
  ttsPlaying?: boolean
  error?: string
  sessionHealth?: string
  /** Agent window toggle button — renders into actions area if provided */
  agentSlot?: ReactNode
}

export function TopBar({ conversationActive, ttsPlaying, error, sessionHealth, agentSlot }: TopBarProps) {
  const { uiState, toggleSidebar } = useSlots()

  return (
    <header className="topbar">
      <button
        className="topbar-btn"
        onClick={toggleSidebar}
        title={uiState.sidebarOpen ? '收起侧栏' : '展开侧栏'}
      >
        <i className={`ri-menu-${uiState.sidebarOpen ? 'fold' : 'unfold'}-line`} />
      </button>
      <span className="topbar-logo">秋山澪</span>

      <div className="topbar-center">
        <StatusBar
          conversationActive={conversationActive}
          ttsPlaying={ttsPlaying}
          error={error}
          sessionHealth={sessionHealth}
        />
      </div>

      <div className="topbar-actions">
        {agentSlot}
      </div>
    </header>
  )
}
