import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { renderWithProviders } from './renderWithProviders'
import { createMockIPC } from './mockIPC'
import { resetAllStores } from '../store/reset'

vi.mock('../hooks', () => ({
  useSessions: () => {},
  useDeviceStatus: () => ({
    active: false,
    ttsPlaying: false,
    error: undefined,
    sessionHealth: '100:HEALTHY:RUNNING',
    personaLevel: 'core',
    settingsOpen: false,
    setActive: vi.fn(),
    setError: vi.fn(),
    setSettingsOpen: vi.fn(),
  }),
  useAIOutput: () => ({
    pendingText: '',
    displayText: '',
    transcribed: '',
    toolStatus: null,
    agentState: 'idle',
    voiceIntentPrompt: null,
    handleTextSubmit: vi.fn(),
    handleVoiceResult: vi.fn(),
    confirmVoiceIntent: vi.fn(),
    sendVoiceIntentAsChat: vi.fn(),
    dismissVoiceIntent: vi.fn(),
  }),
  useTools: () => {},
  usePlans: () => {},
  useWorkflowDefinitions: () => {},
}))

import App from '../App'

beforeEach(() => {
  resetAllStores()
  window.electronAPI = createMockIPC() as any
})

describe('App', () => {
  function renderApp() {
    return renderWithProviders(<App />)
  }

  /** 槽位是常驻标签栏（已不是下拉菜单），直接点对应 tab 即可，无需先展开。 */
  function clickSlot(container: HTMLElement, slot: string) {
    fireEvent.click(container.querySelector(`[data-slot="${slot}"]`)!)
  }

  it('renders app shell with logo', () => {
    const { container } = renderApp()
    expect(container.querySelector('.app-shell')).toBeTruthy()
    expect(screen.getByText('秋山澪')).toBeTruthy()
  })

  it('renders app-body section', () => {
    const { container } = renderApp()
    expect(container.querySelector('.app-body')).toBeTruthy()
  })

  it('renders sidebar', () => {
    const { container } = renderApp()
    expect(container.querySelector('.sidebar')).toBeTruthy()
  })

  it('renders main area', () => {
    const { container } = renderApp()
    expect(container.querySelector('.main-area')).toBeTruthy()
  })

  it('renders input bar', () => {
    const { container } = renderApp()
    expect(container.querySelector('.inputbar')).toBeTruthy()
  })

  it('shows ChatSlot default content', () => {
    renderApp()
    expect(screen.getByText('开始一段新对话')).toBeTruthy()
  })

  it('renders all TopBar slot tabs', () => {
    const { container } = renderApp()

    expect(container.querySelector('[data-slot="chat"]')).toBeTruthy()
    expect(container.querySelector('[data-slot="otpar"]')).toBeTruthy()
    expect(container.querySelector('[data-slot="devplan"]')).toBeTruthy()
    expect(container.querySelector('[data-slot="workflow"]')).toBeTruthy()
  })

  it('renders window controls', () => {
    renderApp()
    expect(screen.getByTitle('最小化')).toBeTruthy()
    expect(screen.getByTitle('关闭')).toBeTruthy()
  })

  it('renders settings button', () => {
    renderApp()
    expect(screen.getByTitle('设置')).toBeTruthy()
  })

  it('keeps the workbench drawer out of the default layout until explicitly opened', () => {
    const { container } = renderApp()

    expect(container.querySelector('.right-panel')).toBeNull()
    fireEvent.click(container.querySelector('.topbar-workbench-trigger')!)
    expect(container.querySelector('.right-panel')).toBeTruthy()
  })

  it('renders mic button in InputBar', () => {
    const { container } = renderApp()
    expect(container.querySelector('.btn-voice')).toBeTruthy()
  })

  it('shows StatusBar with idle text', () => {
    renderApp()
    expect(screen.getByText('待命')).toBeTruthy()
  })

  it('navigates to OTPAR slot via TopBar tab', () => {
    const { container } = renderApp()
    clickSlot(container, 'otpar')
    expect(screen.getByText('没有认知数据')).toBeTruthy()
  })

  it('navigates to devplan slot via TopBar tab', () => {
    const { container } = renderApp()
    clickSlot(container, 'devplan')
    expect(screen.getByText('当前没有活跃的开发计划')).toBeTruthy()
  })

  it('toggles sidebar via TopBar menu button', () => {
    const { container } = renderApp()
    fireEvent.click(screen.getByTitle('收起侧栏'))
    expect(container.querySelector('.sidebar.collapsed')).toBeTruthy()
  })

  it('returns to chat from the slot tab', () => {
    const { container } = renderApp()
    clickSlot(container, 'otpar')
    expect(screen.getByText('没有认知数据')).toBeTruthy()

    clickSlot(container, 'chat')
    expect(screen.getByText('开始一段新对话')).toBeTruthy()
  })
})
