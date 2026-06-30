import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useWritingStatus } from '../useWritingStatus'
import { createMockIPC } from '../../__tests__/mockIPC'

beforeEach(() => {
  window.electronAPI = createMockIPC() as any
})

describe('useWritingStatus', () => {
  it('loads writing status on mount', async () => {
    window.electronAPI.getWritingStatus = vi.fn().mockResolvedValue({
      stories: [{ id: 's1', title: 'Test Story' }],
      totalStories: 1,
      totalScenes: 5,
    })
    const { result } = renderHook(() => useWritingStatus())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.stories).toHaveLength(1)
    expect(result.current.totalScenes).toBe(5)
  })

  it('handles empty result', async () => {
    window.electronAPI.getWritingStatus = vi.fn().mockResolvedValue({
      stories: [],
      totalStories: 0,
      totalScenes: 0,
    })
    const { result } = renderHook(() => useWritingStatus())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.stories).toEqual([])
    expect(result.current.totalScenes).toBe(0)
  })
})
