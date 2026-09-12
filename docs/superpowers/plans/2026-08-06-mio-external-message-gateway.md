# Mio External Message Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Telegram into a thin channel adapter, normalize all incoming messages through a shared external-message contract, and route outbound notifications back through the same protocol without leaking Telegram shapes into Agent/Core code.

**Architecture:** Add a channel-neutral `ExternalMessageGateway` under `src/main/messaging`, a Telegram-specific adapter under `src/main/telegram`, and a small shared protocol layer for inbound, outbound, command, and notification types. Keep the existing `src/main/telegram/MessageGateway.ts` untouched as the tool registry gateway. Refactor `TelegramService` to poll and hand off, while `AgentService` accepts normalized ingress context instead of Telegram-specific fields.

**Tech Stack:** TypeScript, Vitest, existing Electron main-process services, current Telegram outbox worker, `eventBus`, and `insertOutbox`.

---

### Task 1: Define the shared channel protocol and gateway boundary

**Files:**
- Create: `src/main/messaging/types.ts`
- Create: `src/main/messaging/index.ts`
- Create: `src/main/messaging/ExternalMessageGateway.ts`
- Create: `src/main/messaging/__tests__/ExternalMessageGateway.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it, vi } from 'vitest'
import { ExternalMessageGateway } from '../ExternalMessageGateway'

it('routes a normalized external envelope to the agent', async () => {
  const agentService = { processExternalMessage: vi.fn(), clearContext: vi.fn() }
  const gateway = new ExternalMessageGateway(agentService as any)

  await gateway.handleExternalMessage({
    id: 'telegram:12:123',
    channel: 'telegram',
    userId: 'alice',
    timestamp: 123,
    content: { type: 'text', text: 'hello' },
    context: { chatId: '99' },
    metadata: { telegramMessageId: 12, raw: { any: 'value' } },
  })

  expect(agentService.processExternalMessage).toHaveBeenCalledWith(expect.objectContaining({
    channel: 'telegram',
    content: { type: 'text', text: 'hello' },
  }))
})

it('routes /clear to clearContext and does not enter the agent', async () => {
  const agentService = { processExternalMessage: vi.fn(), clearContext: vi.fn() }
  const gateway = new ExternalMessageGateway(agentService as any)

  await gateway.handleExternalMessage({
    id: 'telegram:13:123',
    channel: 'telegram',
    userId: 'alice',
    timestamp: 123,
    content: { type: 'command', text: '/clear', command: 'clear', args: [] },
    context: { chatId: '99' },
    metadata: { telegramMessageId: 13, raw: { any: 'value' } },
  })

  expect(agentService.clearContext).toHaveBeenCalledTimes(1)
  expect(agentService.processExternalMessage).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/main/messaging/__tests__/ExternalMessageGateway.test.ts`
Expected: fail because `ExternalMessageGateway` and the protocol types do not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
export type ChannelName = 'telegram'

export interface MediaRef {
  id: string
  mimeType?: string
  name?: string
  url?: string
}

