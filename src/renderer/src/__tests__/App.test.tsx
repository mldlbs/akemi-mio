import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { renderWithProviders } from './renderWithProviders'
import { createMockIPC } from './mockIPC'
import { resetAllStores } from '../store/reset'

// Mock the hooks barrel for predictable return values (hooks still use IPC internally)
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
    handleResult: vi.fn(),
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
    const view = renderWithProviders(<App />)
    return { ...view }
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

  it('renders all TopBar slot toggle buttons', () => {
    renderApp()
    expect(screen.getByTitle('会话')).toBeTruthy()
    expect(screen.getByTitle('OTPAR 认知循环')).toBeTruthy()
    expect(screen.getByTitle('开发计划')).toBeTruthy()
    expect(screen.getByTitle('工作流')).toBeTruthy()
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

  it('renders mic button in InputBar', () => {
    const { container } = renderApp()
    expect(container.querySelector('.btn-voice')).toBeTruthy()
  })

  it('shows StatusBar with idle text', () => {
    renderApp()
    expect(screen.getByText('待命')).toBeTruthy()
  })

  it('navigates to OTPAR slot via TopBar', () => {
    renderApp()
    fireEvent.click(screen.getByTitle('OTPAR 认知循环'))
    expect(screen.getByText('没有认知数据')).toBeTruthy()
  })

  it('navigates to devplan slot via TopBar', () => {
    renderApp()
    fireEvent.click(screen.getByTitle('开发计划'))
    expect(screen.getByText('当前没有活跃的开发计划')).toBeTruthy()
  })

  it('toggles sidebar via TopBar menu button', () => {
    renderApp()
    fireEvent.click(screen.getByTitle('收起侧栏'))
    expect(screen.getByTitle('展开侧栏')).toBeTruthy()
  })

  it('returns to chat when clicking active OTPAR slot again', () => {
    renderApp()
    fireEvent.click(screen.getByTitle('OTPAR 认知循环'))
    expect(screen.getByText('没有认知数据')).toBeTruthy()
    fireEvent.click(screen.getByTitle('OTPAR 认知循环'))
    expect(screen.getByText('开始一段新对话')).toBeTruthy()
  })
})
