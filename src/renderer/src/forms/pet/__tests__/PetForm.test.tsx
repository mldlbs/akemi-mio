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

/**
 * 订阅者集合（而非单个变量）。
 *
 * 真实 preload 的 ipcRenderer.on 支持**多个**监听器，组件里也确实有
 * 多个 useEffect 各自订阅（形态间广播 / 主壳状态）。用一个变量存 handler
 * 会让后订阅者覆盖前者，导致前一个订阅永远收不到事件 ——
 * 这是 mock 的失真，不是被测代码的问题。
 */
let broadcastHandlers: Set<(m: unknown) => void> = new Set()
let agentActivityHandlers: Set<(a: unknown) => void> = new Set()
const broadcastSpy = vi.fn()
const ignoreSpy = vi.fn()

/**
 * elementFromPoint 的命中结果。
 *
 * jsdom 不实现 elementFromPoint（它依赖真实布局），这里桩掉。
 * 我们要测的是"命中之后该不该临时恢复交互"这段逻辑，
 * 而不是浏览器怎么算命中 —— 后者只有真机能验。
 */
let hitTarget: Element | null = null

/** 向所有广播订阅者派发一条消息（模拟主进程中继）。 */
function emitBroadcast(msg: { from: string; type: string; payload: unknown }) {
  for (const h of [...broadcastHandlers]) h(msg)
}

/** 向所有 agent 活动订阅者派发一条活动。 */
function emitAgentActivity(activity: { kind: string; text: string }) {
  for (const h of [...agentActivityHandlers]) h(activity)
}

vi.mock('../../runtime', () => ({
  hasFormBridge: () => true,
  broadcast: (...args: unknown[]) => broadcastSpy(...args),
  onBroadcast: (handler: (m: unknown) => void) => {
    broadcastHandlers.add(handler)
    return () => {
      broadcastHandlers.delete(handler)
    }
  },
  // 真实对话流（主进程镜像）入口。PetForm 会订阅它，
  // mock 必须提供，否则组件挂载即抛错导致全部用例失败。
  onAgentActivity: (handler: (a: unknown) => void) => {
    agentActivityHandlers.add(handler)
    return () => {
      agentActivityHandlers.delete(handler)
    }
  },
  setFormVisible: vi.fn().mockResolvedValue(undefined),
  setIgnoreMouseEvents: (v: boolean) => {
    ignoreSpy(v)
    return Promise.resolve()
  },
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
  broadcastHandlers = new Set()
  agentActivityHandlers = new Set()
  broadcastSpy.mockClear()
  ignoreSpy.mockClear()
  hitTarget = null
  document.elementFromPoint = (() => hitTarget) as typeof document.elementFromPoint
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
      emitBroadcast({ from: 'chat', type: 'chat:thinking', payload: null })
    })
    expect(currentMood()).toBe('thinking')
  })

  it('临时情绪到期后回落 idle（不会永远笑）', async () => {
    await renderPet()
    act(() => {
      emitBroadcast({ from: 'chat', type: 'chat:thinking', payload: null })
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
      emitBroadcast({ from: 'chat', type: 'chat:reply', payload: '做好了' })
    })
    expect(currentMood()).toBe('happy')
    expect(screen.getByText('做好了')).toBeTruthy()
  })

  it('chat:error 进入 alert 并显示错误气泡', async () => {
    await renderPet()
    act(() => {
      emitBroadcast({ from: 'chat', type: 'chat:error', payload: '出错了' })
    })
    expect(currentMood()).toBe('alert')
    expect(screen.getByText('出错了')).toBeTruthy()
  })

  it('忽略来自自身的广播（不回环）', async () => {
    await renderPet()
    act(() => {
      emitBroadcast({ from: 'pet', type: 'chat:thinking', payload: null })
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
    // 单击延后 250ms 执行（等双击判定），要推进时间才会真正触发
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(broadcastSpy).toHaveBeenCalledWith('pet:poked', null)
  })

  it('双击时召唤对话框', async () => {
    await renderPet()
    const stage = screen.getByRole('img').parentElement!
    fireEvent.doubleClick(stage)
    expect(broadcastSpy).toHaveBeenCalledWith('pet:summon-chat', null)
  })

  it('双击不会顺带广播两次 pet:poked', async () => {
    await renderPet()
    const stage = screen.getByRole('img').parentElement!
    // 真实 DOM 序列：两次 click 之后才到 dblclick
    fireEvent.click(stage)
    fireEvent.click(stage)
    fireEvent.dblClick(stage)
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(broadcastSpy).toHaveBeenCalledWith('pet:summon-chat', null)
    expect(broadcastSpy).not.toHaveBeenCalledWith('pet:poked', null)
  })
})

