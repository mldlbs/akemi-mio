import { describe, it, expect, beforeEach } from 'vitest'
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
})
