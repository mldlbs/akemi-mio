import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ReflectLoop } from '@akemi-mio/intelligence/agent/ReflectLoop'

describe('ReflectLoop', () => {
  let loop: ReflectLoop
  let mockLlm: any
  let mockEngineering: any
  let mockDecisionStore: any
  let mockBudget: any

  beforeEach(() => {
    vi.useFakeTimers()
    mockLlm = { chatJson: vi.fn() }
    mockEngineering = { store: vi.fn() }
    mockDecisionStore = { record: vi.fn() }
    mockBudget = { consumeLlmCall: vi.fn() }
    loop = new ReflectLoop()
    loop.setDeps(mockLlm as any, mockEngineering as any)
    loop.setDecisionStore(mockDecisionStore as any)
    loop.setResourceBudget(mockBudget as any)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function tick() {
    vi.advanceTimersToNextTimer()
    await Promise.resolve()
    await Promise.resolve()
  }

  it('无 deps 时不触发', async () => {
    const l = new ReflectLoop()
    l.trigger({ requestId: 'r1', userMessage: 'hello', replyLength: 100, durationMs: 1000 })
    await tick()
    expect(mockLlm?.chatJson).not.toHaveBeenCalled()
  })

  it('连续 3 次失败后抑制', async () => {
    mockLlm.chatJson.mockRejectedValue(new Error('fail'))
    for (let i = 0; i < 4; i++) {
      loop.trigger({ requestId: `r${i}`, userMessage: 'hi', replyLength: 100, durationMs: 1000 })
      await tick()
    }
    expect(mockLlm.chatJson).toHaveBeenCalledTimes(3)
  })

  it('短回复且无工具调用时跳过', async () => {
    loop.trigger({ requestId: 'r1', userMessage: 'ok', replyLength: 5, durationMs: 100, toolCalls: [] })
    await tick()
    expect(mockLlm.chatJson).not.toHaveBeenCalled()
  })

  it('调用 chatJson 并存储结果', async () => {
    mockLlm.chatJson.mockResolvedValue({
      data: { summary: '一切顺利', patterns: ['保持步调'], improvements: ['更快响应'], confidence: 0.85 },
    })

    loop.trigger({ requestId: 'r1', userMessage: '你好', replyLength: 80, durationMs: 500, toolCalls: [{ name: 'read_file' }] })
    await tick()

    expect(mockLlm.chatJson).toHaveBeenCalledOnce()
    expect(mockEngineering.store).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'failure_pattern', source: 'reflect_loop', confidence: 0.85 }),
    )
    expect(mockDecisionStore.record).toHaveBeenCalledOnce()
  })

  it('低置信度时不存储', async () => {
    mockLlm.chatJson.mockResolvedValue({
      data: { summary: '不确定', patterns: [], improvements: [], confidence: 0.3 },
    })

    loop.trigger({ requestId: 'r1', userMessage: 'test', replyLength: 30, durationMs: 200 })
    await tick()

    expect(mockEngineering.store).not.toHaveBeenCalled()
    expect(mockDecisionStore.record).not.toHaveBeenCalled()
  })

  it('chatJson 返回 error 时跳过', async () => {
    mockLlm.chatJson.mockResolvedValue({ error: 'API_ERROR:429' })

    loop.trigger({ requestId: 'r1', userMessage: 'test', replyLength: 30, durationMs: 200 })
    await tick()

    expect(mockEngineering.store).not.toHaveBeenCalled()
  })

  it('getFormattedContext 空时返回空字符串', () => {
    expect(loop.getFormattedContext()).toBe('')
  })

  it('getFormattedContext 返回最近 3 条', async () => {
    mockLlm.chatJson.mockResolvedValue({
      data: { summary: '反思 A', patterns: [], improvements: [], confidence: 0.9 },
    })

    for (let i = 0; i < 5; i++) {
      loop.trigger({ requestId: `r${i}`, userMessage: 'hi', replyLength: 30, durationMs: 100 })
      await tick()
    }

    const ctx = loop.getFormattedContext()
    expect(ctx).toContain('反思 A')
  })

  it('budget 耗尽时不调用', async () => {
    mockBudget.consumeLlmCall = vi.fn(() => {
      throw new Error('budget exhausted')
    })
    mockLlm.chatJson.mockResolvedValue({
      data: { summary: 'test', patterns: [], improvements: [], confidence: 0.9 },
    })

    loop.trigger({ requestId: 'r1', userMessage: 'test', replyLength: 30, durationMs: 100 })
    await tick()

    expect(mockLlm.chatJson).not.toHaveBeenCalled()
  })
})
