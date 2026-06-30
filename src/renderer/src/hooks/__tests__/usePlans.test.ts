import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePlans } from '../usePlans'
import { createMockIPC } from '../../__tests__/mockIPC'

beforeEach(() => {
  window.electronAPI = createMockIPC() as any
})

describe('usePlans', () => {
  it('loads active plan and plan history on mount', async () => {
    const activePlan = {
      id: 'p1',
      title: 'Fix bug',
      description: '',
      steps: [],
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const allPlans = [
      activePlan,
      { id: 'p2', title: 'Done', description: '', steps: [], status: 'completed', createdAt: Date.now(), updatedAt: Date.now() },
    ]
    window.electronAPI.getActivePlan = vi.fn().mockResolvedValue(activePlan)
    window.electronAPI.listPlans = vi.fn().mockResolvedValue(allPlans) as any

    const { result } = renderHook(() => usePlans())
    await vi.waitFor(() => expect(result.current.activePlan).not.toBeNull())
    expect(result.current.activePlan?.title).toBe('Fix bug')
    expect(result.current.planHistory).toHaveLength(1)
    expect(result.current.planHistory[0].title).toBe('Done')
  })

  it('updates active plan step status on onPlanStep', async () => {
    const activePlan = {
      id: 'p1',
      title: 'Plan',
      description: '',
      steps: [{ id: 's1', description: 'Step 1', status: 'pending' }],
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    window.electronAPI.getActivePlan = vi.fn().mockResolvedValue(activePlan)
    window.electronAPI.listPlans = vi.fn().mockResolvedValue([])

    let onStepHandler: Function = () => {}
    window.electronAPI.onPlanStep = vi.fn().mockImplementation((cb: Function) => {
      onStepHandler = cb
      return vi.fn()
    }) as any

    const { result } = renderHook(() => usePlans())
    await vi.waitFor(() => expect(result.current.activePlan).not.toBeNull())
    act(() => {
      onStepHandler({ planId: 'p1', stepIndex: 0, status: 'completed' })
    })
    expect(result.current.activePlan?.steps[0].status).toBe('completed')
  })

  it('marks plan completed on onPlanCompleted', async () => {
    const activePlan = {
      id: 'p1',
      title: 'Plan',
      description: '',
      steps: [],
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    window.electronAPI.getActivePlan = vi.fn().mockResolvedValue(activePlan)
    window.electronAPI.listPlans = vi.fn().mockResolvedValue([])

    let onCompletedHandler: Function = () => {}
    window.electronAPI.onPlanCompleted = vi.fn().mockImplementation((cb: Function) => {
      onCompletedHandler = cb
      return vi.fn()
    }) as any

    const { result } = renderHook(() => usePlans())
    await vi.waitFor(() => expect(result.current.activePlan).not.toBeNull())
    act(() => {
      onCompletedHandler({ planId: 'p1' })
    })
    expect(result.current.activePlan?.status).toBe('completed')
  })

  it('collects OTPAR entries with max 20 limit', () => {
    let onObserveHandler: Function = () => {}
    window.electronAPI.getActivePlan = vi.fn().mockResolvedValue(null)
    window.electronAPI.listPlans = vi.fn().mockResolvedValue([])
    window.electronAPI.onAgentObserve = vi.fn().mockImplementation((cb: Function) => {
      onObserveHandler = cb
      return vi.fn()
    }) as any

    const { result } = renderHook(() => usePlans())
    for (let i = 0; i < 25; i++) {
      act(() => {
        onObserveHandler({ requestId: `r${i}`, step: i, proceduresFound: i, patternsFound: 0, durationMs: 100 })
      })
    }
    expect(result.current.otparStages).toHaveLength(20)
  })
})
