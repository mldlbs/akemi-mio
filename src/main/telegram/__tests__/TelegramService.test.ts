import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { TelegramService, DebouncedEditor } from '../TelegramService'
import { eventBus } from '../../core/EventBus'
import { initDatabase, closeDatabase } from '../../db/connection'

vi.mock('../../credentials/CredentialsManager', () => ({
  credentialsManager: { get: vi.fn(() => null) },
}))

describe('TelegramService', () => {
  let tg: TelegramService
  let mockAgent: any

  beforeEach(async () => {
    if (existsSync(join(process.cwd(), 'akemi-mio.db'))) unlinkSync(join(process.cwd(), 'akemi-mio.db'))
    process.env.USER_DATA_DIR = process.cwd()
    process.env.TELEGRAM_SERVER_URL = 'https://test-telegram.local'
    process.env.TELEGRAM_CHAT_ID = ''
    await initDatabase()

    eventBus.removeAll()
    vi.stubGlobal('fetch', vi.fn())
    mockAgent = {
      processTextInput: vi.fn().mockResolvedValue({ reply: '测试回复', error: undefined }),
      clearContext: vi.fn(),
    }
    tg = new TelegramService(mockAgent)
  })

  afterEach(() => {
    closeDatabase()
    vi.unstubAllGlobals()
    eventBus.removeAll()
    if (existsSync(join(process.cwd(), 'akemi-mio.db'))) unlinkSync(join(process.cwd(), 'akemi-mio.db'))
  })

  const okJson = (data: any) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })

  it('initialize 服务可达时启动轮询', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(okJson({ queueLength: 0 }))
    await tg.initialize()
    expect(tg['isRunning']).toBe(true)
    expect(tg['pollTimer']).not.toBeNull()
  })

  it('initialize 服务不可达不启动轮询', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('connect refused'))
    await tg.initialize()
    expect(tg['isRunning']).toBe(false)
  })

  it('stop 停止轮询并清理', async () => {
    vi.mocked(fetch).mockResolvedValue(okJson({ queueLength: 0 }))
    await tg.initialize()
    tg.stop()
    expect(tg['isRunning']).toBe(false)
    expect(tg['pollTimer']).toBeNull()
  })

  it('stop 可重复调用', () => {
    tg.stop()
    tg.stop()
  })

  it('/clear 调用 clearContext', async () => {
    await tg['handleMessage']({
      type: 'command',
      command: 'clear',
      chatId: 1,
      from: 'test',
      timestamp: Date.now(),
    })
    expect(mockAgent.clearContext).toHaveBeenCalled()
  })

  it('空文本跳过', async () => {
    await tg['handleMessage']({
      type: 'message',
      chatId: 1,
      text: undefined as any,
      from: 'test',
      timestamp: Date.now(),
    })
    expect(mockAgent.processTextInput).not.toHaveBeenCalled()
  })

  it('文本消息全流程', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(okJson({ queueLength: 0 }))
      .mockResolvedValueOnce(okJson({ messageId: 42 }))
    await tg.initialize()
    await tg['handleMessage']({
      type: 'message',
      messageId: 1,
      chatId: 100,
      text: '你好',
      from: 'user',
      timestamp: Date.now(),
    })
    expect(mockAgent.processTextInput).toHaveBeenCalled()
  })

  it('sendMessageSync 失败时降级', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(okJson({ queueLength: 0 }))
      .mockResolvedValueOnce(okJson({}))
    await tg.initialize()
    await tg['handleMessage']({
      type: 'message',
      messageId: 1,
      chatId: 100,
      text: '你好',
      from: 'user',
      timestamp: Date.now(),
    })
    expect(mockAgent.processTextInput).toHaveBeenCalled()
  })

  it('BUSY 入重试队列', async () => {
    mockAgent.processTextInput.mockResolvedValue({ error: 'BUSY', reply: undefined })
    vi.mocked(fetch)
      .mockResolvedValueOnce(okJson({ queueLength: 0 }))
      .mockResolvedValueOnce(okJson({ messageId: 42 }))
    await tg.initialize()
    await tg['handleMessage']({
      type: 'message',
      messageId: 1,
      chatId: 100,
      text: '请求',
      from: 'user',
      timestamp: Date.now(),
    })
    expect(tg['retryQueue'].length).toBeGreaterThanOrEqual(1)
  })

  it('processTextInput 抛异常进入 retry', async () => {
    mockAgent.processTextInput.mockRejectedValue(new Error('内部错误'))
    vi.mocked(fetch)
      .mockResolvedValueOnce(okJson({ queueLength: 0 }))
      .mockResolvedValueOnce(okJson({ messageId: 42 }))
    await tg.initialize()
    await tg['handleMessage']({
      type: 'message',
      messageId: 1,
      chatId: 100,
      text: '请求',
      from: 'user',
      timestamp: Date.now(),
    })
  })

  it('DebouncedEditor schedule/cancel', () => {
    const editor = new DebouncedEditor()
    editor.setBaseUrl('https://test.example.com')
    editor.schedule(1, 100, 'test')
    expect(editor['timer']).not.toBeNull()
    editor.cancel()
    expect(editor['timer']).toBeNull()
  })

  it('DebouncedEditor flushNow 发出请求', () => {
    const f = vi.mocked(fetch).mockResolvedValue(okJson({}))
    const editor = new DebouncedEditor()
    editor.setBaseUrl('https://test.example.com')
    editor.schedule(1, 100, 'flush test')
    editor.flushNow()
    expect(f).toHaveBeenCalledWith(expect.stringContaining('/edit'), expect.any(Object))
  })
})
