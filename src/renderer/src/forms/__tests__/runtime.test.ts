/**
 * forms/runtime 的单元测试。
 *
 * 重点覆盖两类容易出错的行为：
 * 1. **形态识别**：preload 优先、URL 文件名回退、查询串兜底、最终兜底。
 *    这是窗口加载页面的第一跳，认错了整个窗口就渲染错形态。
 * 2. **无 preload 时的降级**：必须全部 no-op 且不抛异常。
 *    降级路径如果抛错，vite dev 直连 html 会直接白屏，是真实回归风险。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { FormBridge } from '../types'

/** 每个用例都重新 import，因为 runtime 在模块加载时就确定了 kind（模块级常量）。 */
async function loadRuntime(pathname: string, search = '') {
  vi.resetModules()
  window.history.replaceState({}, '', pathname + search)
  vi.doUnmock('../runtime')
  return await import('../runtime')
}

function installBridge(bridge: Partial<FormBridge>) {
  ;(window as unknown as { akemiForms?: unknown }).akemiForms = bridge
}

function clearBridge() {
  delete (window as unknown as { akemiForms?: unknown }).akemiForms
}

afterEach(() => {
  clearBridge()
  vi.restoreAllMocks()
})

describe('形态识别', () => {
  it('优先采用 preload 声明的 kind', async () => {
    installBridge({ kind: 'wallpaper' })
    const rt = await loadRuntime('/pet.html')
    // preload 最权威：即使 URL 是 pet，也以声明为准
    expect(rt.getFormKind()).toBe('wallpaper')
    expect(rt.hasFormBridge()).toBe(true)
  })

  it('无 preload 时从 URL 文件名推断', async () => {
    clearBridge()
    const rt = await loadRuntime('/chat.html')
    expect(rt.getFormKind()).toBe('chat')
    expect(rt.hasFormBridge()).toBe(false)
  })

  it('URL 带目录前缀时仍能识别', async () => {
    clearBridge()
    const rt = await loadRuntime('/src/renderer/wallpaper.html')
    expect(rt.getFormKind()).toBe('wallpaper')
  })

  it('认不出文件名时回退到 ?form= 查询串', async () => {
    clearBridge()
    const rt = await loadRuntime('/whatever.html', '?form=chat')
    expect(rt.getFormKind()).toBe('chat')
  })

  it('全部认不出时兜底为 pet（依赖最少、最安全）', async () => {
    clearBridge()
    const rt = await loadRuntime('/unknown-thing.html')
    expect(rt.getFormKind()).toBe('pet')
    expect(rt.getBroadcastSource()).toBe('pet')
  })

  // ── 主壳识别（回归防护）──
  //
  // 曾经的主壳会掉进末尾的 `return 'pet'` 兜底，于是广播时谎报 from:'pet'，
  // 接收方会把主壳的对话状态当成自己的回声。必须锁死。
  it('index.html 识别为 shell 而非 pet', async () => {
    clearBridge()
    const rt = await loadRuntime('/index.html')
    expect(rt.isShell()).toBe(true)
    expect(rt.getBroadcastSource()).toBe('shell')
  })

  it('agent.html 也识别为 shell', async () => {
    clearBridge()
    const rt = await loadRuntime('/agent.html')
    expect(rt.isShell()).toBe(true)
  })

  it('根路径识别为 shell', async () => {
    clearBridge()
    const rt = await loadRuntime('/')
    expect(rt.isShell()).toBe(true)
  })

  it('shell 的 getFormKind 回退为 pet 但广播源保持 shell', async () => {
    clearBridge()
    const rt = await loadRuntime('/index.html')
    // 渲染兜底：主壳不渲染形态 UI，返回最小形态即可
    expect(rt.getFormKind()).toBe('pet')
    // 但广播源绝不能被污染
    expect(rt.getBroadcastSource()).toBe('shell')
  })

  it('主壳查形态元数据不返回 undefined（结构完整才安全）', async () => {
    clearBridge()
    const rt = await loadRuntime('/index.html')
    expect(rt.getFormDescriptor()).toBeDefined()
    expect(rt.getFormDescriptor().htmlFile).toBe('pet.html')
  })

  it('?form=shell 也识别为 shell', async () => {
    clearBridge()
    const rt = await loadRuntime('/x.html', '?form=shell')
    expect(rt.isShell()).toBe(true)
  })

  it('形态页面不会被误判为 shell', async () => {
    clearBridge()
    const rt = await loadRuntime('/pet.html')
    expect(rt.isShell()).toBe(false)
  })

  it('preload 存在但 kind 非法时回退到 URL 推断', async () => {
    installBridge({ kind: 'bogus' as FormBridge['kind'] })
    const rt = await loadRuntime('/wallpaper.html')
    expect(rt.getFormKind()).toBe('wallpaper')
  })

  it('getFormDescriptor 返回对应形态元数据', async () => {
    clearBridge()
    const rt = await loadRuntime('/pet.html')
    expect(rt.getFormDescriptor().label).toBe('宠物小人')
    expect(rt.getFormDescriptor().htmlFile).toBe('pet.html')
  })
})

