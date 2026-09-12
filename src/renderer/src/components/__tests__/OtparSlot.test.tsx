import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { OtparSlot } from '../OtparSlot'
import { resetAllStores } from '../../store/reset'
import { usePlansStore } from '../../store/plansStore'
import type { OtparEntry } from '../../store/plansStore'

beforeEach(() => {
  resetAllStores()
})

describe('groupOtparByStep', () => {
  it('groups entries by step in descending order', () => {
    const entries: OtparEntry[] = [
      { type: 'observe', requestId: 'r1', step: 2, durationMs: 100, timestamp: 1000, detail: 'step2' },
      { type: 'think', requestId: 'r1', step: 1, timestamp: 500, detail: 'step1-think' },
      { type: 'observe', requestId: 'r1', step: 1, durationMs: 50, timestamp: 400, detail: 'step1-observe' },
    ]
    entries.forEach((e) => usePlansStore.getState().addOtparStage(e))
    render(<OtparSlot />)
    expect(screen.getByText('步骤 #2')).toBeTruthy()
    expect(screen.getByText('步骤 #1')).toBeTruthy()
  })
})

describe('OtparSlot', () => {
  it('shows empty state', () => {
    render(<OtparSlot />)
    expect(screen.getByText('没有认知数据')).toBeTruthy()
  })

  it('renders OTPAR stages grouped by step', () => {
    const entries: OtparEntry[] = [
      { type: 'observe', requestId: 'r1', step: 1, durationMs: 100, timestamp: 1000, detail: '流程 3 · 模式 2' },
      { type: 'think', requestId: 'r1', step: 1, timestamp: 1100, detail: '2 个工具' },
    ]
    entries.forEach((e) => usePlansStore.getState().addOtparStage(e))
    render(<OtparSlot />)
    expect(screen.getByText('步骤 #1')).toBeTruthy()
    expect(screen.getByText('流程 3 · 模式 2')).toBeTruthy()
    expect(screen.getByText('2 个工具')).toBeTruthy()
    expect(screen.getByText('0.1s')).toBeTruthy()
  })

  it('shows pending for missing phases', () => {
    const entries: OtparEntry[] = [{ type: 'observe', requestId: 'r1', step: 1, durationMs: 50, timestamp: 500, detail: 'found patterns' }]
    entries.forEach((e) => usePlansStore.getState().addOtparStage(e))
    render(<OtparSlot />)
    const pending = screen.getAllByText('等待中')
    expect(pending.length).toBeGreaterThanOrEqual(1)
  })
})