describe('PetForm 鼠标穿透（不能是单向操作）', () => {
  /** 点开穿透开关，返回工具条元素。 */
  function enablePassthrough(container: HTMLElement) {
    fireEvent.click(screen.getByLabelText('开启鼠标穿透'))
    return container.querySelector('.pet-toolbar')!
  }

  function movePointer(x: number, y: number) {
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y }))
    })
  }

  it('开启时通知主进程忽略鼠标事件', async () => {
    const { container } = await renderPet()
    enablePassthrough(container)
    expect(ignoreSpy).toHaveBeenLastCalledWith(true)
  })

  it('指针进入工具条时临时恢复交互（否则"关闭穿透"按钮自己点不到）', async () => {
    const { container } = await renderPet()
    const toolbar = enablePassthrough(container)
    hitTarget = toolbar
    movePointer(8, 8)
    expect(ignoreSpy).toHaveBeenLastCalledWith(false)
  })

  it('指针离开工具条后恢复穿透', async () => {
    const { container } = await renderPet()
    const toolbar = enablePassthrough(container)
    hitTarget = toolbar
    movePointer(8, 8)
    expect(ignoreSpy).toHaveBeenLastCalledWith(false)

    hitTarget = null
    movePointer(300, 300)
    expect(ignoreSpy).toHaveBeenLastCalledWith(true)
  })

  it('关闭穿透后不会被 effect 清理又重新打开（否则又变回单向）', async () => {
    const { container } = await renderPet()
    const toolbar = enablePassthrough(container)
    hitTarget = toolbar
    movePointer(8, 8)
    expect(ignoreSpy).toHaveBeenLastCalledWith(false)

    // 此刻按钮是能点到的 —— 关闭穿透
    fireEvent.click(screen.getByLabelText('恢复鼠标交互'))
    expect(ignoreSpy).toHaveBeenLastCalledWith(false)
  })

  it('未开启穿透时不监听命中测试（不做无用功）', async () => {
    await renderPet()
    movePointer(8, 8)
    expect(ignoreSpy).not.toHaveBeenCalled()
  })
})

describe('PetForm 消费真实对话流（主进程镜像）', () => {
  it('thinking 活动进入思考情绪', async () => {
    await renderPet()
    act(() => {
      emitAgentActivity({ kind: 'thinking', text: '' })
    })
    expect(currentMood()).toBe('thinking')
  })

  it('工具活动显示中文动作名', async () => {
    await renderPet()
    act(() => {
      emitAgentActivity({ kind: 'tool', text: 'Read' })
    })
    expect(currentMood()).toBe('thinking')
    // Read 应被翻译成「读取文件」而不是原样显示工具名
    expect(screen.getByText('读取文件…')).toBeTruthy()
  })

  it('未知工具名原样显示（不显示 undefined）', async () => {
    await renderPet()
    act(() => {
      emitAgentActivity({ kind: 'tool', text: 'SomeNewTool' })
    })
    expect(screen.getByText('SomeNewTool…')).toBeTruthy()
  })

  it('流式 speaking 不逐块弹气泡，静默后才展示结果', async () => {
    await renderPet()
    // 模拟逐块到达
    act(() => {
      emitAgentActivity({ kind: 'speaking', text: '我' })
      emitAgentActivity({ kind: 'speaking', text: '在做' })
      emitAgentActivity({ kind: 'speaking', text: '这件事' })
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
      emitAgentActivity({ kind: 'speaking', text: long })
      vi.advanceTimersByTime(800)
    })
    expect(screen.getByText(`${'A'.repeat(90)}…`)).toBeTruthy()
  })

  it('error 活动进入 alert 并显示原因', async () => {
    await renderPet()
    act(() => {
      emitAgentActivity({ kind: 'error', text: '工具失败' })
    })
    expect(currentMood()).toBe('alert')
    expect(screen.getByText('工具失败')).toBeTruthy()
  })

  it('done 且无待展示文本时露出开心表情', async () => {
    await renderPet()
    act(() => {
      emitAgentActivity({ kind: 'done', text: '' })
    })
    expect(currentMood()).toBe('happy')
  })

  it('done 时若有未展示文本则优先展示文本', async () => {
    await renderPet()
    act(() => {
      emitAgentActivity({ kind: 'speaking', text: '完成的内容' })
      emitAgentActivity({ kind: 'done', text: '' })
    })
    expect(screen.getByText('完成的内容')).toBeTruthy()
  })
})

describe('PetForm 消费主壳 agent 状态广播', () => {
  it('shell 的 thinking 让宠物进入思考（覆盖首字未出的空窗期）', async () => {
    await renderPet()
    act(() => {
      emitBroadcast({ from: 'shell', type: 'agent:state', payload: { state: 'thinking' } })
    })
    expect(currentMood()).toBe('thinking')
  })

  it('shell 的 tool 状态也进入思考', async () => {
    await renderPet()
    act(() => {
      emitBroadcast({ from: 'shell', type: 'agent:state', payload: { state: 'tool' } })
    })
    expect(currentMood()).toBe('thinking')
  })

  it('replying 时露出开心（正文由 chunk 展示，不重复气泡）', async () => {
    await renderPet()
    act(() => {
      emitBroadcast({ from: 'shell', type: 'agent:state', payload: { state: 'replying' } })
    })
    expect(currentMood()).toBe('happy')
  })

  it('idle 时回到空闲', async () => {
    await renderPet()
    act(() => {
      emitBroadcast({ from: 'shell', type: 'agent:state', payload: { state: 'thinking' } })
    })
    expect(currentMood()).toBe('thinking')
    act(() => {
      emitBroadcast({ from: 'shell', type: 'agent:state', payload: { state: 'idle' } })
    })
    expect(currentMood()).toBe('idle')
  })

  it('忽略形态自己发出的 agent:state（只认 shell 来源）', async () => {
    await renderPet()
    act(() => {
      emitBroadcast({ from: 'chat', type: 'agent:state', payload: { state: 'thinking' } })
    })
    // 来源不是 shell，应被忽略
    expect(currentMood()).toBe('idle')
  })

  it('缺少 state 字段时不崩溃', async () => {
    await renderPet()
    act(() => {
      emitBroadcast({ from: 'shell', type: 'agent:state', payload: null })
    })
    expect(currentMood()).toBe('idle')
  })

  it('未知 state 值不改变情绪', async () => {
    await renderPet()
    act(() => {
      emitBroadcast({ from: 'shell', type: 'agent:state', payload: { state: 'whatever' } })
    })
    expect(currentMood()).toBe('idle')
  })
})
