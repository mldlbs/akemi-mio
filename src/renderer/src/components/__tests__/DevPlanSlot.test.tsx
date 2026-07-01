import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DevPlanSlot } from '../DevPlanSlot'
import { resetAllStores } from '../../store/reset'
import { usePlansStore } from '../../store/plansStore'

beforeEach(() => {
  resetAllStores()
})

const mockPlan = {
  id: 'p1',
  title: 'Fix the bug',
  description: 'A plan to fix something',
  status: 'in_progress',
  steps: [
    { id: 's1', description: 'Investigate', status: 'done' },
    { id: 's2', description: 'Implement fix', status: 'in_progress' },
    { id: 's3', description: 'Test', status: 'pending', result: 'all tests pass' },
  ],
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

describe('DevPlanSlot', () => {
  it('shows empty state when no activePlan', () => {
    render(<DevPlanSlot />)
    expect(screen.getByText('当前没有活跃的开发计划')).toBeTruthy()
  })

  it('renders plan title and status from store', () => {
    usePlansStore.getState().setActivePlan(mockPlan)
    render(<DevPlanSlot />)
    expect(screen.getByText('Fix the bug')).toBeTruthy()
    expect(screen.getByText('进行中')).toBeTruthy()
  })

  it('shows step count progress', () => {
    usePlansStore.getState().setActivePlan(mockPlan)
    render(<DevPlanSlot />)
    expect(screen.getByText('1/3 步')).toBeTruthy()
  })

  it('renders all steps', () => {
    usePlansStore.getState().setActivePlan(mockPlan)
    render(<DevPlanSlot />)
    expect(screen.getByText('#1')).toBeTruthy()
    expect(screen.getByText('Investigate')).toBeTruthy()
    expect(screen.getByText('#2')).toBeTruthy()
    expect(screen.getByText('#3')).toBeTruthy()
  })

  it('shows result text for completed step', () => {
    usePlansStore.getState().setActivePlan(mockPlan)
    render(<DevPlanSlot />)
    expect(screen.getByText('all tests pass')).toBeTruthy()
  })
})
