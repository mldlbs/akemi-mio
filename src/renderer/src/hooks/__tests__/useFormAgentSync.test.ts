/**
 * useFormAgentSync 的单元测试。
 *
 * 这个 hook 的意义：主壳的 agent 状态（thinking / tool_executing / replying / idle）
 * 只存在于 zustand store 里，宠物看不见。它负责把状态变化广播出去，
 * 让宠物能覆盖"用户发问 → 第一个字出现"之间的空窗期。
 *
 * 重点验证"订阅式"而非"逐点调用"的正确性：
 * 状态一变就必须广播，且不能因为 store 其它字段变化而误发。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const broadcastSpy = vi.fn()

vi.mock('../../forms/runtime', () => ({
  broadcast: (...args: unknown[]) => broadcastSpy(...args),
}))

async function loadHook() {
  vi.resetModules()
  const { useAgentStore } = await import('../../store/agentStore')
  const { useFormAgentSync } = await import('../useFormAgentSync')
  return { useAgentStore, useFormAgentSync }
}

/** 把 store 恢复到 idle，避免用例间互相污染。 */
async function resetStore(useAgentStore: Awaited<ReturnType<typeof loadHook>>['useAgentStore']) {
  act(() => {
    useAgentStore.getState().resetAgent()
    useAgentStore.setState({ agentState: 'idle' })
  })
}

beforeEach(() => {
  broadcastSpy.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useFormAgentSync', () => {
  it('挂载时不广播（避免首帧冗余事件）', async () => {
    const { useAgentStore, useFormAgentSync } = await loadHook()
    await resetStore(useAgentStore)
    renderHook(() => useFormAgentSync())
    expect(broadcastSpy).not.toHaveBeenCalled()
  })

  it('状态变为 thinking 时广播', async () => {
    const { useAgentStore, useFormAgentSync } = await loadHook()
    await resetStore(useAgentStore)
    renderHook(() => useFormAgentSync())

    act(() => {
      useAgentStore.setState({ agentState: 'thinking' })
    })

    expect(broadcastSpy).toHaveBeenCalledWith('agent:state', { state: 'thinking' })
  })

  it('tool_executing 映射为 tool', async () => {
    const { useAgentStore, useFormAgentSync } = await loadHook()
    await resetStore(useAgentStore)
    renderHook(() => useFormAgentSync())

    act(() => {
      useAgentStore.setState({ agentState: 'tool_executing' })
    })

    expect(broadcastSpy).toHaveBeenCalledWith('agent:state', { state: 'tool' })
  })

  it('replying 映射为 replying', async () => {
    const { useAgentStore, useFormAgentSync } = await loadHook()
    await resetStore(useAgentStore)
    renderHook(() => useFormAgentSync())

    act(() => {
      useAgentStore.setState({ agentState: 'replying' })
    })

    expect(broadcastSpy).toHaveBeenCalledWith('agent:state', { state: 'replying' })
  })

  it('回到 idle 时广播 idle', async () => {
    const { useAgentStore, useFormAgentSync } = await loadHook()
    await resetStore(useAgentStore)
    renderHook(() => useFormAgentSync())

    act(() => {
      useAgentStore.setState({ agentState: 'thinking' })
    })
    broadcastSpy.mockClear()

    act(() => {
      useAgentStore.setState({ agentState: 'idle' })
    })
    expect(broadcastSpy).toHaveBeenCalledWith('agent:state', { state: 'idle' })
  })

  it('相同状态重复设置只广播一次（去重）', async () => {
    const { useAgentStore, useFormAgentSync } = await loadHook()
    await resetStore(useAgentStore)
    renderHook(() => useFormAgentSync())

    act(() => {
      useAgentStore.setState({ agentState: 'thinking' })
      useAgentStore.setState({ agentState: 'thinking' })
      useAgentStore.setState({ agentState: 'thinking' })
    })

    expect(broadcastSpy).toHaveBeenCalledTimes(1)
  })

  it('store 其它字段变化不触发广播', async () => {
    const { useAgentStore, useFormAgentSync } = await loadHook()
    await resetStore(useAgentStore)
    renderHook(() => useFormAgentSync())

    act(() => {
      // 改 pendingText 等字段，agentState 不变
      useAgentStore.setState({ pendingText: '某段文字', displayText: '显示中' })
    })

    expect(broadcastSpy).not.toHaveBeenCalled()
  })

  it('完整状态流转产生对应广播序列', async () => {
    const { useAgentStore, useFormAgentSync } = await loadHook()
    await resetStore(useAgentStore)
    renderHook(() => useFormAgentSync())

    act(() => {
      useAgentStore.setState({ agentState: 'thinking' })
    })
    act(() => {
      useAgentStore.setState({ agentState: 'tool_executing' })
    })
    act(() => {
      useAgentStore.setState({ agentState: 'replying' })
    })
    act(() => {
      useAgentStore.setState({ agentState: 'idle' })
    })

    expect(broadcastSpy.mock.calls.map((c) => c[1])).toEqual([
      { state: 'thinking' },
      { state: 'tool' },
      { state: 'replying' },
      { state: 'idle' },
    ])
  })

  it('卸载后停止广播（防止监听器泄漏）', async () => {
    const { useAgentStore, useFormAgentSync } = await loadHook()
    await resetStore(useAgentStore)
    const { unmount } = renderHook(() => useFormAgentSync())

    act(() => {
      useAgentStore.setState({ agentState: 'thinking' })
    })
    expect(broadcastSpy).toHaveBeenCalledTimes(1)

    unmount()
    broadcastSpy.mockClear()

    act(() => {
      useAgentStore.setState({ agentState: 'replying' })
    })
    expect(broadcastSpy).not.toHaveBeenCalled()
  })
})
