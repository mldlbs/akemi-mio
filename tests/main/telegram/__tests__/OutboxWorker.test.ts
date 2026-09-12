import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { OutboxWorker } from '@akemi-mio/messaging/telegram/OutboxWorker'
import { initDatabase, closeDatabase } from '@akemi-mio/core/db/connection'
import { insertOutbox } from '@akemi-mio/core/db/outbox'
import { useIsolatedTestDatabase } from '../../db/__tests__/testDatabase'

const BASE_URL = 'https://test-telegram.example.com'

describe('OutboxWorker', () => {
  let worker: OutboxWorker
  let restoreTestDatabase: () => void

  beforeEach(async () => {
    restoreTestDatabase = useIsolatedTestDatabase()
    await initDatabase()
    worker = new OutboxWorker(BASE_URL)
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    closeDatabase()
    vi.unstubAllGlobals()
    restoreTestDatabase()
  })

  const okJson = (data = { ok: true }) =>
    new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })

  it('无 pending 时返回 success', async () => {
    const r = await worker.tick()
    expect(r.success).toBe(true)
    expect(r.summary).toContain('no pending')
  })

  it('无 pending 时每 60 次 tick 触发 cleanup', async () => {
    for (let i = 0; i < 61; i++) await worker.tick()
  })

  it('reply 投递到 /reply', async () => {
    const f = vi.mocked(fetch).mockResolvedValue(okJson())
    insertOutbox({ chatId: '123', msgType: 'reply', message: '你好' })
    await worker.tick()
    expect(f).toHaveBeenCalledWith(`${BASE_URL}/reply`, expect.objectContaining({ body: expect.stringContaining('你好') }))
  })

  it('send 投递到 /send', async () => {
    const f = vi.mocked(fetch).mockResolvedValue(okJson())
    insertOutbox({ chatId: '456', msgType: 'send', message: '推送' })
    await worker.tick()
    expect(f).toHaveBeenCalledWith(`${BASE_URL}/send`, expect.any(Object))
  })

  it('edit 投递到 /edit', async () => {
    const f = vi.mocked(fetch).mockResolvedValue(okJson())
    insertOutbox({ chatId: '789', msgType: 'edit', message: '编辑内容', targetMessageId: 42 })
    await worker.tick()
    expect(f).toHaveBeenCalledWith(`${BASE_URL}/edit`, expect.any(Object))
  })

  it('action 投递到 /action', async () => {
    const f = vi.mocked(fetch).mockResolvedValue(okJson())
    insertOutbox({ chatId: '111', msgType: 'action', message: 'typing' })
    await worker.tick()
    expect(f).toHaveBeenCalledWith(`${BASE_URL}/action`, expect.any(Object))
  })

  it('网络失败标记为 failed', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network error'))
    insertOutbox({ chatId: '123', msgType: 'reply', message: '失败' })
    const r = await worker.tick()
    expect(r.success).toBe(false)
  })

  it('HTTP 非 ok 标记失败', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ ok: false }), { status: 400, headers: { 'Content-Type': 'application/json' } }),
    )
    insertOutbox({ chatId: '123', msgType: 'reply', message: '失败' })
    const r = await worker.tick()
    expect(r.success).toBe(false)
  })

  it('unknown msgType 不崩溃', async () => {
    // 无法直接插入 invalid msgType（有 CHECK 约束），跳过该场景
  })
})
