/**
 * PetForm 的单元测试。
 *
 * 重点验证情绪状态机的三条规则，它们是"看起来活着"的关键，
 * 也是最容易写成死循环或状态卡死的地方：
 * 1. 临时情绪（happy/alert）到期必须回落 idle —— 否则小人永远咧嘴笑，像坏了。
 * 2. 空闲够久进入 sleepy，任何鼠标活动立即唤醒。
 * 3. 广播驱动：chat:thinking → thinking，chat:reply → happy + 气泡。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'

/** 捕获 broadcast 订阅回调，用于手工触发跨形态事件。 */
let broadcastHandler: ((m: { from: string; type: string; payload: unknown }) => void) | null = null
const broadcastSpy = vi.fn()

vi.mock('../../runtime', () => ({
  hasFormBridge: () => true,
  broadcast: (...args: unknown[]) => broadcastSpy(...args),
  onBroadcast: (handler: (m: unknown) => void) => {
    broadcastHandler = handler as typeof broadcastHandler
    return () => {
      broadcastHandler = null
    }
  },
  setFormVisible: vi.fn().mockResolvedValue(undefined),
  setIgnoreMouseEvents: vi.fn().mockResolvedValue(undefined),
}))

async function renderPet() {
  vi.resetModules()
  const { PetForm } = await import('../PetForm')
  return render(<PetForm />)
}

/** 从无障碍标签里读出当前情绪（组件把 mood 写进了 aria-label）。 */
function currentMood(): string {
  const svg = screen.getByRole('img')
  const label = svg.getAttribute('aria-label') ?? ''
  return label.replace(/^.*当前情绪：/, '')
}

beforeEach(() => {
  broadcastHandler = null
  broadcastSpy.mockClear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('PetForm 情绪状态机', () => {
  it('初始为 idle', async () => {
    await renderPet()
    expect(currentMood()).toBe('idle')
  })

  it('收到 chat:thinking 广播后进入 thinking', async () => {
    await renderPet()
    act(() => {
      broadcastHandler?.({ from: 'chat', type: 'chat:thinking', payload: null })
    })
    expect(currentMood()).toBe('thinking')
  })

  it('临时情绪到期后回落 idle（不会永远笑）', async () => {
    await renderPet()
    act(() => {
      broadcastHandler?.({ from: 'chat', type: 'chat:thinking', payload: null })
    })
    expect(currentMood()).toBe('thinking')

    // MOOD_HOLD_MS = 4200
    act(() => {
      vi.advanceTimersByTime(4300)
    })
    expect(currentMood()).toBe('idle')
  })

  it('chat:reply 进入 happy 并显示气泡', async () => {
    await renderPet()
    act(() => {
      broadcastHandler?.({ from: 'chat', type: 'chat:reply', payload: '做好了' })
    })
    expect(currentMood()).toBe('happy')
    expect(screen.getByText('做好了')).toBeTruthy()
  })

  it('chat:error 进入 alert 并显示错误气泡', async () => {
    await renderPet()
    act(() => {
      broadcastHandler?.({ from: 'chat', type: 'chat:error', payload: '出错了' })
    })
    expect(currentMood()).toBe('alert')
    expect(screen.getByText('出错了')).toBeTruthy()
  })

  it('忽略来自自身的广播（不回环）', async () => {
    await renderPet()
    act(() => {
      broadcastHandler?.({ from: 'pet', type: 'chat:thinking', payload: null })
    })
    expect(currentMood()).toBe('idle')
  })

  it('空闲 45 秒后进入 sleepy', async () => {
    await renderPet()
    act(() => {
      vi.advanceTimersByTime(46_000)
    })
    expect(currentMood()).toBe('sleepy')
  })

  it('鼠标活动把 sleepy 唤醒回 idle', async () => {
    await renderPet()
    act(() => {
      vi.advanceTimersByTime(46_000)
    })
    expect(currentMood()).toBe('sleepy')

    act(() => {
      window.dispatchEvent(new Event('pointermove'))
    })
    expect(currentMood()).toBe('idle')
  })

  it('点击时会广播 pet:poked', async () => {
    await renderPet()
    const stage = screen.getByRole('img').parentElement!
    fireEvent.click(stage)
    expect(broadcastSpy).toHaveBeenCalledWith('pet:poked', null)
  })

  it('双击时召唤对话框', async () => {
    await renderPet()
    const stage = screen.getByRole('img').parentElement!
    fireEvent.doubleClick(stage)
    expect(broadcastSpy).toHaveBeenCalledWith('pet:summon-chat', null)
  })
})
