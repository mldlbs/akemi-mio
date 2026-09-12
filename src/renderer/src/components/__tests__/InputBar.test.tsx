import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { InputBar } from '../InputBar'
import { useAgentStore } from '../../store/agentStore'
import { resetAllStores } from '../../store/reset'
import { createMockIPC } from '../../__tests__/mockIPC'

beforeEach(() => {
  resetAllStores()
  window.electronAPI = createMockIPC() as any
})

describe('InputBar', () => {
  it('renders textarea and send button', () => {
    render(<InputBar onSend={vi.fn()} />)
    expect(screen.getByPlaceholderText('输入消息…')).toBeTruthy()
    expect(screen.getByTitle('发送')).toBeTruthy()
  })

  it('send button is disabled when input is empty', () => {
    render(<InputBar onSend={vi.fn()} />)
    const btn = screen.getByTitle('发送') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('send button is enabled when input has text', () => {
    render(<InputBar onSend={vi.fn()} />)
    const textarea = screen.getByPlaceholderText('输入消息…')
    fireEvent.change(textarea, { target: { value: 'hello' } })
    const btn = screen.getByTitle('发送') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })

  it('calls onSend with text and clears input on send click', () => {
    const onSend = vi.fn()
    render(<InputBar onSend={onSend} />)
    const textarea = screen.getByPlaceholderText('输入消息…')
    fireEvent.change(textarea, { target: { value: 'test message' } })
    fireEvent.click(screen.getByTitle('发送'))
    expect(onSend).toHaveBeenCalledWith('test message')
    expect((textarea as HTMLTextAreaElement).value).toBe('')
  })

  it('sends on Enter key without shift', () => {
    const onSend = vi.fn()
    render(<InputBar onSend={onSend} />)
    const textarea = screen.getByPlaceholderText('输入消息…')
    fireEvent.change(textarea, { target: { value: 'enter send' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
    expect(onSend).toHaveBeenCalledWith('enter send')
  })

  it('does NOT send on Shift+Enter', () => {
    const onSend = vi.fn()
    render(<InputBar onSend={onSend} />)
    const textarea = screen.getByPlaceholderText('输入消息…')
    fireEvent.change(textarea, { target: { value: 'shift enter' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('does not send empty or whitespace-only text', () => {
    const onSend = vi.fn()
    render(<InputBar onSend={onSend} />)
    const textarea = screen.getByPlaceholderText('输入消息…')
    fireEvent.change(textarea, { target: { value: '   ' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('shows stop button when agentState is thinking', () => {
    useAgentStore.getState().setAgentState('thinking')
    render(<InputBar onSend={vi.fn()} />)
    expect(screen.getByTitle('停止回复')).toBeTruthy()
    expect(screen.queryByTitle('发送')).toBeNull()
  })

  it('shows stop button when agentState is tool_executing', () => {
    useAgentStore.getState().setAgentState('tool_executing')
    render(<InputBar onSend={vi.fn()} />)
    expect(screen.getByTitle('停止回复')).toBeTruthy()
  })

  it('shows stop button when agentState is replying', () => {
    useAgentStore.getState().setAgentState('replying')
    render(<InputBar onSend={vi.fn()} />)
    expect(screen.getByTitle('停止回复')).toBeTruthy()
  })

  it('shows send button when agentState is idle', () => {
    render(<InputBar onSend={vi.fn()} />)
    expect(screen.queryByTitle('停止回复')).toBeNull()
    expect(screen.getByTitle('发送')).toBeTruthy()
  })

  it('calls stopConversation on stop click', () => {
    useAgentStore.getState().setAgentState('thinking')
    render(<InputBar onSend={vi.fn()} />)
    fireEvent.click(screen.getByTitle('停止回复'))
    expect(window.electronAPI.stopConversation).toHaveBeenCalled()
  })

  it('renders voiceSlot before textarea', () => {
    const { container } = render(<InputBar onSend={vi.fn()} voiceSlot={<span data-testid="voice-slot" />} />)
    expect(container.querySelector('[data-testid="voice-slot"]')).toBeTruthy()
    expect(container.querySelector('.inputbar-utilities')?.contains(container.querySelector('[data-testid="voice-slot"]'))).toBe(true)
  })

  it('renders a voice intent prompt when provided', () => {
    render(
      <InputBar
        onSend={vi.fn()}
        voiceIntentPrompt={{
          text: '打开 README.md',
          intent: {
            name: 'read_file',
            description: '读取文件内容',
            confirmMessage: '将读取文件 README.md',
            toolSequence: [{ tool: 'read_file', args: { path: 'README.md' } }],
            slots: { filename: 'README.md' },
          },
        }}
      />,
    )

    expect(screen.getByText('语音指令候选')).toBeTruthy()
    expect(screen.getByText('读取文件内容')).toBeTruthy()
    expect(screen.getByText('执行指令')).toBeTruthy()
    expect(screen.getByText('当聊天发送')).toBeTruthy()
  })

  it('wires voice intent prompt actions', () => {
    const onConfirmVoiceIntent = vi.fn()
    const onSendVoiceIntentAsChat = vi.fn()
    const onDismissVoiceIntent = vi.fn()

    render(
      <InputBar
        onSend={vi.fn()}
        voiceIntentPrompt={{
          text: '打开 README.md',
          intent: {
            name: 'read_file',
            description: '读取文件内容',
            confirmMessage: '将读取文件 README.md',
            toolSequence: [{ tool: 'read_file', args: { path: 'README.md' } }],
            slots: { filename: 'README.md' },
          },
        }}
        onConfirmVoiceIntent={onConfirmVoiceIntent}
        onSendVoiceIntentAsChat={onSendVoiceIntentAsChat}
        onDismissVoiceIntent={onDismissVoiceIntent}
      />,
    )

    fireEvent.click(screen.getByText('执行指令'))
    fireEvent.click(screen.getByText('当聊天发送'))
    fireEvent.click(screen.getByLabelText('忽略语音指令'))

    expect(onConfirmVoiceIntent).toHaveBeenCalledTimes(1)
    expect(onSendVoiceIntentAsChat).toHaveBeenCalledTimes(1)
    expect(onDismissVoiceIntent).toHaveBeenCalledTimes(1)
  })
})
