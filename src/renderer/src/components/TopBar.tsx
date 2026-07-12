import { useState, useRef, useEffect, useCallback } from 'react'
import { useSlots } from '../slots/SlotContext'
import { StatusBar } from './StatusBar'

interface TopBarProps {
  onOpenSettings?: () => void
}

const SLOT_META: Record<string, { label: string; icon: string }> = {
  chat: { label: '会话', icon: 'ri-chat-1-line' },
  tool: { label: '工具', icon: 'ri-tools-line' },
  preview: { label: '预览', icon: 'ri-eye-line' },
  workflow: { label: '工作流', icon: 'ri-flow-chart' },
  devplan: { label: '开发计划', icon: 'ri-code-s-slash-line' },
  otpar: { label: 'OTPAR 认知循环', icon: 'ri-brain-line' },
}

export function TopBar({ onOpenSettings }: TopBarProps) {
  const { uiState, toggleSidebar, toggleRightPanel, setActiveSlot } = useSlots()
  const [slotMenuOpen, setSlotMenuOpen] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)
  const [isFullScreen, setIsFullScreen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setSlotMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    ;(window as any).electronAPI?.isMaximized?.().then((r: any) => {
      if (r) setIsMaximized(r.isMaximized)
    })
  }, [])

  const handleMaximize = useCallback(async () => {
    const r = await (window as any).electronAPI?.maximizeWindow?.()
    if (r) setIsMaximized(r.isMaximized)
  }, [])

  const handleFullscreen = useCallback(async () => {
    const r = await (window as any).electronAPI?.toggleFullscreen?.()
    if (r) setIsFullScreen(r.isFullScreen)
  }, [])

  const currentSlot = SLOT_META[uiState.activeSlot] || SLOT_META.chat

  return (
    <header className="topbar">
      <button className="topbar-btn" onClick={toggleSidebar} title={uiState.sidebarOpen ? '收起侧栏' : '展开侧栏'}>
        <i className={`ri-menu-${uiState.sidebarOpen ? 'fold' : 'unfold'}-line`} />
      </button>
      <span className="topbar-logo">秋山澪</span>

      <div className="topbar-center">
        <StatusBar />
      </div>

      <div className="topbar-actions">
        {/* ── Slot 切换下拉菜单 ── */}
        <div className="topbar-slot-dropdown" ref={menuRef}>
          <button className="topbar-slot-trigger" onClick={() => setSlotMenuOpen((o) => !o)} title={`当前: ${currentSlot.label}`}>
            <i className={currentSlot.icon} />
            <span className="topbar-slot-label">{currentSlot.label}</span>
            <i className={`ri-arrow-${slotMenuOpen ? 'up' : 'down'}-s-line`} />
          </button>
          {slotMenuOpen && (
            <div className="topbar-slot-menu">
              {Object.entries(SLOT_META).map(([key, meta]) => (
                <button
                  key={key}
                  className={`topbar-slot-option${key === uiState.activeSlot ? ' active' : ''}`}
                  onClick={() => {
                    setActiveSlot(key as any)
                    setSlotMenuOpen(false)
                  }}
                >
                  <i className={meta.icon} />
                  <span>{meta.label}</span>
                  {key === uiState.activeSlot && <i className="ri-check-line" />}
                </button>
              ))}
            </div>
          )}
        </div>

        <button className="topbar-btn" onClick={onOpenSettings} title="设置">
          <i className="ri-settings-3-line" />
        </button>
        <button className="topbar-btn" onClick={toggleRightPanel} title={uiState.rightPanelOpen ? '收起右侧面板' : '展开右侧面板'}>
          <i className={`ri-layout-right-2-${uiState.rightPanelOpen ? 'fill' : 'line'}`} />
        </button>
        <button className="topbar-btn" onClick={handleMaximize} title={isMaximized ? '还原窗口' : '最大化'}>
          <i className={isMaximized ? 'ri-checkbox-multiple-blank-line' : 'ri-checkbox-line'} />
        </button>
        <button className="topbar-btn" onClick={handleFullscreen} title={isFullScreen ? '退出全屏' : '全屏'}>
          <i className="ri-fullscreen-line" />
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
