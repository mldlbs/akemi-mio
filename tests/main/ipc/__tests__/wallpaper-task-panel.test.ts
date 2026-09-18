import { beforeEach, describe, expect, it, vi } from 'vitest'

// 存储被注册的 handler 回调（与 tests/main/ipc/__tests__/handlers.test.ts 同一手法）
const registeredHandlers = new Map<string, (...args: any[]) => any>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      registeredHandlers.set(channel, handler)
    }),
    on: vi.fn(),
  },
  BrowserWindow: {
    fromWebContents: vi.fn(() => ({ close: vi.fn(), hide: vi.fn() })),
  },
}))

vi.mock('@akemi-mio/core/logger/Logger', () => ({
  log: vi.fn(),
  createRequestId: vi.fn(() => 'test-req-id'),
}))

vi.mock('@akemi-mio/core/credentials/CredentialsManager', () => ({
  credentialsManager: {
    get: vi.fn(() => null),
    set: vi.fn(),
    list: vi.fn(async () => []),
  },
}))

vi.mock('@akemi-mio/platform/wallpaper/BlogKanbanBridge', () => ({
  blogKanbanBridge: { started: false, start: vi.fn(), getStatus: vi.fn() },
}))

vi.mock('@akemi-mio/evolution/behavior/BehaviorActionCounter', () => ({
  behaviorActionCounter: { record: vi.fn(), get: vi.fn() },
}))

import { registerWallpaperHandlers } from '@akemi-mio/main/ipc/handlers/wallpaper'

/**
 * 任务面板「快捷提问」（`ask_agent` → `desktop_ask_agent`）的失败上报。
 *
 * 背景：主进程用「正常 resolve + error 字段」表达失败（不走异常路径），
 * 而这个 handler 以前**不看返回值**，无条件 `recordAction({ status: 'success' })`
 * 并返回 `{ success: true }` —— 于是「忙 / 熔断 / 暂停」全被报成「✅ 已发送」，
 * 用户点了按钮、界面说成功、实际什么都没发生。
 *
 * 任务面板 renderer 侧已经处理 `success === false`（显示 `❌ ${res.error}`），
 * 所以修这里就能直接改善反馈，不需要动 renderer。
 */
function setup(agentResult: { reply?: string; error?: string }) {
  const recordAction = vi.fn()
  const processTextInput = vi.fn(async () => agentResult)

  const taskPanel = {
    getState: () => ({
      quickActions: [{ id: 'ask_agent', label: '快捷提问', tool: 'desktop_ask_agent', args: {} }],
    }),
    toggleVisibility: vi.fn(() => true),
    setVisible: vi.fn(),
    recordAction,
  }

  registerWallpaperHandlers({
    agentService: { processTextInput } as any,
    evolutionRef: { current: null } as any,
    memoryContextRef: { current: null } as any,
    conversationContextRef: { current: null } as any,
    taskPanelRef: { current: taskPanel } as any,
    wallpaperInteractiveRef: { current: null } as any,
  } as any)

  return {
    handler: registeredHandlers.get('taskPanel:invokeQuickAction')!,
    recordAction,
    processTextInput,
  }
}

describe('taskPanel:invokeQuickAction → desktop_ask_agent', () => {
  beforeEach(() => {
    registeredHandlers.clear()
    vi.clearAllMocks()
  })

  it('助手返回 BUSY 时如实上报失败，而不是「已发送」', async () => {
    const { handler, recordAction, processTextInput } = setup({ error: 'BUSY' })

    const res = await handler({}, 'ask_agent', { prompt: '帮我看看这个' })

    expect(processTextInput).toHaveBeenCalledTimes(1)
    expect(res.success).toBe(false)
    expect(res.error).toContain('正在处理上一条消息')
    expect(recordAction).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }))
    expect(recordAction).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }))
  })

  it('未收录的错误码回落到带码的通用文案（保留排查线索）', async () => {
    const { handler } = setup({ error: 'SOME_BRAND_NEW_CODE' })

    const res = await handler({}, 'ask_agent', { prompt: '帮我看看这个' })

    expect(res.success).toBe(false)
    expect(res.error).toContain('SOME_BRAND_NEW_CODE')
  })

  // `chatErrorText` 对 INTERRUPTED/ABORTED 返回 null（renderer 侧「用户自己按的取消不该弹错误」）。
  // 面板不能照搬这个 null —— 否则会显示成「助手暂时无法处理（INTERRUPTED）」这种内部码。
  it('静默码（用户自己打断）不把内部码当文案', async () => {
    const { handler } = setup({ error: 'INTERRUPTED' })

    const res = await handler({}, 'ask_agent', { prompt: '帮我看看这个' })

    expect(res.success).toBe(false)
    expect(res.error).not.toContain('INTERRUPTED')
    expect(res.error).toContain('取消')
  })

  it('成功时仍然报「已发送」（对照面：别把成功路径一起改坏）', async () => {
    const { handler, recordAction } = setup({ reply: '好的' })

    const res = await handler({}, 'ask_agent', { prompt: '帮我看看这个' })

    expect(res.success).toBe(true)
    expect(res.error).toBeUndefined()
    expect(recordAction).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }))
  })
})
