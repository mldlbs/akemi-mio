import { useSlots } from '../slots/SlotContext'
import { StatusBar } from './StatusBar'
import type { ActiveSlot } from '../slots/types'

interface TopBarProps {
  onOpenSettings?: () => void
}

const SLOT_META: Record<string, { label: string; icon: string }> = {
  chat: { label: '会话', icon: 'ri-chat-1-line' },
  tool: { label: '工具', icon: 'ri-tools-line' },
  preview: { label: '预览', icon: 'ri-eye-line' },
  workflow: { label: '工作流', icon: 'ri-flow-chart' },
  devplan: { label: '开发计划', icon: 'ri-code-s-slash-line' },
  otpar: { label: 'OTPAR', icon: 'ri-brain-line' },
}

export function TopBar({ onOpenSettings }: TopBarProps) {
  const { uiState, toggleSidebar, toggleRightPanel, setActiveSlot } = useSlots()

  return (
    <header className="topbar">
      <button className="topbar-btn" onClick={toggleSidebar} title={uiState.sidebarOpen ? '收起侧栏' : '展开侧栏'}>
        <i className={`ri-menu-${uiState.sidebarOpen ? 'fold' : 'unfold'}-line`} />
      </button>
      <span className="topbar-logo">秋山澪</span>

      <nav className="slot-tabs" aria-label="工作区切换">
        {Object.entries(SLOT_META).map(([key, meta]) => (
          <button
            key={key}
            type="button"
            className={`slot-tab${key === uiState.activeSlot ? ' active' : ''}`}
            data-slot={key}
            onClick={() => setActiveSlot(key as ActiveSlot)}
            title={meta.label}
            aria-label={meta.label}
            aria-current={key === uiState.activeSlot ? 'page' : undefined}
          >
            <i className={meta.icon} />
            <span>{meta.label}</span>
          </button>
        ))}
      </nav>

      <div className="topbar-center" />

      <div className="topbar-actions">
        <div className="topbar-status">
          <StatusBar />
        </div>

        <button className="topbar-btn" onClick={onOpenSettings} title="设置">
          <i className="ri-settings-3-line" />
        </button>
        <button
          className={`topbar-slot-trigger topbar-workbench-trigger${uiState.rightPanelOpen ? ' active' : ''}`}
          onClick={toggleRightPanel}
          title={uiState.rightPanelOpen ? '收起工作台抽屉' : '打开工作台抽屉'}
          aria-label={uiState.rightPanelOpen ? '收起工作台抽屉' : '打开工作台抽屉'}
        >
          <i className={uiState.rightPanelOpen ? 'ri-layout-right-2-fill' : 'ri-layout-right-2-line'} />
          <span className="topbar-workbench-label topbar-workbench-label--full">工作台</span>
          <span className="topbar-workbench-label topbar-workbench-label--compact" aria-hidden="true">
            台
          </span>
        </button>
        <button className="topbar-window-btn" onClick={() => window.electronAPI.minimizeWindow()} title="最小化">
          <i className="ri-subtract-line" />
        </button>
        <button className="topbar-close" onClick={() => window.electronAPI.closeWindow()} title="关闭">
          <i className="ri-close-line" />
        </button>
      </div>
    </header>
  )
}
