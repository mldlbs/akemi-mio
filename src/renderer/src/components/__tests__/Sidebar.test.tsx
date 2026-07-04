import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Sidebar } from '../Sidebar'
import { renderWithProviders } from '../../__tests__/renderWithProviders'
import { createMockIPC } from '../../__tests__/mockIPC'
import { resetAllStores } from '../../store/reset'
import { useSessionStore } from '../../store/sessionStore'

beforeEach(() => {
  resetAllStores()
  window.electronAPI = createMockIPC() as any
})

describe('Sidebar', () => {
  it('shows empty state', () => {
    renderWithProviders(<Sidebar />)
    expect(screen.getByText(/暂无会话/)).toBeTruthy()
  })

  it('groups sessions by category from store', () => {
    const now = Date.now()
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
      {
        id: 's3',
        source: 'electron',
        category: 'writing',
        label: 'My Story',
        messageCount: 5,
        lastActivityAt: now - 100000,
        createdAt: now - 200000,
      },
    ])
    renderWithProviders(<Sidebar />)
    expect(screen.getByText('聊天')).toBeTruthy()
    expect(screen.getByText('写作')).toBeTruthy()
  })

  it('highlights active session from store', () => {
    const now = Date.now()
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

  it('selects chat via store on click', () => {
    const now = Date.now()
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
    renderWithProviders(<Sidebar />)
    const btns = document.querySelectorAll('.sidebar-item')
    fireEvent.click(btns[1])
    expect(useSessionStore.getState().activeSessionId).toBe('s2')
  })

  it('shows date groups', () => {
    const now = Date.now()
    useSessionStore
      .getState()
      .setSessions([
        { id: 's1', source: 'electron', category: 'chat', label: 'Chat 1', messageCount: 3, lastActivityAt: now, createdAt: now },
      ])
    renderWithProviders(<Sidebar />)
    expect(screen.getByText('今天')).toBeTruthy()
  })
})
