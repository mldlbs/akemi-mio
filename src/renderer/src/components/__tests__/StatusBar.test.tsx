import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusBar } from '../StatusBar'

describe('StatusBar', () => {
  it('shows "待命" when idle', () => {
    render(<StatusBar conversationActive={false} />)
    expect(screen.getByText('待命')).toBeTruthy()
  })

  it('shows "正在聆听" when conversation is active', () => {
    render(<StatusBar conversationActive={true} />)
    expect(screen.getByText('正在聆听')).toBeTruthy()
  })

  it('shows "思考中" when agentState is thinking', () => {
    render(<StatusBar conversationActive={false} agentState="thinking" />)
    expect(screen.getByText('思考中')).toBeTruthy()
  })

  it('shows "执行工具" when agentState is tool_executing', () => {
    render(<StatusBar conversationActive={false} agentState="tool_executing" />)
    expect(screen.getByText('执行工具')).toBeTruthy()
  })

  it('shows "回复中" when ttsPlaying', () => {
    render(<StatusBar conversationActive={false} ttsPlaying={true} />)
    expect(screen.getByText('回复中')).toBeTruthy()
  })

  it('shows health display when sessionHealth is provided', () => {
    render(<StatusBar conversationActive={false} sessionHealth="85:HEALTHY:memory" />)
    expect(screen.getByText('85 HEALTHY')).toBeTruthy()
  })

  it('does NOT show health when sessionHealth is missing', () => {
    const { container } = render(<StatusBar conversationActive={false} />)
    expect(container.querySelector('.status-health')).toBeNull()
  })

  it('shows persona badge for non-core levels', () => {
    render(<StatusBar conversationActive={false} personaLevel="writer" />)
    expect(screen.getByText('写作')).toBeTruthy()
  })

  it('does NOT show persona badge for core level', () => {
    const { container } = render(<StatusBar conversationActive={false} personaLevel="core" />)
    expect(container.querySelector('.persona-badge')).toBeNull()
  })

  it('shows error text when provided', () => {
    render(<StatusBar conversationActive={false} error="Something went wrong" />)
    expect(screen.getByText('Something went wrong')).toBeTruthy()
  })
})
