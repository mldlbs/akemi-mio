import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ChatSlot } from '../ChatSlot'
import { createMockIPC } from '../../__tests__/mockIPC'
import { resetAllStores } from '../../store/reset'
import { useSessionStore } from '../../store/sessionStore'
import { useAgentStore } from '../../store/agentStore'
import type { MessageItem } from '../../slots/types'

beforeEach(() => {
  resetAllStores()
  window.electronAPI = createMockIPC() as any
})

describe('ChatSlot', () => {
  it('shows loading state', () => {
    useSessionStore.getState().setHistoryLoading(true)
    render(<ChatSlot />)
    expect(screen.getByText('加载中…')).toBeTruthy()
  })

  it('shows empty state', () => {
    render(<ChatSlot />)
    expect(screen.getByText('开始一段新对话')).toBeTruthy()
  })

  it('renders messages from store', () => {
    const msgs: MessageItem[] = [
      { id: 'm1', source: 'electron', role: 'user', content: 'Hello', category: 'chat', sessionId: 's1', createdAt: Date.now() - 5000 },
      {
        id: 'm2',
        source: 'electron',
        role: 'assistant',
        content: 'Hi there!',
        category: 'chat',
        sessionId: 's1',
        createdAt: Date.now() - 3000,
      },
    ]
    useSessionStore.getState().setHistoryMessages(msgs)
    render(<ChatSlot />)
    expect(screen.getByText('Hello')).toBeTruthy()
    expect(screen.getByText('Hi there!')).toBeTruthy()
  })

  it('shows transcribed from store', () => {
    useAgentStore.getState().setTranscribed('voice input')
    render(<ChatSlot />)
    expect(screen.getByText('voice input')).toBeTruthy()
  })

  it('shows agent indicator for thinking state', () => {
    useAgentStore.getState().setAgentState('thinking')
    render(<ChatSlot />)
    expect(screen.getByText('思考中…')).toBeTruthy()
  })

  it('does NOT show agent indicator for idle state', () => {
    const { container } = render(<ChatSlot />)
    expect(container.querySelector('.agent-indicator')).toBeNull()
  })

  it('shows pending text from store', () => {
    useAgentStore.getState().setPendingText('streaming reply')
    render(<ChatSlot />)
    expect(screen.getByText('streaming reply')).toBeTruthy()
  })

  it('shows running tools from store', () => {
    useAgentStore.getState().addToolRunning({ id: 't1', tool: 'read_file', args: { path: '/src/index.ts' } })
    render(<ChatSlot />)
    expect(screen.getAllByText('读取文件').length).toBeGreaterThanOrEqual(1)
  })
})
