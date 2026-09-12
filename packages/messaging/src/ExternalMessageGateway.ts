import type { ExternalMessage, NotificationEvent, AgentServicePort, TelegramRenderer, OutboxInsert, ChatResult } from './types'

/**
 * ExternalMessageGateway — routes incoming external messages to the agent and
 * dispatches proactive notifications to a host-provided outbox + renderer.
 *
 * C2 design: the gateway is a pure orchestrator. It does NOT import from
 * packages/core (db/outbox), packages/intelligence (llm/types), or
 * packages/platform (TelegramAdapter) directly. All collaborators are
 * passed via the constructor, so this package has zero static coupling.
 */
export class ExternalMessageGateway {
  constructor(
    private readonly agentService: AgentServicePort,
    private readonly telegramAdapter: TelegramRenderer,
    private readonly outboxInsert: OutboxInsert,
  ) {}

  async handleExternalMessage(message: ExternalMessage): Promise<ChatResult | undefined> {
    if (message.content.type === 'command' && message.content.command === 'clear') {
      this.agentService.clearContext()
      return
    }
    return await this.agentService.processExternalMessage(message)
  }

  dispatchNotification(event: NotificationEvent): number {
    const payload = this.telegramAdapter.renderNotification(event)
    return this.outboxInsert({
      chatId: payload.chatId,
      bot: payload.bot,
      msgType: payload.msgType,
      category: 'system',
      message: payload.message,
    })
  }
}
