# Telegram Radar Routing Design

## Summary

This design fixes the current Telegram radar delivery ambiguity by introducing a small routing layer for Telegram targets. The new layer separates `dialogue`, `push`, and `radar` destinations so that commercial radar messages are only sent when `radar_chat_id` is explicitly configured and valid.

## Problem

The current implementation has two coupled issues:

1. Radar delivery falls back to the current chat when `radar_chat_id` is missing.
2. Radar startup is implicitly tied to generic push startup via `telegram_chat_id`.

This creates silent misrouting: radar messages can appear in a private chat or a generic push channel even when radar-specific routing is missing or incorrect.

## Goals

- Enforce fail-closed delivery for radar messages.
- Decouple radar routing from generic Telegram push routing.
- Centralize Telegram destination resolution in one small module.
- Preserve current behavior for user dialogue messages.
- Add tests that lock routing behavior in place.

## Non-Goals

- Reworking the outbox transport layer.
- Changing radar message formatting.
- Introducing a broader notification policy system.
- Refactoring unrelated Telegram event subscriptions.

## Proposed Design

### 1. Telegram Target Router

Add a lightweight routing module under `src/main/telegram/` that resolves Telegram destinations for three message classes:

- `dialogue`
- `push`
- `radar`

The router will return a structured result instead of a best-effort chat ID.

Example result shape:

```ts
type TelegramTargetKind = 'dialogue' | 'push' | 'radar'

type TelegramTargetResolution =
  | { status: 'configured'; chatId: number }
  | { status: 'disabled'; reason: string }
  | { status: 'invalid'; reason: string; rawValue?: string }
```

Resolution rules:

- `dialogue`: uses the current inbound Telegram chat context, not stored credentials.
- `push`: resolves from `telegram_chat_id` credential first, then `TELEGRAM_CHAT_ID` env fallback.
- `radar`: resolves only from `radar_chat_id`.

`radar` must never fall back to `dialogue` or `push`.

### 2. Startup Decoupling

`TelegramService.initialize()` will resolve `push` and `radar` independently.

Startup resolution only decides whether the corresponding subscriptions and scheduler are activated. Actual outbound sends continue to use the router at send time so that current credential state remains authoritative.

Generic push behavior:

- If `push` is `configured`, subscribe generic push events.
- If `push` is `disabled`, skip generic push startup.
- If `push` is `invalid`, log a configuration error and skip generic push startup.

Radar behavior:

- If `radar` is `configured`, subscribe radar-specific events and start `radarPushScheduler`.
- If `radar` is `disabled`, log that radar delivery is not configured and do not start the scheduler.
- If `radar` is `invalid`, log a configuration error and do not start the scheduler.

This ensures radar can run without `telegram_chat_id`, and generic push can run without `radar_chat_id`.

### 3. Send-Time Enforcement

All radar delivery paths will use the router’s `radar` resolution.

Required behavior:

- If `radar` is `configured`, send to the resolved `radar_chat_id`.
- If `radar` is `disabled` or `invalid`, do not enqueue a radar message.
- No fallback to the current chat.
- No fallback to the generic push target.

This changes radar delivery from best-effort to explicit-only routing.

### 4. Responsibilities

- `RadarPushScheduler`: decides when radar messages should fire and what message payload to emit.
- `TelegramTargetRouter`: decides where each Telegram message class is allowed to go.
- `TelegramService`: subscribes to events and delivers messages using router decisions.

This keeps timing, routing, and transport concerns separate.

## Data Flow

### Radar

1. `TelegramService.initialize()` resolves the `radar` target.
2. If `configured`, it starts `radarPushScheduler` and subscribes to `radar.push.rule_fired`.
3. `RadarPushScheduler` emits `radar.push.rule_fired`.
4. `TelegramService` resolves `radar` again at send time.
5. If still `configured`, it enqueues the radar message to the resolved radar chat.
6. Otherwise, it logs and drops the message.

### Generic Push

1. `TelegramService.initialize()` resolves the `push` target.
2. If `configured`, it subscribes generic system event handlers.
3. Matching events enqueue to the resolved push chat only.

### Dialogue

1. Incoming Telegram message provides the runtime chat ID.
2. Reply and progress messages continue to use that current chat ID directly.

## Error Handling

### Configuration Errors

For `radar_chat_id`:

- Missing value: return `disabled`, log `telegram_radar_target_disabled`.
- Non-numeric or invalid value: return `invalid`, log `telegram_radar_target_invalid`.

For `telegram_chat_id`:

- Missing value: return `disabled`, skip generic push subscriptions.
- Non-numeric or invalid value: return `invalid`, log `telegram_push_target_invalid`.

These are configuration-state outcomes, not runtime exceptions.

### Runtime Delivery Errors

If the resolved target is valid but message delivery fails later in outbox or proxy transport:

- Preserve current delivery retry/failure behavior.
- Log as transport failure, not configuration failure.

This keeps “wrong target config” distinct from “failed to send”.

## Testing Strategy

Write tests before implementation for these scenarios:

1. `radar_chat_id` missing:
   - radar target resolves to `disabled`
   - radar scheduler does not start
   - radar events do not enqueue messages

2. `radar_chat_id` invalid:
   - radar target resolves to `invalid`
   - radar scheduler does not start
   - radar events do not enqueue messages

3. `radar_chat_id` valid and `telegram_chat_id` missing:
   - radar scheduler starts
   - radar events enqueue to the radar chat
   - generic push remains disabled

4. Both `radar_chat_id` and `telegram_chat_id` valid:
   - radar messages go only to the radar chat
   - generic push messages go only to the push chat
   - no cross-routing occurs

5. Router unit tests:
   - credential-first resolution for `push`
   - radar env fallback is not allowed
   - malformed values are surfaced as `invalid`

## Implementation Boundaries

Expected files:

- New: `src/main/telegram/TelegramTargetRouter.ts`
- Update: `src/main/telegram/TelegramService.ts`
- Update: `src/main/telegram/__tests__/TelegramService.test.ts`
- New or update: router unit tests under `src/main/telegram/__tests__/`

No changes are required in `RadarPushScheduler` beyond continuing to emit radar events.

## Risks

- If radar target resolution is cached too aggressively, runtime credential changes may not take effect until restart.
- If routing logic is spread between startup and event handlers, behavior may drift again.

Mitigation:

- Keep routing logic centralized in one module.
- Make tests assert both startup behavior and send-time behavior.

## Recommendation

Implement the small router now rather than patching the existing branch logic in place. It solves the immediate radar misrouting bug while creating a clean extension point for future dedicated Telegram channels such as alerts or monitoring.
