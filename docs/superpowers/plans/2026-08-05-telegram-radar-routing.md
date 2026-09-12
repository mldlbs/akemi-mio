# Telegram Radar Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated Telegram target router so radar messages only send to a valid `radar_chat_id`, never fall back to another chat, and can start independently of generic push routing.

**Architecture:** Introduce a small `TelegramTargetRouter` module that centralizes destination resolution for `dialogue`, `push`, and `radar`. Integrate it into `TelegramService.initialize()` and the radar event handler so startup and send-time routing both fail closed for radar while preserving existing dialogue behavior.

**Tech Stack:** TypeScript, Vitest, Electron main-process services, existing `credentialsManager`, existing `eventBus`, existing `TelegramService` and `RadarPushScheduler`.

---

## File Structure

### New Files

- `src/main/telegram/TelegramTargetRouter.ts`
  - Single responsibility: resolve `push` and `radar` Telegram targets into explicit `configured` / `disabled` / `invalid` states.
- `src/main/telegram/__tests__/TelegramTargetRouter.test.ts`
  - Unit tests for router behavior and parsing rules.

### Modified Files

- `src/main/telegram/TelegramService.ts`
  - Replace inline `credentialsManager.get(...)` routing branches with the router.
  - Decouple generic push startup from radar startup.
  - Remove radar fallback to the current chat.
- `src/main/telegram/__tests__/TelegramService.test.ts`
  - Add integration-style service tests for missing, invalid, and valid radar routing.

## Task 1: Add Router Unit Tests First

**Files:**
- Create: `src/main/telegram/__tests__/TelegramTargetRouter.test.ts`
- Create: `src/main/telegram/TelegramTargetRouter.ts`

- [ ] **Step 1: Write the failing router tests**

Create `src/main/telegram/__tests__/TelegramTargetRouter.test.ts` with:

```ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../credentials/CredentialsManager', () => ({
  credentialsManager: { get: vi.fn() },
}))

import { credentialsManager } from '../../credentials/CredentialsManager'
import {
  resolveTelegramTarget,
  type TelegramTargetResolution,
} from '../TelegramTargetRouter'

describe('TelegramTargetRouter', () => {
  it('returns disabled when radar_chat_id is missing', () => {
    vi.mocked(credentialsManager.get).mockReturnValueOnce(null)

    expect(resolveTelegramTarget('radar')).toEqual({
      status: 'disabled',
      reason: 'missing radar_chat_id',
    } satisfies TelegramTargetResolution)
  })

  it('returns invalid when radar_chat_id is not numeric', () => {
    vi.mocked(credentialsManager.get).mockReturnValueOnce('abc')

    expect(resolveTelegramTarget('radar')).toEqual({
      status: 'invalid',
      reason: 'invalid radar_chat_id',
      rawValue: 'abc',
    } satisfies TelegramTargetResolution)
  })

  it('returns configured when radar_chat_id is numeric', () => {
    vi.mocked(credentialsManager.get).mockReturnValueOnce('-100123456')

    expect(resolveTelegramTarget('radar')).toEqual({
      status: 'configured',
      chatId: -100123456,
    } satisfies TelegramTargetResolution)
  })

  it('resolves push from credential before env fallback', () => {
    process.env.TELEGRAM_CHAT_ID = '2002'
    vi.mocked(credentialsManager.get).mockReturnValueOnce('1001')

    expect(resolveTelegramTarget('push')).toEqual({
      status: 'configured',
      chatId: 1001,
    } satisfies TelegramTargetResolution)
  })

  it('returns disabled when push target is absent in both credential and env', () => {
    delete process.env.TELEGRAM_CHAT_ID
    vi.mocked(credentialsManager.get).mockReturnValueOnce(null)

    expect(resolveTelegramTarget('push')).toEqual({
      status: 'disabled',
      reason: 'missing telegram_chat_id',
    } satisfies TelegramTargetResolution)
  })
})
```

- [ ] **Step 2: Run the router tests to verify they fail**

Run:

```bash
npm test -- src/main/telegram/__tests__/TelegramTargetRouter.test.ts
```

Expected:

