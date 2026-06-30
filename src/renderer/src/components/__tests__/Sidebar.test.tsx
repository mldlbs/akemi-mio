import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Sidebar } from '../Sidebar'
import type { SessionItem } from '../../slots/types'

const sessions: SessionItem[] = [
  { id: 's1', source: 'electron', category: 'chat', label: 'Chat 1', messageCount: 3, lastActivityAt: Date.now(), createdAt: Date.now() },
  {
    id: 's2',
    source: 'electron',
    category: 'chat',
    label: 'Chat 2',
    messageCount: 1,
    lastActivityAt: Date.now() - 30000,
    createdAt: Date.now() - 60000,
  },
  {
    id: 's3',
    source: 'electron',
    category: 'writing',
    label: 'My Story',
    messageCount: 5,
    lastActivityAt: Date.now() - 100000,
    createdAt: Date.now() - 200000,
  },
]

describe('Sidebar', () => {
  it('shows empty state', () => {
    render(<Sidebar sessions={[]} activeSessionId="" onSelectChat={vi.fn()} />)
    expect(screen.getByText(/暂无会话/)).toBeTruthy()
  })

  it('groups sessions by category', () => {
    render(<Sidebar sessions={sessions} activeSessionId="s1" onSelectChat={vi.fn()} />)
    expect(screen.getByText('聊天')).toBeTruthy()
    expect(screen.getByText('写作')).toBeTruthy()
  })

  it('highlights active session', () => {
    render(<Sidebar sessions={sessions} activeSessionId="s1" onSelectChat={vi.fn()} />)
    const btns = document.querySelectorAll('.sidebar-item')
    expect(btns[0].classList.contains('active')).toBe(true)
    expect(btns[1].classList.contains('active')).toBe(false)
  })

  it('calls onSelectChat on click', () => {
    const onSelect = vi.fn()
    render(<Sidebar sessions={sessions} activeSessionId="" onSelectChat={onSelect} />)
    const btns = document.querySelectorAll('.sidebar-item')
    fireEvent.click(btns[1])
    expect(onSelect).toHaveBeenCalledWith('s2')
  })

  it('shows date groups', () => {
    render(<Sidebar sessions={sessions} activeSessionId="s1" onSelectChat={vi.fn()} />)
    const today = screen.getAllByText('今天')
    expect(today.length).toBeGreaterThanOrEqual(1)
  })
})
