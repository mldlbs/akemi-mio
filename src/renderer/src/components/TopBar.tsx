import type { ReactNode } from 'react'
import { useSlots } from '../slots/SlotContext'
import { StatusBar } from './StatusBar'

interface TopBarProps {
  conversationActive: boolean
  ttsPlaying?: boolean
  error?: string
  sessionHealth?: string
  personaLevel?: string
  /** Agent window toggle button — renders into actions area if provided */
  agentSlot?: ReactNode
  onOpenSettings?: () => void
}

export function TopBar({ conversationActive, ttsPlaying, error, sessionHealth, personaLevel, agentSlot, onOpenSettings }: TopBarProps) {
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
        />
      </div>

      <div className="topbar-actions">
        <button className="cap-toggle-btn" onClick={onOpenSettings} title="设置">
          <i className="ri-settings-3-line" />
        </button>
        {agentSlot}
      </div>
    </header>
  )
}