describe('无 preload 时的降级（不得抛异常）', () => {
  let rt: Awaited<ReturnType<typeof loadRuntime>>

  beforeEach(async () => {
    clearBridge()
    rt = await loadRuntime('/pet.html')
  })

  it('toggleForm 返回 false 而非抛错', async () => {
    await expect(rt.toggleForm('chat')).resolves.toBe(false)
  })

  it('isFormVisible 返回 false', async () => {
    await expect(rt.isFormVisible('chat')).resolves.toBe(false)
  })

  it('setFormVisible / setIgnoreMouseEvents / startWindowDrag 均为 no-op', async () => {
    await expect(rt.setFormVisible('chat', true)).resolves.toBeUndefined()
    await expect(rt.setIgnoreMouseEvents(true)).resolves.toBeUndefined()
    await expect(rt.startWindowDrag()).resolves.toBeUndefined()
  })

  it('broadcast 静默丢弃', () => {
    expect(() => rt.broadcast('pet:poked', null)).not.toThrow()
  })

  it('onBroadcast 返回可调用的取消函数', () => {
    const off = rt.onBroadcast(() => {})
    expect(typeof off).toBe('function')
    expect(() => off()).not.toThrow()
  })
})

describe('有 preload 时的转发', () => {
  it('toggleForm 转发 kind 并回传结果', async () => {
    const toggleForm = vi.fn().mockResolvedValue(true)
    installBridge({ kind: 'pet', toggleForm } as Partial<FormBridge>)
    const rt = await loadRuntime('/pet.html')
    await expect(rt.toggleForm('chat')).resolves.toBe(true)
    expect(toggleForm).toHaveBeenCalledWith('chat')
  })

  it('桥接方法抛错时被吞掉，不冒泡到调用方', async () => {
    const toggleForm = vi.fn().mockRejectedValue(new Error('ipc down'))
    installBridge({ kind: 'pet', toggleForm } as Partial<FormBridge>)
    const rt = await loadRuntime('/pet.html')
    await expect(rt.toggleForm('chat')).resolves.toBe(false)
  })

  it('broadcast 带上来源形态', async () => {
    const broadcast = vi.fn()
    installBridge({ kind: 'chat', broadcast } as Partial<FormBridge>)
    const rt = await loadRuntime('/chat.html')
    rt.broadcast('chat:thinking', null)
    expect(broadcast).toHaveBeenCalledWith({ from: 'chat', type: 'chat:thinking', payload: null })
  })

  it('主壳广播时来源为 shell（不得谎报成形态）', async () => {
    const broadcast = vi.fn()
    // 主壳的 preload 拿不到 kind（URL 是 index.html），桥接仍存在
    installBridge({ broadcast } as Partial<FormBridge>)
    const rt = await loadRuntime('/index.html')
    rt.broadcast('agent:state', { state: 'thinking' })
    expect(broadcast).toHaveBeenCalledWith({
      from: 'shell',
      type: 'agent:state',
      payload: { state: 'thinking' },
    })
  })

  it('onBroadcast 转发给 handler 并传递取消订阅', async () => {
    const off = vi.fn()
    let captured: ((m: unknown) => void) | null = null
    const onBroadcast = vi.fn((h: (m: unknown) => void) => {
      captured = h
      return off
    })
    installBridge({ kind: 'pet', onBroadcast } as unknown as Partial<FormBridge>)
    const rt = await loadRuntime('/pet.html')

    const handler = vi.fn()
    const unsubscribe = rt.onBroadcast(handler)
    expect(captured).not.toBeNull()
    captured!({ from: 'chat', type: 'chat:reply', payload: 'hi' })
    expect(handler).toHaveBeenCalledWith({ from: 'chat', type: 'chat:reply', payload: 'hi' })

    unsubscribe()
    expect(off).toHaveBeenCalledTimes(1)
  })
})
