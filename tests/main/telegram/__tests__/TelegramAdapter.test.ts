import { describe, expect, it } from 'vitest'
import { TelegramAdapter } from '@akemi-mio/messaging/telegram/TelegramAdapter'

describe('TelegramAdapter', () => {
  it('parses slash commands into interaction requests', () => {
    const adapter = new TelegramAdapter()

    expect(
      adapter.toInteractionRequest({
        messageId: 8,
        chatId: 42,
        text: '/approve fix-radar-routing',
        from: 'alice',
        timestamp: 99,
      }),
    ).toEqual({
      type: 'authorization',
      command: 'approve',
      args: ['fix-radar-routing'],
    })
  })

  it('renders proactive notifications as plain telegram text', () => {
    const adapter = new TelegramAdapter()
    const rendered = adapter.renderNotification({
      trigger: 'task_stuck',
      confidence: 0.92,
      urgency: 'high',
      requireAction: true,
      title: 'Task stalled',
      body: 'No progress for 10 minutes',
      actions: [{ label: 'View status', command: '/status' }],
      context: { chatId: '42' },
    })

    expect(rendered.message).toContain('Task stalled')
    expect(rendered.message).toContain('/status')
    expect(rendered.bot).toBe('push')
  })

  it('keeps medium urgency notifications on push', () => {
    const adapter = new TelegramAdapter()
    const rendered = adapter.renderNotification({
      trigger: 'budget_restored',
      confidence: 0.5,
      urgency: 'medium',
      requireAction: false,
      title: 'Budget restored',
      body: 'Ready again',
      context: { chatId: '42' },
    })

    expect(rendered.bot).toBe('push')
  })
})
