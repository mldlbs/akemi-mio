import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { InputBar } from '../InputBar'

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
    render(<InputBar onSend={vi.fn()} agentState="thinking" />)
    expect(screen.getByTitle('停止回复')).toBeTruthy()
    expect(screen.queryByTitle('发送')).toBeNull()
  })

  it('shows stop button when agentState is tool_executing', () => {
    render(<InputBar onSend={vi.fn()} agentState="tool_executing" />)
    expect(screen.getByTitle('停止回复')).toBeTruthy()
  })

  it('shows stop button when agentState is replying', () => {
    render(<InputBar onSend={vi.fn()} agentState="replying" />)
    expect(screen.getByTitle('停止回复')).toBeTruthy()
  })

  it('shows send button when agentState is idle', () => {
    render(<InputBar onSend={vi.fn()} agentState="idle" />)
    expect(screen.queryByTitle('停止回复')).toBeNull()
    expect(screen.getByTitle('发送')).toBeTruthy()
  })

  it('calls stopConversation on stop click', () => {
    render(<InputBar onSend={vi.fn()} agentState="thinking" />)
    fireEvent.click(screen.getByTitle('停止回复'))
    expect(window.electronAPI.stopConversation).toHaveBeenCalled()
  })

  it('renders voiceSlot before textarea', () => {
    const { container } = render(<InputBar onSend={vi.fn()} voiceSlot={<span data-testid="voice-slot" />} />)
    expect(container.querySelector('[data-testid="voice-slot"]')).toBeTruthy()
  })

  it('auto-resizes textarea on input', () => {
    render(<InputBar onSend={vi.fn()} />)
    const textarea = screen.getByPlaceholderText('输入消息…') as HTMLTextAreaElement
    Object.defineProperty(textarea, 'scrollHeight', { value: 60 })
    fireEvent.change(textarea, { target: { value: 'multi\nline\ninput' } })
    expect(textarea.style.height).toBe('60px')
  })

  it('caps textarea height at 120px', () => {
    render(<InputBar onSend={vi.fn()} />)
    const textarea = screen.getByPlaceholderText('输入消息…') as HTMLTextAreaElement
    Object.defineProperty(textarea, 'scrollHeight', { value: 300 })
    fireEvent.change(textarea, { target: { value: 'very long '.repeat(20) } })
    expect(textarea.style.height).toBe('120px')
  })
})
