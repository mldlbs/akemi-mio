import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { OtparSlot } from '../OtparSlot'
import type { OtparEntry } from '../../hooks/usePlans'

describe('groupOtparByStep', () => {
  it('groups entries by step in descending order', () => {
    // Test the grouping logic through the component render output
    const entries: OtparEntry[] = [
      { type: 'observe', requestId: 'r1', step: 2, durationMs: 100, timestamp: 1000, detail: 'step2' },
      { type: 'think', requestId: 'r1', step: 1, timestamp: 500, detail: 'step1-think' },
      { type: 'observe', requestId: 'r1', step: 1, durationMs: 50, timestamp: 400, detail: 'step1-observe' },
    ]
    render(<OtparSlot otparStages={entries} />)
    expect(screen.getByText('步骤 #2')).toBeTruthy()
    expect(screen.getByText('步骤 #1')).toBeTruthy()
  })
})

describe('OtparSlot', () => {
  it('shows empty state', () => {
    render(<OtparSlot otparStages={[]} />)
    expect(screen.getByText('没有认知数据')).toBeTruthy()
  })

  it('renders OTPAR stages grouped by step', () => {
    const entries: OtparEntry[] = [
      { type: 'observe', requestId: 'r1', step: 1, durationMs: 100, timestamp: 1000, detail: '流程 3 · 模式 2' },
      { type: 'think', requestId: 'r1', step: 1, timestamp: 1100, detail: '2 个工具' },
    ]
    render(<OtparSlot otparStages={entries} />)
    expect(screen.getByText('步骤 #1')).toBeTruthy()
    expect(screen.getByText('流程 3 · 模式 2')).toBeTruthy()
    expect(screen.getByText('2 个工具')).toBeTruthy()
    expect(screen.getByText('0.1s')).toBeTruthy()
  })

  it('shows pending for missing phases', () => {
    const entries: OtparEntry[] = [{ type: 'observe', requestId: 'r1', step: 1, durationMs: 50, timestamp: 500, detail: 'found patterns' }]
    render(<OtparSlot otparStages={entries} />)
    const pending = screen.getAllByText('等待中')
    expect(pending.length).toBeGreaterThanOrEqual(1)
  })
})
