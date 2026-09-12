# Runtime Health Analysis — 2026-06-23

> **Author:** Runtime Review (log analysis, 2026-06-23)
>
> **Scope:** `app-2026-06-22.log` (33K lines) + `app-2026-06-23.log` (16K lines)
>
> **Status:** Architecture finding — not a bug report

---

## Prologue: What prompted this review

A routine log analysis of two daily log files (~49K lines) revealed four seemingly independent problems:

| # | Symptom | Volume |
|---|---------|--------|
| 1 | writing-system MCP connects then dies within seconds | 571 restart attempts / 18h |
| 2 | DeepSeek 400 "orphaned tool_call" errors | 9 conversations killed |
| 3 | chat_json_timeout at fixed :16 past each hour | 18 consecutive hours |
| 4 | uumit_no_api_key every 30s, no key configured | 2,116 WARN entries / 13% of log |

Each is individually non-critical. Together they reveal a shared architectural gap.

---

## Part 1: Capability Set Drift

### Observation

writing-system MCP reports `connected: true` but its advertised tool set silently shrinks from **28 → 20** across restart cycles. The system registers connection success — and continues routing requests to a dead server.

```log
23:15:33.760 INFO mcp_connected name=writing-system tools=20   ← connected
23:15:37.xxx  WARN mcp_server_detected_dead                     ← dead in ~4s
23:15:37.xxx  INFO mcp_server_restarting_backoff attempt=22     ← restart
```

This repeats 571 times in 18 hours without any escalation.

### Root cause

The health model conflates two distinct states:

```
Connection Health (socket alive) ≠ Capability Health (tool set intact)
```

Current code treats `mcp.connected` as sufficient proof of health:

```ts
if (mcp.connected) { healthy = true; }
```

This is false. An MCP server can hold a perfect SSE connection while its backing processes have crashed, leaving a stale/empty tool registry.

### Design principle: Connection ≠ Capability

```
┌─────────────────────────────────────────────────────────────┐
│                     Capability Health                        │
│                                                             │
│   connected: boolean       ← transport-level               │
│   expectedTools: number    ← from registry / first connect │
│   actualTools: number      ← from tools/list response      │
│   missingTools: string[]   ← diff(current, previous)       │
│   healthScore: number      ← composite                     │
└─────────────────────────────────────────────────────────────┘
```

A server that connects with fewer tools than expected must be flagged as **degraded**, not healthy. A server that fails health checks N times consecutively must be **isolated**, not retried forever.

### Applicability

This is not specific to writing-system. Every MCP server (filesystem, browser, git, memory) can exhibit the same pattern: connection alive, capabilities dead.

---

## Part 2: Context Integrity & State Corruption

### Observation

The DeepSeek 400 error follows a deterministic pattern:

```
[checkpoint restored with dirty history]
  → assistant emits tool_call without matching tool response
    → DeepSeek rejects: 400 "insufficient tool messages"
      → trim + retry
        → checkpoint restored again (still dirty)
          → 400 again
```

The system interpreted the 400 as a transient failure and applied `retry`. But the 400 is not transient — it signals **state corruption**. Retrying a corrupted state cannot succeed, because the corruption is replayed on every recovery.

### Root cause

The error classification lacks a semantic distinction between failure types:

| Type | Example | Strategy |
|------|---------|----------|
| **Transient** | 429, 502, timeout | retry |
| **State Corruption** | orphaned tool_call, invalid history ordering, message protocol violation | **rollback** |

Applying `retry` to a `State Corruption` error is worse than useless — it burns API calls, user time, and conversation continuity, then fails anyway.

### Design principle: Classify before deciding

```
Error
  ├─ Transient ──→ retry (with backoff)
  ├─ State ──────→ rollback to last known-clean checkpoint
  ├─ Capacity ───→ degrade / shed load
  └─ Unknown ────→ isolate + human escalation
```

Concretely, an HTTP 400 with message-body pattern `tool_calls must be followed by tool messages` is never transient. The only correct response is:

1. Discard the current checkpoint
2. Restore the previous checkpoint whose integrity hash matches
3. Notify the user: "恢复中，请稍候"

### Broader implication

This principle applies across every model provider (Claude, OpenAI, Gemini, DeepSeek) — all enforce the same tool-calling protocol invariants. A fix scoped to one provider would be incomplete.

---

## Part 3: Task Health & Run-Forever Failure

### Observation

A background task (`reflect_req_*`) hits a 30-second LLM timeout at **every hour on the 16th minute**, 18 hours straight:

```log
00:16:00 ERROR chat_json_timeout elapsed_ms=30000
01:16:00 ERROR chat_json_timeout elapsed_ms=30000
02:16:00 ERROR chat_json_timeout elapsed_ms=30000
...
17:16:00 ERROR chat_json_timeout elapsed_ms=30000
```

The task never adapts, never stops, and never escalates.

### Root cause

