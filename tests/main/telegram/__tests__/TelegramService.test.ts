import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TelegramService, DebouncedEditor } from '@akemi-mio/messaging/telegram/TelegramService'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import { initDatabase, closeDatabase } from '@akemi-mio/core/db/connection'
import { useIsolatedTestDatabase } from '../../db/__tests__/testDatabase'
import { credentialsManager } from '@akemi-mio/core/credentials/CredentialsManager'
import { radarPushScheduler } from '@akemi-mio/messaging/telegram/radar/RadarPushScheduler'
import { insertOutbox } from '@akemi-mio/core/db/outbox'

vi.mock('@akemi-mio/core/credentials/CredentialsManager', () => ({
  credentialsManager: { get: vi.fn(() => null) },
}))

vi.mock('@akemi-mio/core/db/connection', () => ({
  initDatabase: vi.fn().mockResolvedValue(undefined),
  closeDatabase: vi.fn(),
}))

vi.mock('../../db/__tests__/testDatabase', () => ({
  useIsolatedTestDatabase: vi.fn(() => vi.fn()),
}))

vi.mock('@akemi-mio/core/db/outbox', () => ({
  insertOutbox: vi.fn(),
}))

vi.mock('@akemi-mio/messaging/telegram/radar/RadarPushScheduler', () => ({
  radarPushScheduler: {
    start: vi.fn(),
    stop: vi.fn(),
  },
}))

