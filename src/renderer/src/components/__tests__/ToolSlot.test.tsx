import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ToolSlot } from '../ToolSlot'
import { resetAllStores } from '../../store/reset'
import { useAgentStore } from '../../store/agentStore'
import { useClockStore } from '../../store/clockStore'

beforeEach(() => {
  resetAllStores()
})

function addRunningTool(id: string, tool: string, args?: Record<string, any>) {
  const now = Date.now()
  useAgentStore.getState().addTool({
    type: 'tool.started',
    id,
    tool,
    args,
    timestamp: now,
  })
}

function addCompletedTool(id: string, tool: string, overrides?: { latencyMs?: number; error?: string }) {
  // Need to start the tool first
  addRunningTool(id, tool)
  if (overrides?.error) {
    useAgentStore.getState().addTool({
      type: 'tool.failed',
      id,
      error: overrides.error,
      latencyMs: overrides.latencyMs ?? 1000,
      timestamp: Date.now(),
    })
  } else {
    useAgentStore.getState().addTool({
      type: 'tool.succeeded',
      id,
      result: 'ok',
      latencyMs: overrides?.latencyMs ?? 1000,
      timestamp: Date.now(),
    })
  }
}

describe('ToolSlot', () => {
  it('shows empty state when no tools', () => {
    render(<ToolSlot />)
    expect(screen.getByText(/AI 在回答过程中/)).toBeTruthy()
  })

  it('shows running tools with spinner', () => {
    addRunningTool('t1', 'search', { q: 'test' })
    render(<ToolSlot />)
    expect(screen.getByText('search')).toBeTruthy()
    expect(screen.getByText('执行中')).toBeTruthy()
  })

  it('shows running count badge', () => {
    addRunningTool('t1', 'search', { q: 'a' })
    addRunningTool('t2', 'read', { path: 'b' })
    render(<ToolSlot />)
    expect(screen.getByText('2')).toBeTruthy()
  })

  it('shows completed tools with latency', () => {
    addCompletedTool('t3', 'read_file', { latencyMs: 1234 })
    render(<ToolSlot />)
    expect(screen.getByText('read_file')).toBeTruthy()
    expect(screen.getByText('1.2s')).toBeTruthy()
  })

  it('shows failed tool with error text', () => {
    addCompletedTool('t4', 'run_command', { latencyMs: 5000, error: 'timeout' })
    render(<ToolSlot />)
    expect(screen.getByText('timeout')).toBeTruthy()
  })

  it('shows cancelled tool with cancelled text', () => {
    const now = Date.now()
    useAgentStore.getState().addTool({
      type: 'tool.started',
      id: 't5',
      tool: 'search',
      timestamp: now - 2000,
    })
    useAgentStore.getState().addTool({
      type: 'tool.cancelled',
      id: 't5',
      latencyMs: 2000,
      timestamp: now,
    })
    render(<ToolSlot />)
    expect(screen.getByText('已取消')).toBeTruthy()
  })

  it('shows timeout tool with timeout text', () => {
    const now = Date.now()
    useAgentStore.getState().addTool({
      type: 'tool.started',
      id: 't6',
      tool: 'search',
      timestamp: now - 30000,
    })
    useAgentStore.getState().addTool({
      type: 'tool.timedout',
      id: 't6',
      latencyMs: 30000,
      timestamp: now,
    })
    render(<ToolSlot />)
    expect(screen.getByText('超时')).toBeTruthy()
  })

  it('shows cancel button on running tools', () => {
    addRunningTool('t1', 'search', { q: 'test' })
    render(<ToolSlot />)
    const cancelBtn = screen.getByTitle('取消此工具')
    expect(cancelBtn).toBeTruthy()
  })

  it('calls stopConversation on cancel click', () => {
    const spy = vi.spyOn(window.electronAPI, 'stopConversation')
    addRunningTool('t1', 'search', { q: 'test' })
    render(<ToolSlot />)
    screen.getByTitle('取消此工具').click()
    expect(spy).toHaveBeenCalled()
  })

  it('shows collapsible toggle for long args', () => {
    const longArgs = { data: 'x'.repeat(200) }
    addRunningTool('t1', 'search', longArgs)
    render(<ToolSlot />)
    expect(screen.getByText('展开')).toBeTruthy()
  })

  it('does not show collapsible toggle for short args', () => {
    addRunningTool('t1', 'search', { q: 'short' })
    render(<ToolSlot />)
    expect(screen.queryByText('展开')).toBeNull()
  })

  it('shows completed count badge', () => {
    addCompletedTool('t1', 'search')
    addCompletedTool('t2', 'read')
    render(<ToolSlot />)
    expect(screen.getByText('已执行')).toBeTruthy()
  })

  it('shows elapsed timer with 00:00 when startedAt equals now', () => {
    useClockStore.setState({ now: 50000 })
    useAgentStore.getState().addTool({
      type: 'tool.started',
      id: 't1',
      tool: 'search',
      timestamp: 50000,
    })
    render(<ToolSlot />)
    expect(screen.getByText('00:00')).toBeTruthy()
  })
})
