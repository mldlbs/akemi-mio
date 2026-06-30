import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useSessions } from '../useSessions'
import { createMockIPC } from '../../__tests__/mockIPC'

function mockSessions() {
  return [
    {
      id: 's1',
      source: 'electron',
      category: 'chat',
      label: 'Chat 1',
      messageCount: 3,
      lastActivityAt: Date.now(),
      createdAt: Date.now() - 60000,
    },
    {
      id: 's2',
      source: 'electron',
      category: 'chat',
      label: 'Chat 2',
      messageCount: 1,
      lastActivityAt: Date.now() - 30000,
      createdAt: Date.now() - 120000,
    },
  ]
}

function mockMessages(sessionId: string) {
  return [
    {
      id: `msg-${sessionId}-1`,
      source: 'electron',
      role: 'user',
      content: 'hello',
      category: 'chat',
      sessionId,
      createdAt: Date.now() - 10000,
    },
    {
      id: `msg-${sessionId}-2`,
      source: 'electron',
      role: 'assistant',
      content: 'hi',
      category: 'chat',
      sessionId,
      createdAt: Date.now() - 5000,
    },
  ]
}

beforeEach(() => {
  window.electronAPI = createMockIPC({
    getSessions: vi.fn().mockResolvedValue(mockSessions()),
    getMessagesBySession: vi.fn().mockImplementation((id: string) => Promise.resolve(mockMessages(id))),
    onMessageNew: vi.fn().mockReturnValue(vi.fn()),
  }) as any
})

describe('useSessions', () => {
  it('loads sessions on mount and sets activeSessionId to first session', async () => {
    const { result } = renderHook(() => useSessions())
    await waitFor(() => expect(result.current.sessions.length).toBe(2))
    expect(result.current.sessionsLoading).toBe(false)
    expect(result.current.activeSessionId).toBe('s1')
  })

  it('loads messages for active session', async () => {
    const { result } = renderHook(() => useSessions())
    await waitFor(() => expect(result.current.historyMessages.length).toBe(2))
    expect(result.current.historyLoading).toBe(false)
  })

  it('handleSelectChat resets messages and switches session', async () => {
    const { result } = renderHook(() => useSessions())
    await waitFor(() => expect(result.current.sessions.length).toBe(2))
    expect(result.current.activeSessionId).toBe('s1')

    act(() => {
      result.current.handleSelectChat('s2')
    })
    expect(result.current.activeSessionId).toBe('s2')
    expect(result.current.historyMessages).toEqual([])
    await waitFor(() => expect(result.current.historyMessages.length).toBe(2))
  })

  it('appends message from onMessageNew when same session', async () => {
    let onNewHandler: Function = () => {}
    window.electronAPI.onMessageNew = vi.fn().mockImplementation((cb: Function) => {
      onNewHandler = cb
      return vi.fn()
    }) as any
    const { result } = renderHook(() => useSessions())
    await waitFor(() => expect(result.current.sessions.length).toBe(2))

    act(() => {
      onNewHandler({
        id: 'msg-new',
        source: 'electron',
        role: 'assistant',
        content: 'new reply',
        category: 'chat',
        sessionId: 's1',
        createdAt: Date.now(),
      })
    })
    expect(result.current.historyMessages).toHaveLength(3)
    expect(result.current.historyMessages[2].content).toBe('new reply')
  })

  it('switches session on onMessageNew when different non-evolution session', async () => {
    let onNewHandler: Function = () => {}
    window.electronAPI.onMessageNew = vi.fn().mockImplementation((cb: Function) => {
      onNewHandler = cb
      return vi.fn()
    }) as any
    const { result } = renderHook(() => useSessions())
    await waitFor(() => expect(result.current.sessions.length).toBe(2))

    act(() => {
      onNewHandler({
        id: 'msg-s2',
        source: 'electron',
        role: 'assistant',
        content: 'reply',
        category: 'chat',
        sessionId: 's2',
        createdAt: Date.now(),
      })
    })
    expect(result.current.activeSessionId).toBe('s2')
  })

  it('does NOT switch session for evolution category messages', async () => {
    let onNewHandler: Function = () => {}
    window.electronAPI.onMessageNew = vi.fn().mockImplementation((cb: Function) => {
      onNewHandler = cb
      return vi.fn()
    }) as any
    const { result } = renderHook(() => useSessions())
    await waitFor(() => expect(result.current.sessions.length).toBe(2))
    expect(result.current.activeSessionId).toBe('s1')

    act(() => {
      onNewHandler({
        id: 'msg-evo',
        source: 'electron',
        role: 'assistant',
        content: 'evolved',
        category: 'evolution',
        sessionId: 's2',
        createdAt: Date.now(),
      })
    })
    expect(result.current.activeSessionId).toBe('s1')
  })

  it('handles getSessions rejection gracefully', async () => {
    window.electronAPI = createMockIPC({
      getSessions: vi.fn().mockRejectedValue(new Error('db error')),
    }) as any
    const { result } = renderHook(() => useSessions())
    await waitFor(() => expect(result.current.sessionsLoading).toBe(false))
    expect(result.current.sessions).toEqual([])
  })
})
