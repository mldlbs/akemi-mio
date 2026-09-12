# Mio External Message Gateway Design

## Summary

This design turns Telegram into a channel adapter instead of a direct chat transport for Agent/Core code. Mio will receive normalized external messages through a gateway, decide what they mean, and emit typed outbound events back to the channel layer.

## Problem

Current Telegram integration mixes transport concerns with agent concerns:

- Telegram-specific payloads leak into agent entry points.
- Outbound replies are coupled to Telegram sending logic.
- Active notifications and commands do not share one explicit message contract.

That makes future channels like Discord, WeChat, or voice harder to add without reshaping core logic again.

## Goals

- Keep Telegram as an adapter, not a core dependency.
- Introduce one normalized external message envelope.
- Separate inbound normalization from agent reasoning and outbound dispatch.
- Support conversational input, commands, notifications, and progress updates.
- Reuse the existing gateway layering idea rather than duplicating transport logic.

## Non-Goals

- Adding new channels beyond Telegram.
- Rewriting the agent reasoning stack.
- Replacing memory or cognition semantics.
- Designing a full multi-platform UI protocol.

## Proposed Design

### 1. Core Message Model

Add a normalized external envelope that all channels map into:

```ts
interface ExternalMessage {
  id: string
  channel: 'telegram'
  userId: string
  timestamp: number
  content: {
    type: 'text' | 'image' | 'voice' | 'file' | 'command'
    text?: string
    media?: MediaRef
  }
  context: {
    chatId: string
    replyTo?: string
    threadId?: string
  }
  metadata: {
    telegramMessageId: number
    raw?: unknown
  }
}
```

`MediaRef` is an opaque, channel-agnostic pointer to stored media, not a Telegram object.

This envelope is the only object Telegram-facing code should hand to the gateway.

### 2. Gateway Boundary

Add a new `ExternalMessageGateway` layer for external messages. It should be separate from the existing tool-oriented `MessageGateway`. Its job is to:

- normalize inbound channel payloads into `ExternalMessage`
- route them to agent-facing handlers
- emit typed outbound events back to the channel layer
- apply permission / authorization checks before action dispatch

It should not understand Telegram transport details beyond the channel adapter contract.

### 3. Channel Protocol v1

Define a small shared protocol for every channel adapter:

- `InboundMessage`
- `OutboundMessage`
- `InteractionRequest`
- `AuthorizationRequest`
- `NotificationEvent`

Telegram, Desktop, and future channels all implement the same protocol surface. Telegram is just one adapter that converts Telegram payloads into protocol events and renders protocol outputs back to Telegram messages.

### 4. Agent Integration

`AgentService` should receive normalized input and optional channel context, not raw Telegram objects.

The agent boundary should only see:

- message content
- sender identity
- context identifiers
- optional request metadata

That keeps memory, cognition, and tool invocation independent of the transport layer.

## Data Flow

### Inbound

1. Telegram receives an update.
2. `TelegramAdapter` converts it into `ExternalMessage`.
3. `ExternalMessageGateway` normalizes and routes the message.
4. `AgentService` processes the normalized request.
5. Cognition / memory layers operate on channel-neutral data.

### Outbound

1. Agent / cognition emits a typed outbound event.
2. `ExternalMessageGateway` decides which channel target should receive it.
3. `TelegramAdapter` renders the outbound payload for Telegram.
4. Telegram sends the final message.

### Proactive Notifications

1. Core logic emits `NotificationEvent`.
2. Gateway checks priority, confidence, and action requirements.
3. TelegramAdapter renders a human-readable notification card.
4. Channel-specific permissions decide whether the event is delivered.

## Error Handling

### Normalization Errors

- Unsupported Telegram content type: convert to a safe fallback or reject with a logged protocol error.
- Invalid command payload: emit an explicit command error response.
- Missing identity/context: reject before agent execution.

### Delivery Errors

- Telegram send failures stay in the adapter / outbox layer.
- Gateway errors remain separate from agent errors.
- Partial failures should not poison the normalized message model.

## Testing Strategy

Write tests for:

1. Telegram inbound normalization into `ExternalMessage`.
2. Command parsing into `InteractionRequest`.
3. Notification rendering from `NotificationEvent`.
4. Strict separation between Telegram payloads and agent inputs.
5. Outbound routing to Telegram without leaking transport details into core logic.

The main regression guard is that core agent tests should not need Telegram-shaped fixtures.

## Implementation Boundaries

Expected files:

- Add: `src/main/messaging/ExternalMessageGateway.ts`
- Add: `src/main/telegram/TelegramAdapter.ts`
- Update: `src/main/telegram/TelegramService.ts`
- Update: `src/main/agent/AgentService.ts`
- Add tests under `src/main/messaging/__tests__/`, `src/main/telegram/__tests__/`, and `src/main/agent/__tests__/`

## Risks

- If the envelope becomes too generic, it may hide channel-specific capabilities.
- If Telegram adapter logic stays in `TelegramService`, the separation will be cosmetic only.

## Recommendation

Use `ExternalMessageGateway` as the canonical boundary and keep `TelegramService` thin. That gives Mio a real channel protocol without over-abstracting before a second channel exists, and avoids conflating it with the existing tool `MessageGateway`.
