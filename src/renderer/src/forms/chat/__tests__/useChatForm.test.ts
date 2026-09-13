/**
 * useChatForm 的单元测试。
 *
 * 这个 hook 是对话框形态的全部业务逻辑，重点验证：
 * 1. 空输入/发送中不得重复发起（防止连点 Enter 打出多条消息）。
 * 2. 桥接可用时走真实调用，不可用时降级为本地回声（保证 UI 流程完整）。
 * 3. 异常必须落到气泡里而非静默失败 —— 用户得知道出错了。
 * 4. 广播时序：thinking 先于回复、reply/error 必发一次。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

/** 每个用例都重新加载模块，避免模块级 seq 跨用例串号。 */
async function loadHook() {
  vi.resetModules()
  const mod = await import('../useChatForm')
  return mod.useChatForm
}

function installBridge(api: Record<string, unknown>) {
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = api
}

function clearBridge() {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
  delete (window as unknown as { electron?: unknown }).electron
}

/** 记录广播调用顺序，用于断言时序。 */
const broadcastCalls: { type: string; payload: unknown }[] = []

vi.mock('../../runtime', () => ({
  broadcast: (type: string, payload: unknown) => {
    broadcastCalls.push({ type, payload })
  },
}))

beforeEach(() => {
  broadcastCalls.length = 0
  clearBridge()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useChatForm', () => {
  it('初始为空且不在发送', async () => {
    const useChatForm = await loadHook()
    const { result } = renderHook(() => useChatForm())
    expect(result.current.messages).toEqual([])
    expect(result.current.sending).toBe(false)
  })

  it('空白输入不产生任何消息', async () => {
    const useChatForm = await loadHook()
    const { result } = renderHook(() => useChatForm())
    await act(async () => {
      await result.current.send('   ')
    })
    expect(result.current.messages).toEqual([])
    expect(broadcastCalls).toEqual([])
  })

  it('桥接可用时走 invoke 并渲染回复', async () => {
    const invoke = vi.fn().mockResolvedValue({ text: '你好呀' })
    installBridge({ invoke })
    const useChatForm = await loadHook()
    const { result } = renderHook(() => useChatForm())

    await act(async () => {
      await result.current.send('在吗')
    })

    expect(invoke).toHaveBeenCalledWith('chat:send', { text: '在吗', form: 'chat' })
    const msgs = result.current.messages
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toMatchObject({ role: 'user', text: '在吗' })
    expect(msgs[1]).toMatchObject({ role: 'assistant', text: '你好呀', streaming: false })
    expect(result.current.sending).toBe(false)
  })

  it('支持字符串形式的回复', async () => {
    installBridge({ invoke: vi.fn().mockResolvedValue('纯字符串回复') })
    const useChatForm = await loadHook()
    const { result } = renderHook(() => useChatForm())
    await act(async () => {
      await result.current.send('hi')
    })
    expect(result.current.messages[1].text).toBe('纯字符串回复')
  })

  it('无桥接时降级为本地回声，流程仍完整', async () => {
    const useChatForm = await loadHook()
    const { result } = renderHook(() => useChatForm())
    await act(async () => {
      await result.current.send('测试')
    })
    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[1].text).toContain('预览模式')
    expect(result.current.messages[1].text).toContain('测试')
  })

  it('桥接抛错时错误写入气泡而非静默失败', async () => {
    installBridge({ invoke: vi.fn().mockRejectedValue(new Error('连接断开')) })
    const useChatForm = await loadHook()
    const { result } = renderHook(() => useChatForm())

    await act(async () => {
      await result.current.send('会失败')
    })

    expect(result.current.messages[1].text).toContain('连接断开')
    expect(result.current.sending).toBe(false)
    expect(broadcastCalls.some((c) => c.type === 'chat:error')).toBe(true)
  })

  it('广播时序：thinking 先于 reply', async () => {
    installBridge({ invoke: vi.fn().mockResolvedValue({ text: 'ok' }) })
    const useChatForm = await loadHook()
    const { result } = renderHook(() => useChatForm())
    await act(async () => {
      await result.current.send('hi')
    })

    const types = broadcastCalls.map((c) => c.type)
    expect(types).toContain('chat:thinking')
    expect(types).toContain('chat:reply')
    expect(types.indexOf('chat:thinking')).toBeLessThan(types.indexOf('chat:reply'))
  })

  it('发送中重复调用被忽略', async () => {
    // 用一个不立即 resolve 的 promise 卡住发送态
    let release: (v: unknown) => void = () => {}
    const invoke = vi.fn().mockImplementation(
      () =>
        new Promise((res) => {
          release = res
        }),
    )
    installBridge({ invoke })
    const useChatForm = await loadHook()
    const { result } = renderHook(() => useChatForm())

    let firstCall: Promise<void> = Promise.resolve()
    act(() => {
      firstCall = result.current.send('第一条')
    })
    await waitFor(() => expect(result.current.sending).toBe(true))

    // 发送中的第二次调用应当被拒绝
    await act(async () => {
      await result.current.send('第二条')
    })
    expect(result.current.messages.filter((m) => m.role === 'user')).toHaveLength(1)

    await act(async () => {
      release({ text: 'done' })
      await firstCall
    })
    expect(result.current.sending).toBe(false)
  })

  it('clear 清空全部消息', async () => {
    installBridge({ invoke: vi.fn().mockResolvedValue({ text: 'ok' }) })
    const useChatForm = await loadHook()
    const { result } = renderHook(() => useChatForm())
    await act(async () => {
      await result.current.send('hi')
    })
    expect(result.current.messages).toHaveLength(2)

    act(() => result.current.clear())
    expect(result.current.messages).toEqual([])
  })

  it('消息 id 唯一（连续发送不撞号）', async () => {
    installBridge({ invoke: vi.fn().mockResolvedValue({ text: 'ok' }) })
    const useChatForm = await loadHook()
    const { result } = renderHook(() => useChatForm())
    await act(async () => {
      await result.current.send('a')
    })
    await act(async () => {
      await result.current.send('b')
    })
    const ids = result.current.messages.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
