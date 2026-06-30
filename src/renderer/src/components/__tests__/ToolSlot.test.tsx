import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ToolSlot } from '../ToolSlot'
import type { ToolEvent } from '../../slots/types'

describe('ToolSlot', () => {
  it('shows empty state when no tools', () => {
    render(<ToolSlot />)
    expect(screen.getByText(/AI 在回答过程中/)).toBeTruthy()
  })

  it('shows running tools with spinner', () => {
    const running: ToolEvent[] = [{ id: 't1', tool: 'search', args: { q: 'test' } }]
    render(<ToolSlot running={running} />)
    expect(screen.getByText('search')).toBeTruthy()
    expect(screen.getByText('执行中')).toBeTruthy()
  })

  it('shows args for running tool', () => {
    const running: ToolEvent[] = [{ id: 't2', tool: 'search', args: { q: 'hello world' } }]
    render(<ToolSlot running={running} />)
    expect(screen.getByText(/"q":"hello world"/)).toBeTruthy()
  })

  it('shows completed tools with latency', () => {
    const completed: ToolEvent[] = [{ id: 't3', tool: 'read_file', latencyMs: 1234 }]
    render(<ToolSlot completed={completed} />)
    expect(screen.getByText('read_file')).toBeTruthy()
    expect(screen.getByText('1.2s')).toBeTruthy()
  })

  it('shows failed tool with error text', () => {
    const completed: ToolEvent[] = [{ id: 't4', tool: 'run_command', latencyMs: 5000, error: 'timeout' }]
    render(<ToolSlot completed={completed} />)
    expect(screen.getByText('timeout')).toBeTruthy()
  })
})