The task scheduler does not distinguish task criticality:

| Tier | Examples | Failure Policy |
|------|----------|----------------|
| **CRITICAL** | user reply, TTS | retry, alert if blocked |
| **IMPORTANT** | memory write, insight | retry N times, then skip |
| **BEST_EFFORT** | reflect, meta-review, inspiration | fail → log → skip |

When a BEST_EFFORT task fails 50+ times identically, the system should auto-disable it (or at minimum widen its interval / timeout). Instead, it runs forever in a failure loop, consuming budget and generating noise.

### Design principle: Tasks need tiers

```ts
enum TaskTier {
  CRITICAL,    // user-facing, must succeed
  IMPORTANT,   // system health, retry with limit
  BEST_EFFORT, // nice-to-have, skip on failure
}
```

Task health metadata should include:
- `consecutiveFailures`
- `lastFailureTimestamp`
- `autoDisableAt` (threshold)

And the scheduler should enforce: if `consecutiveFailures > autoDisableAt`, suspend the task.

---

## Part 4: Service Governance

### Observation

UUMIT service polls for tasks every 30 seconds. It has never had an API key:

```log
INF credential_get name=uumit_api_key
WRN uumit_no_api_key
INF uumit_reconnect_scheduled delayMs=30000 attempt=1634
```

This produces 2,880 WARN entries per day (13% of total log volume).

### Root cause

The service starts successfully even when its preconditions are not met. There is no `preflight` gate that checks configuration completeness before entering the run loop. Once started, there is no mechanism to self-disable after repeated precondition failures.

### Design principle: Known impossible tasks must not run

```ts
class Service {
  async start() {
    const key = await this.getCredential('api_key');
    if (!key) {
      this.log.warn('service_disabled', 'missing credential');
      return; // don't start
    }
    // ... actual init
  }
}
```

And for runtime:

```ts
if (consecutivePreconditionFailures > threshold) {
  this.disable('precondition_not_met');
}
```

This is not about UUMIT specifically. It applies to any service with external dependencies (MCP servers, API keys, database connections, file paths).

---

## Synthesis: The missing layer

These four problems share a root cause:

```
                    ┌─────────────────────────┐
                    │  Current Architecture    │
                    │                          │
                    │  Detect  ✓               │
                    │  React   ✗               │
                    │  Recover ✗               │
                    │  Isolate ✗               │
                    └──────────────────────────┘
```

The system observes anomalies but has no mechanism to turn observation into decision. Each component handles failure in isolation (or not at all), leading to the four pathologies documented above.

What is missing is a **Runtime Health Management** layer — a centralized system that:

1. Collects health signals from all subsystems
2. Classifies failures by type (transient / state / capacity)
3. Decides the appropriate action (retry / rollback / degrade / isolate)
4. Executes recovery with user-visible feedback

---

## Appendix: Proposed Phase 5 — Runtime Reliability

### Phase 5.1 — Runtime Health Manager

Central health scoring for four dimensions:
- **Session Health** — context integrity, checkpoint validity
- **Capability Health** — MCP tool set drift, connection fidelity
- **Task Health** — consecutive failures, timeout patterns, tier compliance
- **Model Health** — provider error rates, latency percentiles, budget usage

### Phase 5.2 — Capability Registry

- Tool inventory: expected vs. actual tool set per MCP server
- Tool diff: detect `28 → 20` style drift
- Capability scoring: `healthScore` per server, composite for the system
- Degradation broadcast: events emitted when capability crosses threshold

### Phase 5.3 — Session Governor

- Checkpoint health verification before restore
- Context integrity hash (detect orphaned tool_calls before sending)
- Rollback-on-corruption: restore last known-clean state on 400-class state errors
- Recovery notification: send user-visible message during rollback

### Phase 5.4 — Failure Recovery Framework

Unified decision tree:

```
Error Event
  ├─ Transient ──→ retry (exp backoff, max N)
  ├─ State ──────→ rollback checkpoint → retry
  ├─ Capacity ───→ degrade: disable non-critical → retry
  └─ Unknown ────→ isolate: disable component → notify human
```

### Phase 5.5 — User-visible Degradation Layer

Replace silent failure patterns with transparent status:

- "写作服务暂时不可用，已切换为本地模式"
- "网络不稳定，回复速度可能变慢"
- "检测到会话异常，正在恢复……"
- "后台任务超时，已跳过本次分析"

---

## Appendix: Key design principles (summary)

| # | Principle | Derived from |
|---|-----------|-------------|
| 1 | Connection health ≠ capability health | MCP tools 28→20 drift |
| 2 | State corruption requires rollback, not retry | DeepSeek 400 loop |
| 3 | Tasks need tiers + auto-disable | 18h continuous timeout |
| 4 | Known-impossible tasks must not run | uumit 1634× no-key polling |
| 5 | Error classification precedes error handling | All four symptoms |
