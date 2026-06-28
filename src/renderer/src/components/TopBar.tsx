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
  onOpenSettings?: () => void
  agentState?: AgentState
}

export function TopBar({ conversationActive, ttsPlaying, error, sessionHealth, personaLevel, onOpenSettings, agentState }: TopBarProps) {
  const { uiState, toggleSidebar, setActiveSlot } = useSlots()

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
        <button
          className={`cap-toggle-btn${uiState.activeSlot === 'otpar' ? ' active' : ''}`}
          onClick={() => setActiveSlot(uiState.activeSlot === 'otpar' ? 'chat' : 'otpar')}
          title="OTPAR 认知循环"
        >
          <i className="ri-brain-line" />
        </button>
        <button
          className={`cap-toggle-btn${uiState.activeSlot === 'devplan' ? ' active' : ''}`}
          onClick={() => setActiveSlot(uiState.activeSlot === 'devplan' ? 'chat' : 'devplan')}
          title="开发计划"
        >
          <i className="ri-code-s-slash-line" />
        </button>
        <button
          className={`cap-toggle-btn${uiState.activeSlot === 'workflow' ? ' active' : ''}`}
          onClick={() => setActiveSlot(uiState.activeSlot === 'workflow' ? 'chat' : 'workflow')}
          title="工作流"
        >
          <i className="ri-flow-chart" />
        </button>
        <button className="cap-toggle-btn" onClick={onOpenSettings} title="设置">
          <i className="ri-settings-3-line" />
        </button>
        <button className="topbar-close" onClick={() => window.electronAPI.closeWindow()} title="关闭">
          <i className="ri-close-line" />
        </button>
      </div>
    </header>
  )
}
