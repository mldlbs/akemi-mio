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
/** 捕获 agent 活动订阅回调，用于手工注入真实对话流事件。 */
let agentActivityHandler: ((a: { kind: string; text: string }) => void) | null = null
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
  // 真实对话流（主进程镜像）入口。PetForm 会订阅它，
  // mock 必须提供，否则组件挂载即抛错导致全部用例失败。
  onAgentActivity: (handler: (a: unknown) => void) => {
    agentActivityHandler = handler as typeof agentActivityHandler
    return () => {
      agentActivityHandler = null
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
  agentActivityHandler = null
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

describe('PetForm 消费真实对话流（主进程镜像）', () => {
  it('thinking 活动进入思考情绪', async () => {
    await renderPet()
    act(() => {
      agentActivityHandler?.({ kind: 'thinking', text: '' })
    })
    expect(currentMood()).toBe('thinking')
  })

  it('工具活动显示中文动作名', async () => {
    await renderPet()
    act(() => {
      agentActivityHandler?.({ kind: 'tool', text: 'Read' })
    })
    expect(currentMood()).toBe('thinking')
    // Read 应被翻译成「读取文件」而不是原样显示工具名
    expect(screen.getByText('读取文件…')).toBeTruthy()
  })

  it('未知工具名原样显示（不显示 undefined）', async () => {
    await renderPet()
    act(() => {
      agentActivityHandler?.({ kind: 'tool', text: 'SomeNewTool' })
    })
    expect(screen.getByText('SomeNewTool…')).toBeTruthy()
  })

  it('流式 speaking 不逐块弹气泡，静默后才展示结果', async () => {
    await renderPet()
    // 模拟逐块到达
    act(() => {
      agentActivityHandler?.({ kind: 'speaking', text: '我' })
      agentActivityHandler?.({ kind: 'speaking', text: '在做' })
      agentActivityHandler?.({ kind: 'speaking', text: '这件事' })
    })
    // 尚未静默，不应显示气泡（否则会疯狂闪烁）
    expect(screen.queryByText('我在做这件事')).toBeNull()

    // 静默 700ms 后合并展示
    act(() => {
      vi.advanceTimersByTime(800)
    })
    expect(screen.getByText('我在做这件事')).toBeTruthy()
  })

  it('过长回复被截断（不撑爆小气泡）', async () => {
    await renderPet()
    const long = 'A'.repeat(200)
    act(() => {
      agentActivityHandler?.({ kind: 'speaking', text: long })
      vi.advanceTimersByTime(800)
    })
    expect(screen.getByText(`${'A'.repeat(90)}…`)).toBeTruthy()
  })

  it('error 活动进入 alert 并显示原因', async () => {
    await renderPet()
    act(() => {
      agentActivityHandler?.({ kind: 'error', text: '工具失败' })
    })
    expect(currentMood()).toBe('alert')
    expect(screen.getByText('工具失败')).toBeTruthy()
  })

  it('done 且无待展示文本时露出开心表情', async () => {
    await renderPet()
    act(() => {
      agentActivityHandler?.({ kind: 'done', text: '' })
    })
    expect(currentMood()).toBe('happy')
  })

  it('done 时若有未展示文本则优先展示文本', async () => {
    await renderPet()
    act(() => {
      agentActivityHandler?.({ kind: 'speaking', text: '完成的内容' })
      agentActivityHandler?.({ kind: 'done', text: '' })
    })
    expect(screen.getByText('完成的内容')).toBeTruthy()
  })
})
