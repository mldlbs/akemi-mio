import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ToolSlot } from '../ToolSlot'
import { resetAllStores } from '../../store/reset'
import { useAgentStore } from '../../store/agentStore'

beforeEach(() => {
  resetAllStores()
})

describe('ToolSlot', () => {
  it('shows empty state when no tools', () => {
    render(<ToolSlot />)
    expect(screen.getByText(/AI 在回答过程中/)).toBeTruthy()
  })

  it('shows running tools with spinner', () => {
    useAgentStore.getState().addToolRunning({ id: 't1', tool: 'search', args: { q: 'test' } })
    render(<ToolSlot />)
    expect(screen.getByText('search')).toBeTruthy()
    expect(screen.getByText('执行中')).toBeTruthy()
  })

  it('shows running count badge', () => {
    useAgentStore.getState().addToolRunning({ id: 't1', tool: 'search', args: { q: 'a' } })
    useAgentStore.getState().addToolRunning({ id: 't2', tool: 'read', args: { path: 'b' } })
    render(<ToolSlot />)
    expect(screen.getByText('2')).toBeTruthy()
  })

  it('shows completed tools with latency', () => {
    useAgentStore.getState().addToolCompleted({ id: 't3', tool: 'read_file', latencyMs: 1234 })
    render(<ToolSlot />)
    expect(screen.getByText('read_file')).toBeTruthy()
    expect(screen.getByText('1.2s')).toBeTruthy()
  })

  it('shows failed tool with error text', () => {
    useAgentStore.getState().addToolCompleted({ id: 't4', tool: 'run_command', latencyMs: 5000, error: 'timeout' })
    render(<ToolSlot />)
    expect(screen.getByText('timeout')).toBeTruthy()
  })

  it('shows cancelled tool with cancelled text', () => {
    useAgentStore.getState().addToolCompleted({ id: 't5', tool: 'search', latencyMs: 2000, cancelled: true })
    render(<ToolSlot />)
    expect(screen.getByText('已取消')).toBeTruthy()
  })

  it('shows timeout tool with timeout text', () => {
    useAgentStore.getState().addToolCompleted({ id: 't6', tool: 'search', latencyMs: 30000, timeout: true })
    render(<ToolSlot />)
    expect(screen.getByText('超时')).toBeTruthy()
  })

  it('shows cancel button on running tools', () => {
    useAgentStore.getState().addToolRunning({ id: 't1', tool: 'search', args: { q: 'test' } })
    render(<ToolSlot />)
    const cancelBtn = screen.getByTitle('取消此工具')
    expect(cancelBtn).toBeTruthy()
  })

  it('calls stopConversation on cancel click', () => {
    const spy = vi.spyOn(window.electronAPI, 'stopConversation')
    useAgentStore.getState().addToolRunning({ id: 't1', tool: 'search', args: { q: 'test' } })
    render(<ToolSlot />)
    screen.getByTitle('取消此工具').click()
    expect(spy).toHaveBeenCalled()
  })

  it('shows collapsible toggle for long args', () => {
    const longArgs = { data: 'x'.repeat(200) }
    useAgentStore.getState().addToolRunning({ id: 't1', tool: 'search', args: longArgs })
    render(<ToolSlot />)
    expect(screen.getByText('展开')).toBeTruthy()
  })

  it('does not show collapsible toggle for short args', () => {
    useAgentStore.getState().addToolRunning({ id: 't1', tool: 'search', args: { q: 'short' } })
    render(<ToolSlot />)
    expect(screen.queryByText('展开')).toBeNull()
  })

  it('shows completed count badge', () => {
    useAgentStore.getState().addToolCompleted({ id: 't1', tool: 'search' })
    useAgentStore.getState().addToolCompleted({ id: 't2', tool: 'read' })
    render(<ToolSlot />)
    expect(screen.getByText('已执行')).toBeTruthy()
  })

  it('shows elapsed timer with 00:00 initially', () => {
    useAgentStore.getState().addToolRunning({ id: 't1', tool: 'search', startedAt: Date.now() })
    render(<ToolSlot />)
    expect(screen.getByText('00:00')).toBeTruthy()
  })
})