export interface ExternalMessage {
  id: string
  channel: ChannelName
  userId: string
  timestamp: number
  content: {
    type: 'text' | 'image' | 'voice' | 'file' | 'command'
    text?: string
    command?: string
    args?: string[]
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

export interface InteractionRequest {
  type: 'conversation' | 'command'
  command?: string
  args?: string[]
}

export interface AuthorizationRequest {
  type: 'authorization'
  command: 'approve'
  args: string[]
}

export interface NotificationEvent {
  trigger: 'task_stuck' | 'evolution_complete' | 'security_alert' | 'memory_update'
  confidence: number
  urgency: 'low' | 'medium' | 'high'
  requireAction: boolean
  title: string
  body: string
  actions?: Array<{ label: string; command: string }>
  context: { chatId: string; threadId?: string }
}

export interface AgentResponse {
  id: string
  status: 'thinking' | 'working' | 'waiting' | 'completed' | 'failed'
  progress?: number
  message: string
  context: { chatId: string; threadId?: string }
}
```

```ts
export class ExternalMessageGateway {
  constructor(private readonly agentService: any) {}

  async handleExternalMessage(message: ExternalMessage): Promise<void> {
    if (message.content.type === 'command' && message.content.command === 'clear') {
      this.agentService.clearContext()
      return
    }
    await this.agentService.processExternalMessage(message)
  }
}
```

```ts
function formatActions(actions?: Array<{ label: string; command: string }>): string {
  if (!actions?.length) return ''
  return `\n\n${actions.map((action) => `- ${action.label}: ${action.command}`).join('\n')}`
}
```

- [ ] **Step 4: Run the test and make sure it passes**

Run: `npx vitest run src/main/messaging/__tests__/ExternalMessageGateway.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/messaging docs/superpowers/plans/2026-08-06-mio-external-message-gateway.md
git commit -m "feat: add external message gateway protocol"
```

### Task 2: Add Telegram normalization and rendering in a dedicated adapter

**Files:**
- Create: `src/main/telegram/TelegramAdapter.ts`
- Create: `src/main/telegram/__tests__/TelegramAdapter.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { TelegramAdapter } from '../TelegramAdapter'

it('parses slash commands into interaction requests', () => {
  const adapter = new TelegramAdapter()

  expect(adapter.toInteractionRequest({
    messageId: 8,
    chatId: 42,
    text: '/approve fix-radar-routing',
    from: 'alice',
    timestamp: 99,
  })).toEqual({
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
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/main/telegram/__tests__/TelegramAdapter.test.ts`
Expected: fail because the adapter does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
export interface TelegramInboundMessage {
  messageId?: number
  chatId: number | string
  text?: string
  from: string
  userId?: number | string
  timestamp: number
  replyTo?: number
  threadId?: number | string
  bot?: string
}

export class TelegramAdapter {
  readonly channel = 'telegram' as const

  normalizeInbound(raw: TelegramInboundMessage): ExternalMessage | null {
    const text = raw.text?.trim()
    if (!text) return null
    const command = text.startsWith('/') ? text.slice(1).split(/\s+/, 1)[0] : undefined
    return {
      id: `telegram:${raw.messageId ?? raw.chatId}:${raw.timestamp}`,
      channel: 'telegram',
      userId: String(raw.userId ?? raw.from),
      timestamp: raw.timestamp,
      content: command
        ? { type: 'command', text, command, args: text.split(/\s+/).slice(1) }
        : { type: 'text', text },
      context: {
        chatId: String(raw.chatId),
        replyTo: raw.replyTo ? String(raw.replyTo) : undefined,
        threadId: raw.threadId ? String(raw.threadId) : undefined,
      },
      metadata: {
        telegramMessageId: raw.messageId ?? 0,
        raw,
      },
    }
  }

  toInteractionRequest(raw: TelegramInboundMessage): InteractionRequest | AuthorizationRequest | null {
    const inbound = this.normalizeInbound(raw)
    if (!inbound || inbound.content.type !== 'command' || !inbound.content.command) return null
    if (inbound.content.command === 'approve') {
      return { type: 'authorization', command: 'approve', args: inbound.content.args ?? [] }
    }
    return { type: 'command', command: inbound.content.command, args: inbound.content.args ?? [] }
  }

  renderNotification(event: NotificationEvent) {
    return {
      bot: event.urgency === 'high' ? 'push' : 'chat',
      msgType: 'reply' as const,
      chatId: event.context.chatId,
      message: `${event.urgency === 'high' ? '⚠️' : '💡'} ${event.title}\n\n${event.body}\n${formatActions(event.actions)}`,
    }
  }
}
```

- [ ] **Step 4: Run the test and make sure it passes**

Run: `npx vitest run src/main/telegram/__tests__/TelegramAdapter.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/telegram/TelegramAdapter.ts src/main/telegram/__tests__/TelegramAdapter.test.ts
git commit -m "feat: add telegram adapter for external messages"
```

### Task 3: Give `AgentService` a normalized ingress path

**Files:**
- Modify: `src/main/agent/AgentService.ts`
- Create: `src/main/agent/__tests__/AgentService.external-message.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it, vi } from 'vitest'
import { AgentService } from '../AgentService'

it('processExternalMessage forwards a normalized context instead of telegram-specific keys', async () => {
  const agent = new AgentService() as any
  agent.processTextInput = vi.fn().mockResolvedValue({ reply: 'ok' })

  await agent.processExternalMessage({
    id: 'telegram:12:99',
    channel: 'telegram',
    userId: 'alice',
    timestamp: 99,
    content: { type: 'text', text: 'hello' },
    context: { chatId: '42', replyTo: '8' },
    metadata: { telegramMessageId: 12, raw: { any: 'value' } },
  })

  expect(agent.processTextInput).toHaveBeenCalledWith(
    'hello',
    undefined,
    'telegram',
    expect.objectContaining({
      channel: 'telegram',
      chatId: '42',
      userId: 'alice',
      messageId: 12,
      replyTo: '8',
    }),
    undefined,
    undefined,
  )
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/main/agent/__tests__/AgentService.external-message.test.ts`
Expected: fail because `processExternalMessage` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
export interface AgentIngressContext {
  channel: 'telegram'
  chatId: string
  userId?: string
  messageId?: number
  replyTo?: string
  threadId?: string
  raw?: unknown
}

async processExternalMessage(
  message: ExternalMessage,
  requestId?: string,
  sessionId?: string,
  noTts?: boolean,
): Promise<ChatResult> {
  return this.processTextInput(
    message.content.text ?? '',
    requestId,
    'telegram',
    {
      channel: message.channel,
      chatId: message.context.chatId,
      userId: message.userId,
      messageId: message.metadata.telegramMessageId,
      replyTo: message.context.replyTo,
      threadId: message.context.threadId,
      raw: message.metadata.raw,
    },
    sessionId,
    noTts,
  )
}
```

```ts
async processTextInput(
  text: string,
  requestId?: string,
  source: 'electron' | 'telegram' = 'electron',
  extra?: AgentIngressContext,
  sessionId?: string,
  noTts?: boolean,
): Promise<ChatResult> {
  // keep existing logic, but replace telegram-only references with extra.chatId / extra.userId
}
```

- [ ] **Step 4: Run the test and make sure it passes**

Run: `npx vitest run src/main/agent/__tests__/AgentService.external-message.test.ts src/main/agent/__tests__/AgentService.unit.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/AgentService.ts src/main/agent/__tests__/AgentService.external-message.test.ts
git commit -m "feat: add normalized ingress to agent service"
```

### Task 4: Route Telegram inbound traffic through the gateway

**Files:**
- Modify: `src/main/telegram/TelegramService.ts`
- Modify: `src/main/telegram/__tests__/TelegramService.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it('delegates telegram updates to the external gateway instead of calling the agent directly', async () => {
  const adapter = { normalizeInbound: vi.fn().mockReturnValue({ id: 'telegram:1:1' }) }
  const agent = { processExternalMessage: vi.fn(), clearContext: vi.fn() }
  const service = new TelegramService(agent as any)
  service['telegramAdapter'] = adapter as any
  service['telegramGateway'] = { handleExternalMessage: vi.fn() } as any

  await service['handleMessage']({
    type: 'message',
    messageId: 1,
    chatId: 100,
    text: 'hello',
    from: 'user',
    timestamp: Date.now(),
  })

  expect(adapter.normalizeInbound).toHaveBeenCalled()
  expect(service['telegramGateway'].handleExternalMessage).toHaveBeenCalled()
  expect(agent.processExternalMessage).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/main/telegram/__tests__/TelegramService.test.ts`
Expected: fail because `TelegramService` still talks to `AgentService` directly.

- [ ] **Step 3: Write minimal implementation**

```ts
constructor(
  agentService: AgentService,
  telegramAdapter: TelegramAdapter = new TelegramAdapter(),
  telegramGateway: ExternalMessageGateway = new ExternalMessageGateway(agentService, telegramAdapter),
) {
  this.agentService = agentService
  this.telegramAdapter = telegramAdapter
  this.telegramGateway = telegramGateway
}

private async handleMessage(msg: TelegramMessage): Promise<void> {
  const inbound = this.telegramAdapter.normalizeInbound(msg)
  if (!inbound) return
  await this.telegramGateway.handleExternalMessage(inbound)
}
```

```ts
// keep polling, reconnect, and outbox transport here
// move parsing/command decisions into TelegramAdapter + ExternalMessageGateway
```

- [ ] **Step 4: Run the test and make sure it passes**

Run: `npx vitest run src/main/telegram/__tests__/TelegramService.test.ts src/main/messaging/__tests__/ExternalMessageGateway.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/telegram/TelegramService.ts src/main/telegram/__tests__/TelegramService.test.ts
git commit -m "feat: route telegram ingress through external gateway"
```

### Task 5: Route outbound notifications and progress updates through the same protocol

**Files:**
- Modify: `src/main/telegram/TelegramService.ts`
- Modify: `src/main/telegram/__tests__/TelegramService.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it('renders a proactive notification into a plain telegram outbox row', () => {
  const insertSpy = vi.fn(() => 1)
  const gateway = new ExternalMessageGateway(
    { processExternalMessage: vi.fn(), clearContext: vi.fn() } as any,
    { renderNotification: vi.fn().mockReturnValue({
      chatId: '42',
      bot: 'push',
      msgType: 'reply',
      message: 'Memory updated',
    }) } as any,
    insertSpy as any,
  )

  gateway.dispatchNotification({
    trigger: 'memory_update',
    confidence: 0.81,
    urgency: 'medium',
    requireAction: false,
    title: 'Memory updated',
    body: 'New summary is ready',
    context: { chatId: '42' },
  })

  expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({
    chatId: '42',
    msgType: 'reply',
    category: 'system',
  }))
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/main/messaging/__tests__/ExternalMessageGateway.test.ts`
Expected: fail until outbound rendering and outbox insertion are wired.

- [ ] **Step 3: Write minimal implementation**

```ts
constructor(
  agentService: AgentService,
  telegramAdapter: TelegramAdapter,
  insertOutbox: (row: any) => number = insertOutbox,
) {
  this.agentService = agentService
  this.telegramAdapter = telegramAdapter
  this.insertOutbox = insertOutbox
}

dispatchNotification(event: NotificationEvent): number {
  const payload = this.telegramAdapter.renderNotification(event)
  return this.insertOutbox({
    chatId: payload.chatId,
    bot: payload.bot,
    msgType: payload.msgType,
    category: 'system',
    message: payload.message,
  })
}
```

```ts
// TelegramService should stop hand-formatting long notification strings.
// Keep only transport helpers such as sendMessageSync, enqueueReply, and enqueueEdit if they are still needed by legacy flows.
```

- [ ] **Step 4: Run the test and make sure it passes**

Run: `npx vitest run src/main/messaging/__tests__/ExternalMessageGateway.test.ts src/main/telegram/__tests__/TelegramService.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/messaging src/main/telegram/TelegramService.ts src/main/telegram/__tests__/TelegramService.test.ts
git commit -m "feat: route outbound telegram notifications through protocol"
```

### Task 6: Verify the full boundary and capture any unrelated repo blockers

**Files:**
- No new code expected unless verification exposes a real gap

- [ ] **Step 1: Run the focused feature suite**

Run: `npx vitest run src/main/messaging/__tests__/ExternalMessageGateway.test.ts src/main/telegram/__tests__/TelegramAdapter.test.ts src/main/agent/__tests__/AgentService.external-message.test.ts src/main/telegram/__tests__/TelegramService.test.ts`
Expected: pass.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: clean once unrelated repo errors are fixed. If it still fails in `src/main/gongye-songge/PlanFirstCorrectionPipeline.ts` or `src/main/wallpaper/WallpaperToolBridge.ts`, record those as pre-existing blockers and do not widen this feature scope.

- [ ] **Step 3: Sanity-check the old gateway stays intact**

Run: `npx vitest run src/main/telegram/__tests__/OutboxWorker.test.ts src/main/telegram/__tests__/TelegramTargetRouter.test.ts`
Expected: pass, proving the tool gateway and target router were not disturbed.

- [ ] **Step 4: Commit the finished feature**

```bash
git add src/main/messaging src/main/agent src/main/telegram docs/superpowers/plans/2026-08-06-mio-external-message-gateway.md
git commit -m "feat: add mio external message gateway"
```

### Coverage Check

- Inbound normalization and Telegram payload isolation: Tasks 1 to 4
- Command parsing and `/clear` routing: Tasks 1 and 2
- Agent boundary cleanup: Task 3
- Outbound notification rendering and delivery: Task 5
- Regression and repo-level verification: Task 6
