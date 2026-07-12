import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Sidebar } from '../Sidebar'
import { renderWithProviders } from '../../__tests__/renderWithProviders'
import { createMockIPC } from '../../__tests__/mockIPC'
import { resetAllStores } from '../../store/reset'
import { useSessionStore } from '../../store/sessionStore'
import { useHistoryViewStore } from '../../store/historyViewStore'

beforeEach(() => {
  resetAllStores()
  window.electronAPI = createMockIPC() as any
})

describe('Sidebar', () => {
  it('shows empty state', () => {
    useSessionStore.getState().setSessionsLoading(false)
    renderWithProviders(<Sidebar />)
    expect(screen.getByText(/暂无对话/)).toBeTruthy()
  })

  it('renders sessions grouped by category', () => {
    const now = Date.now()
    useSessionStore.getState().setSessionsLoading(false)
    useSessionStore.getState().setSessions([
      { id: 's1', source: 'electron', category: 'chat', label: 'Chat A', messageCount: 3, lastActivityAt: now, createdAt: now },
      {
        id: 's2',
        source: 'electron',
        category: 'writing',
        label: 'Story B',
        messageCount: 1,
        lastActivityAt: now - 30000,
        createdAt: now - 60000,
      },
      {
        id: 's3',
        source: 'electron',
        category: 'chat',
        label: 'Chat C',
        messageCount: 5,
        lastActivityAt: now - 100000,
        createdAt: now - 200000,
      },
    ])
    renderWithProviders(<Sidebar />)
    expect(screen.getByText('对话')).toBeTruthy()
    expect(screen.getByText('写作')).toBeTruthy()
    const items = document.querySelectorAll('.sidebar-item')
    expect(items.length).toBe(3)
  })

  it('highlights active session from store', () => {
    const now = Date.now()
    useSessionStore.getState().setSessionsLoading(false)
    useSessionStore.getState().setSessions([
      { id: 's1', source: 'electron', category: 'chat', label: 'Chat 1', messageCount: 3, lastActivityAt: now, createdAt: now },
      {
        id: 's2',
        source: 'electron',
        category: 'chat',
        label: 'Chat 2',
        messageCount: 1,
        lastActivityAt: now - 30000,
        createdAt: now - 60000,
      },
    ])
    useSessionStore.getState().setActiveSessionId('s1')
    renderWithProviders(<Sidebar />)
    const btns = document.querySelectorAll('.sidebar-item')
    expect(btns[0].classList.contains('active')).toBe(true)
    expect(btns[1].classList.contains('active')).toBe(false)
  })

  it('opens history via store on click', () => {
    const now = Date.now()
    useSessionStore.getState().setSessionsLoading(false)
    useSessionStore.getState().setSessions([
      { id: 's1', source: 'electron', category: 'chat', label: 'Chat 1', messageCount: 3, lastActivityAt: now, createdAt: now },
      {
        id: 's2',
        source: 'electron',
        category: 'chat',
        label: 'Chat 2',
        messageCount: 1,
        lastActivityAt: now - 30000,
        createdAt: now - 60000,
      },
    ])
    useSessionStore.getState().setActiveSessionId('s1')
    renderWithProviders(<Sidebar />)
    const btns = document.querySelectorAll('.sidebar-item')
    fireEvent.click(btns[1])
    expect(useHistoryViewStore.getState().viewing).toBe(true)
    expect(useHistoryViewStore.getState().sessionId).toBe('s2')
  })

  it('shows category sections without date headers', () => {
    const now = Date.now()
    useSessionStore.getState().setSessionsLoading(false)
    useSessionStore
      .getState()
      .setSessions([
        { id: 's1', source: 'electron', category: 'writing', label: 'Story', messageCount: 1, lastActivityAt: now, createdAt: now },
      ])
    renderWithProviders(<Sidebar />)
    expect(screen.getByText('写作')).toBeTruthy()
    expect(screen.queryByText('今天')).toBeNull()
  })
})