describe('TelegramService', () => {
  let tg: TelegramService
  let mockAgent: {
    processExternalMessage: ReturnType<typeof vi.fn>
    processTextInput: ReturnType<typeof vi.fn>
    clearContext: ReturnType<typeof vi.fn>
  }
  let restoreTestDatabase: () => void

  const okJson = (data: any) =>
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

  beforeEach(async () => {
    restoreTestDatabase = useIsolatedTestDatabase()
    process.env.TELEGRAM_SERVER_URL = 'https://test-telegram.local'
    process.env.TELEGRAM_CHAT_ID = ''
    await initDatabase()

    eventBus.removeAll()
    vi.stubGlobal('fetch', vi.fn())
    vi.mocked(credentialsManager.get).mockReset()
    vi.mocked(credentialsManager.get).mockReturnValue(null)
    vi.mocked(radarPushScheduler.start).mockReset()
    vi.mocked(radarPushScheduler.stop).mockReset()

    mockAgent = {
      processExternalMessage: vi.fn().mockResolvedValue({
        reply: 'test reply',
        error: undefined,
      }),
      processTextInput: vi.fn().mockResolvedValue({
        reply: 'test reply',
        error: undefined,
      }),
      clearContext: vi.fn(),
    }
    tg = new TelegramService(mockAgent as any)
  })

  afterEach(() => {
    tg?.stop()
    closeDatabase()
    vi.unstubAllGlobals()
    eventBus.removeAll()
    restoreTestDatabase()
    delete process.env.TELEGRAM_CHAT_ID
    delete process.env.RADAR_CHAT_ID
  })

  it('starts polling when initialize can reach the telegram service', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(okJson({ queueLength: 0 }))

    await tg.initialize()

    expect(tg['isRunning']).toBe(true)
    expect(tg['pollTimer']).not.toBeNull()
  })

  it('does not start polling when initialize cannot reach the telegram service', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('connect refused'))

    await tg.initialize()

    expect(tg['isRunning']).toBe(false)
  })

  it('does not start radar scheduler when radar_chat_id is missing', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(okJson({ queueLength: 0 }))
    vi.mocked(credentialsManager.get).mockImplementation((name: string) => {
      if (name === 'telegram_enabled') return 'true'
      if (name === 'telegram_server_url') return 'https://test-telegram.local'
      if (name === 'radar_chat_id') return null
      if (name === 'telegram_chat_id') return null
      return null
    })

    await tg.initialize()

    expect(radarPushScheduler.start).not.toHaveBeenCalled()
  })

  it('does not start radar scheduler when radar_chat_id is invalid', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(okJson({ queueLength: 0 }))
    vi.mocked(credentialsManager.get).mockImplementation((name: string) => {
      if (name === 'telegram_enabled') return 'true'
      if (name === 'telegram_server_url') return 'https://test-telegram.local'
      if (name === 'radar_chat_id') return 'oops'
      if (name === 'telegram_chat_id') return null
      return null
    })

    await tg.initialize()

    expect(radarPushScheduler.start).not.toHaveBeenCalled()
  })

  it('starts radar scheduler when radar_chat_id is valid even if telegram_chat_id is missing', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(okJson({ queueLength: 0 }))
    vi.mocked(credentialsManager.get).mockImplementation((name: string) => {
      if (name === 'telegram_enabled') return 'true'
      if (name === 'telegram_server_url') return 'https://test-telegram.local'
      if (name === 'radar_chat_id') return '-10099'
      if (name === 'telegram_chat_id') return null
      return null
    })

    await tg.initialize()

    expect(radarPushScheduler.start).toHaveBeenCalledTimes(1)
  })

  it('does not enqueue radar messages when radar target is missing at send time', () => {
    vi.mocked(credentialsManager.get).mockImplementation((name: string) => {
      if (name === 'radar_chat_id') return null
      return null
    })
    const dispatchNotification = vi.spyOn((tg as any).telegramGateway, 'dispatchNotification')

    tg['subscribeRadarEvents']()
    eventBus.emit('radar.push.rule_fired', { message: 'radar payload' } as any)

    expect(dispatchNotification).not.toHaveBeenCalled()
  })

  it('enqueues radar messages only to radar_chat_id', () => {
    vi.mocked(credentialsManager.get).mockImplementation((name: string) => {
      if (name === 'radar_chat_id') return '999'
      if (name === 'telegram_chat_id') return '555'
      return null
    })
    const dispatchNotification = vi.spyOn((tg as any).telegramGateway, 'dispatchNotification').mockReturnValue(1)

    tg['subscribeRadarEvents']()
    eventBus.emit('radar.push.rule_fired', { message: 'radar payload' } as any)

    expect(dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        context: { chatId: '999' },
        body: 'radar payload',
        trigger: 'security_alert',
      }),
    )
    expect(dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({
        context: { chatId: '555' },
        body: 'radar payload',
      }),
    )
  })

  it('writes radar notifications to the push outbox for the configured group', () => {
    vi.mocked(credentialsManager.get).mockImplementation((name: string) => {
      if (name === 'radar_chat_id') return '-100999'
      return null
    })
    vi.mocked(insertOutbox).mockReturnValue(1)

    tg['subscribeRadarEvents']()
    eventBus.emit('radar.push.rule_fired', {
      version: 1,
      ruleId: 'rule-1',
      ruleName: 'daily briefing',
      message: 'radar payload',
      signalCount: 3,
      timestamp: Date.now(),
    })

    expect(insertOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100999',
        bot: 'push',
        msgType: 'reply',
        category: 'system',
        message: expect.stringContaining('radar payload'),
      }),
    )
  })

  it('routes budget notifications through dispatchNotification', () => {
    const dispatchNotification = vi.spyOn((tg as any).telegramGateway, 'dispatchNotification').mockReturnValue(1)
    tg['pushChatId'] = 555
    tg['subscribePushEvents']()

    eventBus.emit('budget.exhausted', { resource: 'llm', utilization: 0.91 } as any)
    eventBus.emit('budget.restored', { resource: 'llm' } as any)

    expect(dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'budget_exhausted',
        context: { chatId: '555' },
      }),
    )
    expect(dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'budget_restored',
        context: { chatId: '555' },
      }),
    )
  })

  it('routes plan and recovery events through the push notification gateway', () => {
    const dispatchNotification = vi.spyOn((tg as any).telegramGateway, 'dispatchNotification').mockReturnValue(1)
    const enqueueReply = vi.spyOn(tg as any, 'enqueueReply').mockImplementation(() => {})
    tg['pushChatId'] = 555
    tg['subscribePushEvents']()

    const cases = [
      {
        event: 'agent.plan.created',
        payload: { planId: 'plan-1', title: 'Plan alpha' },
        trigger: 'plan_update',
        detail: 'Plan alpha',
      },
      {
        event: 'agent.plan.step',
        payload: { planId: 'plan-1', stepIndex: 2, status: 'done' },
        trigger: 'plan_update',
        detail: 'done',
      },
      {
        event: 'agent.plan.completed',
        payload: { planId: 'plan-1' },
        trigger: 'plan_update',
        detail: 'plan-1',
      },
      {
        event: 'recovery.checkpoint.created',
        payload: { runId: 'run-1', trigger: 'milestone', path: '/tmp/checkpoint' },
        trigger: 'recovery_update',
        detail: 'milestone',
      },
      {
        event: 'recovery.session.restored',
        payload: { runId: 'run-1', hasUnfinishedPlan: true },
        trigger: 'recovery_update',
        detail: 'run-1',
      },
      {
        event: 'recovery.error.classified',
        payload: { category: 'transient', strategy: 'retry', retryDelayMs: 1000 },
        trigger: 'recovery_update',
        detail: 'retry',
      },
      {
        event: 'recovery.recovery.completed',
        payload: { newRunId: 'run-2', success: true },
        trigger: 'recovery_update',
        detail: 'run-2',
      },
    ] as const

    for (const item of cases) {
      eventBus.emit(item.event as any, item.payload as any)
    }

    expect(dispatchNotification).toHaveBeenCalledTimes(cases.length)
    for (const item of cases) {
      expect(dispatchNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger: item.trigger,
          context: { chatId: '555' },
          body: expect.stringContaining(item.detail),
        }),
      )
    }
    expect(enqueueReply).not.toHaveBeenCalled()
  })

  it('routes stability and system events through the push notification gateway', () => {
    const dispatchNotification = vi.spyOn((tg as any).telegramGateway, 'dispatchNotification').mockReturnValue(1)
    const enqueueReply = vi.spyOn(tg as any, 'enqueueReply').mockImplementation(() => {})
    tg['pushChatId'] = 555
    tg['subscribePushEvents']()

    const cases = [
      {
        event: 'stability.status.changed',
        payload: { previous: 'stable', current: 'degraded', score: 62 },
        trigger: 'stability_alert',
        detail: 'degraded',
      },
      {
        event: 'plugin.registered',
        payload: { name: 'plugin-a', version: '1.2.3', toolCount: 4 },
        trigger: 'system_update',
        detail: 'plugin-a',
      },
      {
        event: 'plugin.unregistered',
        payload: { name: 'plugin-a', reason: 'disabled' },
        trigger: 'system_update',
        detail: 'disabled',
      },
      {
        event: 'plugin.error',
        payload: { name: 'plugin-a', phase: 'load', error: 'load failed' },
        trigger: 'system_update',
        detail: 'load failed',
      },
      {
        event: 'engine.registered',
        payload: { name: 'engine-a', type: 'llm' },
        trigger: 'system_update',
        detail: 'engine-a',
      },
      {
        event: 'engine.unregistered',
        payload: { name: 'engine-a' },
        trigger: 'system_update',
        detail: 'engine-a',
      },
      {
        event: 'engine.activated',
        payload: { name: 'engine-b', previous: 'engine-a' },
        trigger: 'system_update',
        detail: 'engine-b',
      },
      {
        event: 'skill.enabled',
        payload: { name: 'skill-a' },
        trigger: 'system_update',
        detail: 'skill-a',
      },
      {
        event: 'skill.disabled',
        payload: { name: 'skill-a', reason: 'policy' },
        trigger: 'system_update',
        detail: 'policy',
      },
    ] as const

    for (const item of cases) {
      eventBus.emit(item.event as any, item.payload as any)
    }

    expect(dispatchNotification).toHaveBeenCalledTimes(cases.length)
    for (const item of cases) {
      expect(dispatchNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger: item.trigger,
          context: { chatId: '555' },
          body: expect.stringContaining(item.detail),
        }),
      )
    }
    expect(enqueueReply).not.toHaveBeenCalled()
  })

  it('routes evolution, pipeline, insight, and creativity events through the notification gateway', () => {
    const dispatchNotification = vi.spyOn((tg as any).telegramGateway, 'dispatchNotification').mockReturnValue(1)
    const enqueueReply = vi.spyOn(tg as any, 'enqueueReply').mockImplementation(() => {})
    tg['pushChatId'] = 555
    tg['subscribePushEvents']()

    const cases = [
      ['evolution.cycle.started', { historyCount: 0, failures: 0, strategyName: 'normal' }, 'evolution_complete'],
      ['evolution.cycle.completed', { success: true, summary: 'cycle complete', durationMs: 1000 }, 'evolution_complete'],
      ['evolution.snapshot.created', { tag: 'v1', branch: 'main' }, 'evolution_complete'],
      ['evolution.rollback.completed', { success: true, level: 'L1', ref: 'abc' }, 'evolution_complete'],
      ['evolution.proposal.validated', { proposalId: 'proposal-1', passed: true, regressionRisk: 'low' }, 'evolution_complete'],
      ['evolution.action.executed', { allOk: true, details: [], durationMs: 100 }, 'evolution_complete'],
      ['pipeline.started', { timestamp: 0 }, 'system_update'],
      ['pipeline.completed', { collected: 0, fixed: 0, failed: 0, queueRemaining: 0, details: [], durationMs: 0 }, 'system_update'],
      ['pipeline.errored', { error: 'pipeline failed' }, 'system_update'],
      ['insight.analysis.started', {}, 'memory_update'],
      ['insight.analysis.completed', { count: 0, hasValue: false }, 'memory_update'],
      ['insight.found', { count: 0, insights: [] }, 'memory_update'],
      ['creativity.cycle.started', {}, 'memory_update'],
      ['creativity.cycle.completed', { count: 0, hasValue: false }, 'memory_update'],
      ['creativity.dream.completed', { count: 0, topNovelty: 0 }, 'memory_update'],
      ['creativity.ideas.generated', { count: 0, ideas: [] }, 'memory_update'],
    ] as const

    for (const [event, payload] of cases) {
      eventBus.emit(event as any, payload as any)
    }

    expect(dispatchNotification).toHaveBeenCalledTimes(cases.length)
    for (const [, , trigger] of cases) {
      expect(dispatchNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger,
          context: { chatId: '555' },
        }),
      )
    }
    expect(enqueueReply).not.toHaveBeenCalled()
  })

  it('stop stops polling and clears the timer', async () => {
    vi.mocked(fetch).mockResolvedValue(okJson({ queueLength: 0 }))

    await tg.initialize()
    tg.stop()

    expect(tg['isRunning']).toBe(false)
    expect(tg['pollTimer']).toBeNull()
  })

  it('stop can be called twice', () => {
    tg.stop()
    tg.stop()
  })

  it('clear command calls clearContext', async () => {
    await tg['handleMessage']({
      type: 'command',
      command: 'clear',
      chatId: 1,
      from: 'test',
      timestamp: Date.now(),
    })

    expect(mockAgent.clearContext).toHaveBeenCalled()
  })

  it('ignores empty message text', async () => {
    await tg['handleMessage']({
      type: 'message',
      chatId: 1,
      text: undefined as any,
      from: 'test',
      timestamp: Date.now(),
    })

    expect(mockAgent.processExternalMessage).not.toHaveBeenCalled()
  })

  it('processes a normal text message', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(okJson({ queueLength: 0 }))
      .mockResolvedValueOnce(okJson({ messageId: 42 }))

    await tg.initialize()
    await tg['handleMessage']({
      type: 'message',
      messageId: 1,
      chatId: 100,
      text: 'hello',
      from: 'user',
      timestamp: Date.now(),
    })

    expect(mockAgent.processExternalMessage).toHaveBeenCalled()
  })

  it('falls back when sendMessageSync cannot return a message id', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(okJson({ queueLength: 0 }))
      .mockResolvedValueOnce(okJson({}))

    await tg.initialize()
    await tg['handleMessage']({
      type: 'message',
      messageId: 1,
      chatId: 100,
      text: 'hello',
      from: 'user',
      timestamp: Date.now(),
    })

    expect(mockAgent.processExternalMessage).toHaveBeenCalled()
  })

  it('requeues messages when the agent reports BUSY', async () => {
    mockAgent.processExternalMessage.mockResolvedValue({
      error: 'BUSY',
      reply: undefined,
    })
    vi.mocked(fetch)
      .mockResolvedValueOnce(okJson({ queueLength: 0 }))
      .mockResolvedValueOnce(okJson({ messageId: 42 }))

    await tg.initialize()
    await tg['handleMessage']({
      type: 'message',
      messageId: 1,
      chatId: 100,
      text: 'request',
      from: 'user',
      timestamp: Date.now(),
    })

    expect(tg['retryQueue'].length).toBeGreaterThanOrEqual(1)
  })

  it('handles agent exceptions without crashing', async () => {
    mockAgent.processExternalMessage.mockRejectedValue(new Error('internal'))
    vi.mocked(fetch)
      .mockResolvedValueOnce(okJson({ queueLength: 0 }))
      .mockResolvedValueOnce(okJson({ messageId: 42 }))

    await tg.initialize()
    await tg['handleMessage']({
      type: 'message',
      messageId: 1,
      chatId: 100,
      text: 'request',
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

  it('DebouncedEditor flushNow sends an edit request', () => {
    const f = vi.mocked(fetch).mockResolvedValue(okJson({}))
    const editor = new DebouncedEditor()
    editor.setBaseUrl('https://test.example.com')
    editor.schedule(1, 100, 'flush test')
    editor.flushNow()

    expect(f).toHaveBeenCalledWith(expect.stringContaining('/edit'), expect.any(Object))
  })
})
