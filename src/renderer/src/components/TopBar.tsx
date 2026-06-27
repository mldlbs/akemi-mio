import { useSlots } from '../slots/SlotContext'

export function TopBar() {
  const { uiState, toggleSidebar } = useSlots()

  return (
    <header className="topbar">
      <button
        className="sidebar-item"
        onClick={toggleSidebar}
        style={{ width: 32, minWidth: 32, justifyContent: 'center', padding: 0 }}
        title={uiState.sidebarOpen ? '收起侧栏' : '展开侧栏'}
      >
        <i className={`ri-menu-${uiState.sidebarOpen ? 'fold' : 'unfold'}-line`} />
      </button>
      <span className="topbar-logo">秋山澪</span>
      <div className="topbar-actions">
        <button className="sidebar-item" style={{ width: 32, minWidth: 32, justifyContent: 'center', padding: 0 }} title="设置">
          <i className="ri-settings-3-line" />
        </button>
      </div>
    </header>
  )
}
