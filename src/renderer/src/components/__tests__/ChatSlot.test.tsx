import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ChatSlot } from '../ChatSlot'
import type { MessageItem, ToolEvent } from '../../slots/types'

const messages: MessageItem[] = [
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

describe('ChatSlot', () => {
  it('shows loading state', () => {
    render(<ChatSlot messages={[]} historyLoading={true} toolStatus={null} agentState="idle" toolRunning={[]} toolCompleted={[]} />)
    expect(screen.getByText('加载中…')).toBeTruthy()
  })

  it('shows empty state', () => {
    render(<ChatSlot messages={[]} toolStatus={null} agentState="idle" toolRunning={[]} toolCompleted={[]} />)
    expect(screen.getByText('开始一段新对话')).toBeTruthy()
  })

  it('renders messages for user and assistant', () => {
    render(<ChatSlot messages={messages} toolStatus={null} agentState="idle" toolRunning={[]} toolCompleted={[]} />)
    expect(screen.getByText('Hello')).toBeTruthy()
    expect(screen.getByText('Hi there!')).toBeTruthy()
  })

  it('shows transcribed user bubble', () => {
    render(<ChatSlot messages={[]} transcribed="voice input" toolStatus={null} agentState="idle" toolRunning={[]} toolCompleted={[]} />)
    expect(screen.getByText('voice input')).toBeTruthy()
  })

  it('shows agent indicator for thinking state', () => {
    render(<ChatSlot messages={[]} toolStatus={null} agentState="thinking" toolRunning={[]} toolCompleted={[]} />)
    expect(screen.getByText('思考中…')).toBeTruthy()
  })

  it('does NOT show agent indicator for idle state', () => {
    const { container } = render(<ChatSlot messages={[]} toolStatus={null} agentState="idle" toolRunning={[]} toolCompleted={[]} />)
    expect(container.querySelector('.agent-indicator')).toBeNull()
  })

  it('shows pending text', () => {
    render(
      <ChatSlot messages={[]} pendingText="streaming reply" toolStatus={null} agentState="replying" toolRunning={[]} toolCompleted={[]} />,
    )
    expect(screen.getByText('streaming reply')).toBeTruthy()
  })

  it('shows running tools with collapsible group', () => {
    const running: ToolEvent[] = [{ id: 't1', tool: 'read_file', args: { path: '/src/index.ts' } }]
    render(<ChatSlot messages={[]} toolStatus={null} agentState="tool_executing" toolRunning={running} toolCompleted={[]} />)
    expect(screen.getAllByText('读取文件').length).toBeGreaterThanOrEqual(1)
  })

  it('shows completed tools with latency', () => {
    const completed: ToolEvent[] = [{ id: 't2', tool: 'write_file', latencyMs: 500 }]
    render(<ChatSlot messages={[]} toolStatus={null} agentState="idle" toolRunning={[]} toolCompleted={completed} />)
    expect(screen.getByText('0.5s')).toBeTruthy()
  })

  it('shows tool summary for multiple tools', () => {
    const running: ToolEvent[] = [
      { id: 't1', tool: 'read_file', args: {} },
      { id: 't2', tool: 'edit_file', args: {} },
    ]
    render(<ChatSlot messages={[]} toolStatus={null} agentState="tool_executing" toolRunning={running} toolCompleted={[]} />)
    expect(screen.getByText('读取文件、编辑文件')).toBeTruthy()
  })
})
