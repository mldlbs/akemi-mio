import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMockIPC } from '../../__tests__/mockIPC'
import { renderWithProviders } from '../../__tests__/renderWithProviders'
import type { MessageItem } from '../../slots/types'
import { resetAllStores } from '../../store/reset'
import { useSessionStore } from '../../store/sessionStore'
import { ChatSlot } from '../ChatSlot'
import { TopBar } from '../TopBar'

beforeEach(() => {
  resetAllStores()
  window.electronAPI = createMockIPC() as any
})

describe('quiet chat chrome', () => {
  it('replaces serialized DSML with a compact tool disclosure', () => {
    const message: MessageItem = {
      id: 'tool-message',
      source: 'electron',
      role: 'assistant',
      content: '我先确认连接。<||DSML||tool_calls><||DSML||invoke name="list_mcp_servers"></||DSML||invoke></||DSML||tool_calls>',
      category: 'chat',
      sessionId: 'session-1',
      createdAt: Date.now(),
    }
    useSessionStore.getState().setHistoryMessages([message])

    const { container } = render(<ChatSlot />)
    expect(container.querySelector('.chat-reading-column')).toBeTruthy()

    expect(screen.getByText('我先确认连接。')).toBeTruthy()
    expect(screen.queryByText(/DSML/)).toBeNull()

    const disclosure = screen.getByText('已调用 1 个工具')
    fireEvent.click(disclosure)
    expect(screen.getByText('list_mcp_servers')).toBeTruthy()
  })

  it('removes redundant topbar controls while preserving accessible actions', () => {
    renderWithProviders(<TopBar />)

    expect(screen.queryByTitle('全屏')).toBeNull()
    expect(screen.getByLabelText('打开工作台抽屉')).toBeTruthy()
    expect(screen.getByText('工作台')).toBeTruthy()
  })
})