```text
FAIL  src/main/telegram/__tests__/TelegramTargetRouter.test.ts
Error: Failed to resolve import "../TelegramTargetRouter"
```

- [ ] **Step 3: Write the minimal router implementation**

Create `src/main/telegram/TelegramTargetRouter.ts` with:

```ts
import { credentialsManager } from '../credentials/CredentialsManager'

export type TelegramTargetKind = 'push' | 'radar'

export type TelegramTargetResolution =
  | { status: 'configured'; chatId: number }
  | { status: 'disabled'; reason: string }
  | { status: 'invalid'; reason: string; rawValue?: string }

export function resolveTelegramTarget(kind: TelegramTargetKind): TelegramTargetResolution {
  if (kind === 'push') {
    const raw = credentialsManager.get('telegram_chat_id') || process.env.TELEGRAM_CHAT_ID || null
    return parseTarget(raw, 'telegram_chat_id')
  }

  const raw = credentialsManager.get('radar_chat_id')
  return parseTarget(raw, 'radar_chat_id')
}

function parseTarget(raw: string | null, key: 'telegram_chat_id' | 'radar_chat_id'): TelegramTargetResolution {
  if (!raw) {
    return {
      status: 'disabled',
      reason: `missing ${key}`,
    }
  }

  const chatId = parseInt(raw, 10)
  if (Number.isNaN(chatId)) {
    return {
      status: 'invalid',
      reason: `invalid ${key}`,
      rawValue: raw,
    }
  }

  return {
    status: 'configured',
    chatId,
  }
}
```

- [ ] **Step 4: Run the router tests to verify they pass**

Run:

```bash
npm test -- src/main/telegram/__tests__/TelegramTargetRouter.test.ts
```

Expected:

```text
PASS  src/main/telegram/__tests__/TelegramTargetRouter.test.ts
```

- [ ] **Step 5: Commit the router unit work**

Run:

```bash
git add src/main/telegram/TelegramTargetRouter.ts src/main/telegram/__tests__/TelegramTargetRouter.test.ts
git commit -m "test: add telegram target router"
```

## Task 2: Add Service-Level Failing Tests for Radar Startup and Routing

**Files:**
- Modify: `src/main/telegram/__tests__/TelegramService.test.ts`
- Modify: `src/main/telegram/TelegramService.ts`
- Test: `src/main/telegram/__tests__/TelegramService.test.ts`

- [ ] **Step 1: Write the failing TelegramService tests**

Append these tests to `src/main/telegram/__tests__/TelegramService.test.ts`:

```ts
import { radarPushScheduler } from '../radar/RadarPushScheduler'

vi.mock('../radar/RadarPushScheduler', () => ({
  radarPushScheduler: {
    start: vi.fn(),
    stop: vi.fn(),
  },
}))

it('does not start radar scheduler when radar_chat_id is missing', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(okJson({ queueLength: 0 }))
  const get = vi.mocked((await import('../../credentials/CredentialsManager')).credentialsManager.get)
  get.mockImplementation((name: string) => {
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
  const get = vi.mocked((await import('../../credentials/CredentialsManager')).credentialsManager.get)
  get.mockImplementation((name: string) => {
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
  const get = vi.mocked((await import('../../credentials/CredentialsManager')).credentialsManager.get)
  get.mockImplementation((name: string) => {
    if (name === 'telegram_enabled') return 'true'
    if (name === 'telegram_server_url') return 'https://test-telegram.local'
    if (name === 'radar_chat_id') return '-10099'
    if (name === 'telegram_chat_id') return null
    return null
  })

  await tg.initialize()

  expect(radarPushScheduler.start).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Run the TelegramService tests to verify they fail**

Run:

```bash
npm test -- src/main/telegram/__tests__/TelegramService.test.ts
```

Expected:

```text
FAIL  src/main/telegram/__tests__/TelegramService.test.ts
Expected "spy" to have been called 1 time, but it was called 0 times
```

- [ ] **Step 3: Integrate the router into TelegramService startup**

Update `src/main/telegram/TelegramService.ts` imports and startup logic:

```ts
import { resolveTelegramTarget } from './TelegramTargetRouter'
```

Replace the current push/radar startup branch in `initialize()` with:

```ts
const pushTarget = resolveTelegramTarget('push')
if (pushTarget.status === 'configured') {
  this.pushChatId = pushTarget.chatId
  log('INFO', 'telegram_push_enabled', { chatId: this.pushChatId })
  this.subscribePushEvents()
} else if (pushTarget.status === 'invalid') {
  log('WARN', 'telegram_push_target_invalid', {
    reason: pushTarget.reason,
    rawValue: pushTarget.rawValue,
  })
}

