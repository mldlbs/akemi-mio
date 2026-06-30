import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useWorkflowDefinitions } from '../useWorkflowDefinitions'
import { createMockIPC } from '../../__tests__/mockIPC'

beforeEach(() => {
  window.electronAPI = createMockIPC() as any
})

describe('useWorkflowDefinitions', () => {
  it('loads definitions and runs on mount', async () => {
    const defs = [{ id: 'w1', name: 'Test WF', description: '', steps: [], createdAt: Date.now(), updatedAt: Date.now() }]
    const runs = [{ runId: 'r1', workflowDefId: 'w1', workflowName: 'Test WF', status: 'completed', steps: [], startedAt: Date.now() }]
    window.electronAPI.listWorkflowDefinitions = vi.fn().mockResolvedValue(defs)
    window.electronAPI.listWorkflowRuns = vi.fn().mockResolvedValue(runs)

    const { result } = renderHook(() => useWorkflowDefinitions())
    await vi.waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.definitions).toHaveLength(1)
    expect(result.current.runs).toHaveLength(1)
  })

  it('prepends new run on onWorkflowRunCreated', () => {
    let onCreateHandler: Function = () => {}
    window.electronAPI.onWorkflowRunCreated = vi.fn().mockImplementation((cb: Function) => {
      onCreateHandler = cb
      return vi.fn()
    }) as any

    const { result } = renderHook(() => useWorkflowDefinitions())
    act(() => {
      onCreateHandler({ runId: 'r2', workflowDefId: 'w1', workflowName: 'New Run', steps: [], startedAt: Date.now() })
    })
    expect(result.current.runs).toHaveLength(1)
    expect(result.current.runs[0].runId).toBe('r2')
    expect(result.current.runs[0].status).toBe('running')
  })

  it('does not duplicate existing run', () => {
    let onCreateHandler: Function = () => {}
    window.electronAPI.onWorkflowRunCreated = vi.fn().mockImplementation((cb: Function) => {
      onCreateHandler = cb
      return vi.fn()
    }) as any

    const { result } = renderHook(() => useWorkflowDefinitions())
    act(() => {
      onCreateHandler({ runId: 'r1', workflowDefId: 'w1', workflowName: 'Run', steps: [], startedAt: Date.now() })
    })
    act(() => {
      onCreateHandler({ runId: 'r1', workflowDefId: 'w1', workflowName: 'Run', steps: [], startedAt: Date.now() })
    })
    expect(result.current.runs).toHaveLength(1)
  })

  it('updates run status on onWorkflowRunUpdated', () => {
    let onCreateHandler: Function = () => {}
    let onUpdateHandler: Function = () => {}
    window.electronAPI.onWorkflowRunCreated = vi.fn().mockImplementation((cb: Function) => {
      onCreateHandler = cb
      return vi.fn()
    }) as any
    window.electronAPI.onWorkflowRunUpdated = vi.fn().mockImplementation((cb: Function) => {
      onUpdateHandler = cb
      return vi.fn()
    }) as any

    const { result } = renderHook(() => useWorkflowDefinitions())
    act(() => {
      onCreateHandler({ runId: 'r1', workflowDefId: 'w1', workflowName: 'Run', steps: [], startedAt: Date.now() })
    })
    act(() => {
      onUpdateHandler({ runId: 'r1', status: 'completed' })
    })
    expect(result.current.runs[0].status).toBe('completed')
  })

  it('updates step status on onWorkflowRunStep', () => {
    let onCreateHandler: Function = () => {}
    let onStepHandler: Function = () => {}
    window.electronAPI.onWorkflowRunCreated = vi.fn().mockImplementation((cb: Function) => {
      onCreateHandler = cb
      return vi.fn()
    }) as any
    window.electronAPI.onWorkflowRunStep = vi.fn().mockImplementation((cb: Function) => {
      onStepHandler = cb
      return vi.fn()
    }) as any

    const { result } = renderHook(() => useWorkflowDefinitions())
    act(() => {
      onCreateHandler({
        runId: 'r1',
        workflowDefId: 'w1',
        workflowName: 'WF',
        steps: [{ stepId: 's1', status: 'running' }],
        startedAt: Date.now(),
      })
    })
    act(() => {
      onStepHandler({ runId: 'r1', stepId: 's1', status: 'completed', agentResult: 'done' })
    })
    expect(result.current.runs[0].steps[0].status).toBe('completed')
    expect(result.current.runs[0].steps[0].agentResult).toBe('done')
  })

  it('computes activeRuns from running runs', () => {
    let onCreateHandler: Function = () => {}
    let onUpdateHandler: Function = () => {}
    window.electronAPI.onWorkflowRunCreated = vi.fn().mockImplementation((cb: Function) => {
      onCreateHandler = cb
      return vi.fn()
    }) as any
    window.electronAPI.onWorkflowRunUpdated = vi.fn().mockImplementation((cb: Function) => {
      onUpdateHandler = cb
      return vi.fn()
    }) as any

    const { result } = renderHook(() => useWorkflowDefinitions())
    // Create two runs
    act(() => {
      onCreateHandler({ runId: 'r1', workflowDefId: 'w1', workflowName: 'Running', steps: [], startedAt: Date.now() })
    })
    act(() => {
      onCreateHandler({ runId: 'r2', workflowDefId: 'w1', workflowName: 'Done', steps: [], startedAt: Date.now() })
    })
    // Mark r2 as completed
    act(() => {
      onUpdateHandler({ runId: 'r2', status: 'completed' })
    })
    expect(result.current.activeRuns).toHaveLength(1)
    expect(result.current.activeRuns[0].runId).toBe('r1')
  })
})