const radarTarget = resolveTelegramTarget('radar')
if (radarTarget.status === 'configured') {
  log('INFO', 'telegram_radar_enabled', { chatId: radarTarget.chatId })
  this.subscribeRadarEvents()
  radarPushScheduler.start()
} else if (radarTarget.status === 'disabled') {
  log('INFO', 'telegram_radar_target_disabled', { reason: radarTarget.reason })
} else {
  log('WARN', 'telegram_radar_target_invalid', {
    reason: radarTarget.reason,
    rawValue: radarTarget.rawValue,
  })
}
```

Add a new method that contains only radar event subscriptions:

```ts
private radarEventsSubscribed = false

private subscribeRadarEvents(): void {
  if (this.radarEventsSubscribed) return
  this.radarEventsSubscribed = true

  eventBus.on('radar.push.rule_fired', (p: any) => {
    const target = resolveTelegramTarget('radar')
    if (target.status !== 'configured') {
      if (target.status === 'disabled') {
        log('INFO', 'telegram_radar_drop_unconfigured', { reason: target.reason })
      } else {
        log('WARN', 'telegram_radar_drop_invalid_target', {
          reason: target.reason,
          rawValue: target.rawValue,
        })
      }
      return
    }

    this.enqueueReply(target.chatId, p.message, 'radar')
  })
}
```

Leave all non-radar event subscriptions inside `subscribePushEvents()`.

- [ ] **Step 4: Run the TelegramService tests to verify they pass**

Run:

```bash
npm test -- src/main/telegram/__tests__/TelegramService.test.ts
```

Expected:

```text
PASS  src/main/telegram/__tests__/TelegramService.test.ts
```

- [ ] **Step 5: Commit the startup decoupling work**

Run:

```bash
git add src/main/telegram/TelegramService.ts src/main/telegram/__tests__/TelegramService.test.ts
git commit -m "feat: decouple telegram radar routing"
```

## Task 3: Add Strict Send-Time Radar Routing Tests

**Files:**
- Modify: `src/main/telegram/__tests__/TelegramService.test.ts`
- Modify: `src/main/telegram/TelegramService.ts`
- Test: `src/main/telegram/__tests__/TelegramService.test.ts`

- [ ] **Step 1: Write the failing send-time routing tests**

Add these tests to `src/main/telegram/__tests__/TelegramService.test.ts`:

```ts
it('does not enqueue radar message when radar target is missing at send time', async () => {
  const get = vi.mocked((await import('../../credentials/CredentialsManager')).credentialsManager.get)
  get.mockImplementation((name: string) => {
    if (name === 'telegram_enabled') return 'true'
    if (name === 'telegram_server_url') return 'https://test-telegram.local'
    if (name === 'radar_chat_id') return null
    if (name === 'telegram_chat_id') return '555'
    return null
  })

  const enqueueReply = vi.spyOn(tg as any, 'enqueueReply')
  ;(tg as any).subscribeRadarEvents()
  eventBus.emit('radar.push.rule_fired', { message: 'radar payload' } as any)

  expect(enqueueReply).not.toHaveBeenCalled()
})

it('enqueues radar message to radar_chat_id instead of push chat', async () => {
  const get = vi.mocked((await import('../../credentials/CredentialsManager')).credentialsManager.get)
  get.mockImplementation((name: string) => {
    if (name === 'telegram_enabled') return 'true'
    if (name === 'telegram_server_url') return 'https://test-telegram.local'
    if (name === 'radar_chat_id') return '999'
    if (name === 'telegram_chat_id') return '555'
    return null
  })

  const enqueueReply = vi.spyOn(tg as any, 'enqueueReply').mockImplementation(() => {})
  ;(tg as any).subscribeRadarEvents()
  eventBus.emit('radar.push.rule_fired', { message: 'radar payload' } as any)

  expect(enqueueReply).toHaveBeenCalledWith(999, 'radar payload', 'radar')
  expect(enqueueReply).not.toHaveBeenCalledWith(555, 'radar payload', 'radar')
})
```

- [ ] **Step 2: Run the TelegramService tests to verify they fail**

Run:

```bash
npm test -- src/main/telegram/__tests__/TelegramService.test.ts
```

Expected:

```text
FAIL  src/main/telegram/__tests__/TelegramService.test.ts
Expected "spy" not to have been called
```

- [ ] **Step 3: Remove radar fallback logic from subscribePushEvents**

Delete the current inline radar handler from `subscribePushEvents()`:

```ts
eventBus.on('radar.push.rule_fired', (p: any) => {
  const rawChatId = credentialsManager.get('radar_chat_id')
  const targetChatId = rawChatId ? parseInt(rawChatId, 10) : chatId
  if (!isNaN(targetChatId)) {
    this.enqueueReply(targetChatId, p.message, 'radar')
  }
})
```

Ensure only `subscribeRadarEvents()` owns `radar.push.rule_fired`.

- [ ] **Step 4: Run the TelegramService tests to verify they pass**

Run:

```bash
npm test -- src/main/telegram/__tests__/TelegramService.test.ts
```

Expected:

```text
PASS  src/main/telegram/__tests__/TelegramService.test.ts
```

- [ ] **Step 5: Commit the strict send-time routing work**

Run:

```bash
git add src/main/telegram/TelegramService.ts src/main/telegram/__tests__/TelegramService.test.ts
git commit -m "test: enforce strict radar telegram target"
```

## Task 4: Run Focused Verification

**Files:**
- Modify: none expected
- Test: `src/main/telegram/__tests__/TelegramTargetRouter.test.ts`
- Test: `src/main/telegram/__tests__/TelegramService.test.ts`

- [ ] **Step 1: Run the focused Telegram test suite**

Run:

```bash
npm test -- src/main/telegram/__tests__/TelegramTargetRouter.test.ts src/main/telegram/__tests__/TelegramService.test.ts
```

Expected:

```text
PASS  src/main/telegram/__tests__/TelegramTargetRouter.test.ts
PASS  src/main/telegram/__tests__/TelegramService.test.ts
```

- [ ] **Step 2: Run typecheck to catch signature drift**

Run:

```bash
npm run typecheck
```

Expected:

```text
Found 0 errors
```

- [ ] **Step 3: Inspect the final diff for routing-only scope**

Run:

```bash
git diff -- src/main/telegram/TelegramTargetRouter.ts src/main/telegram/TelegramService.ts src/main/telegram/__tests__/TelegramTargetRouter.test.ts src/main/telegram/__tests__/TelegramService.test.ts
```

Expected:

```text
Only router, TelegramService, and telegram tests are changed
```

- [ ] **Step 4: Create the final implementation commit**

Run:

```bash
git add src/main/telegram/TelegramTargetRouter.ts src/main/telegram/TelegramService.ts src/main/telegram/__tests__/TelegramTargetRouter.test.ts src/main/telegram/__tests__/TelegramService.test.ts
git commit -m "feat: add strict telegram radar routing"
```

## Spec Coverage Check

- Router introduction: covered by Task 1.
- Radar/push startup decoupling: covered by Task 2.
- Strict send-time fail-closed radar routing: covered by Task 3.
- Verification and regression safety: covered by Task 4.

## Self-Review

- Placeholder scan: no `TODO`, `TBD`, or “implement later” placeholders remain.
- Type consistency: plan consistently uses `resolveTelegramTarget`, `TelegramTargetResolution`, `subscribeRadarEvents`, and `radarEventsSubscribed`.
- Scope check: plan stays within Telegram routing and Telegram tests only; it does not expand into outbox or scheduler redesign.
