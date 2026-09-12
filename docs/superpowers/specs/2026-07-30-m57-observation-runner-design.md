# M5.7 Observation Runner Design

> **For agentic workers:** This document freezes the M5.7 observation runner design only. It does not grant capability-first authority or permit runtime behavior migration.

**Goal:** Automatically grow the M5.7 Shadow Observation Window by generating controlled real chat traffic through Mio's existing chat path, then collecting observation artifacts until the evidence gate is reached.

**Architecture:** Keep legacy Evolution authority unchanged. Launch the Electron app externally, drive real chat requests through the existing preload-exposed chat API, let normal tool execution write telemetry, and collect observation snapshots out-of-band. The runner is an observation infrastructure layer, not an Evolution behavior change.

**Tech Stack:** TypeScript, Playwright Electron driver, existing `window.electronAPI.chat(...)` preload API, `ai:chat` IPC handler, M5.6 observation scripts, JSON artifact persistence.

---

## 1. Scope

This phase adds a controlled observation runner for M5.7 only. It expands evidence collection and automation around the existing runtime, but does not change Evolution authority.

### In Scope

- runner process that launches or reconnects to Mio
- real chat-task scheduling through the existing chat entry
- observation snapshot collection
- runner status and final report artifacts
- gate-based auto-stop behavior
- recovery and restart policy for unstable runtime sessions

### Out of Scope

- capability authority cutover
- executor migration
- collector replacement
- `ProblemQueue` authority changes
- tool identity removal
- synthetic telemetry writes
- direct DOM clicking as the primary task path

## 2. Existing Assets

The runner builds on assets already present in the repository:

- M5.6 shadow observation scripts:
  - `scripts/m56-observation-window.ts`
  - `scripts/m56-shadow-observe.ts`
- preload chat API:
  - `window.electronAPI.chat(...)`
- main-process chat entry:
  - `ai:chat`
  - `AgentService.processTextInput()`
  - `ChatExecutor`
- existing Electron automation precedent:
  - `scripts/trigger-retrieval-scoring.mjs`
- M5.6.4 migration artifacts and frozen authority boundaries

## 3. Runner Contract

### 3.1 Runtime Path

The runner must use Mio's real chat path and allow tool execution to occur normally:

```text
M57ObservationRunner
    -> Playwright Electron launcher
    -> Mio renderer window
    -> window.electronAPI.chat(...)
    -> ai:chat
    -> AgentService.processTextInput()
    -> ChatExecutor
    -> tool execution
    -> tool_call_log.json
    -> observation snapshot scripts
```

### 3.2 Entry Semantics

- The runner targets the existing chat API, not a new private bypass.
- The runner may use Playwright Electron to reach the preload API from the renderer.
- The runner must not write directly to `toolCallLogStore`.
- Browser tasks are allowed, but browser automation is not required for every cycle.

### 3.3 Internal Modules

The design separates responsibilities into five modules inside the runner:

1. `AppController`
   - validate app build output
   - launch Electron
   - wait for the first window
   - verify `window.electronAPI.chat` availability

2. `TaskScheduler`
   - pick the next real task from the weighted prompt pool
   - maintain capability distribution balance
   - rotate session ids when needed

3. `ChatDriver`
   - submit one chat task
   - await completion
   - normalize reply/error results

4. `ObservationCollector`
   - run existing observation snapshot logic
   - confirm event growth
   - persist observation artifacts

5. `GateController`
   - evaluate stop conditions
   - manage restarts and failure budgets
   - emit final report

## 4. Task Scheduling Contract

### 4.1 Capability Weights

The default task mix must bias toward stable real traffic while still sampling browser behavior:

- `system.execution`: `30%`
- `file.management`: `30%`
- `search.retrieval`: `30%`
- `browser.automation`: `10%`

### 4.2 Prompt Pool Rules

- Each capability class uses a prompt pool, not a single repeated prompt.
- Prompts should resemble real user requests, not synthetic benchmark commands.
- Repeated prompts are allowed only if the pool is exhausted, and should be rotated rather than sent consecutively when possible.
- Browser prompts should prefer publicly reachable sites and may prefer domestic/public sites when external availability is uncertain.

### 4.3 Dispatch Rules

- The runner is strictly single-task serial.
- A new chat task is sent only after the previous task finishes and a snapshot is collected.
- The scheduler may temporarily down-weight an overrepresented capability class.
- Browser failures must not block continued non-browser sampling.

### 4.4 Session Policy

- Session ids may be reused for a short batch to preserve realistic multi-turn behavior.
- Session ids must rotate periodically to avoid overcoupling unrelated tasks into one context.
- Long-lived stale sessions should be reset on restart.

## 5. Observation Contract

### 5.1 Snapshot Sources

The runner reuses existing observation tooling rather than creating new telemetry formats:

- `m56-observation-window` for identity coverage and capability distribution
- `m56-shadow-observe` for shadow aggregation and trend signals

### 5.2 Valid Growth Rule

A task only counts as effective sampling when:

- the chat call returns without fatal runner error, and
- the observation snapshot shows new tool events

This prevents false progress from empty assistant replies or no-tool turns.

### 5.3 Output Artifacts

The runner writes to:

```text
reports/m57/observation/
  latest.json
  history.jsonl
  runner_status.json
  final-report.json
```

Artifact roles:

- `latest.json`: most recent observation snapshot
- `history.jsonl`: append-only snapshot history
- `runner_status.json`: runner control-plane status
- `final-report.json`: gate summary for M5.7 review

## 6. Recovery Contract

### 6.1 Failure Classes

The runner distinguishes four failure classes:

1. `launch_failure`
   - app build missing
   - Electron launch failed
   - first window timeout

2. `chat_path_failure`
   - preload chat API missing
   - `PAUSED`
   - `INTERNAL`
   - `CIRCUIT_OPEN`

3. `task_local_failure`
   - one prompt failed
   - one tool failed
   - one browser task failed

4. `stalled_growth`
   - chat completed but snapshots did not grow for consecutive rounds

### 6.2 Recovery Actions

- `launch_failure`
  - retry with backoff
  - exit after threshold breach with status artifact

- `chat_path_failure`
  - query agent status
  - resume agent if paused
  - retry once with a different prompt of the same class
  - restart Electron if still failing

- `task_local_failure`
  - record the failure
  - keep the observation window
  - continue with the next task

- `stalled_growth`
  - switch capability class
  - retry growth
  - restart the app if repeated stalls persist

### 6.3 Restart Policy

The runner may proactively restart the app:

- after `N` tasks in one app session
- after `T` minutes in one app session
- after repeated chat path failures
- after repeated stalled-growth windows

Every restart must re-validate:

- app window loaded
- `window.electronAPI.chat` available
- agent not paused

## 7. Gate Contract

The runner stops automatically when evidence thresholds are satisfied, but it never grants authority change.

### 7.1 Target Thresholds

- tool events `>= 1000`
- capability events `>= 300`
- capability types `>= 4`
- aggregation gain stable across consecutive windows
- no new unexplained source mismatch spikes

### 7.2 Runner Outcome Semantics

- `complete`
  - evidence target reached
  - final report written
  - authority review still not granted

- `hold`
  - app/runtime still recoverable
  - keep observing

- `failed`
  - runner cannot continue safely
  - write terminal status artifact

### 7.3 Non-Authority Rule

A successful runner completion means:

> M5.7 observation evidence is ready for review.

It does **not** mean:

- capability-first decision is approved
- authority cutover is approved
- executor migration may begin

## 8. CLI Contract

The runner should support the following parameters:

- `--targetToolEvents=1000`
- `--targetCapabilityEvents=300`
- `--since=2026-07-29T15:40:00+08:00`
- `--persistDir=<path>`
- `--outDir=reports/m57/observation`
- `--maxTasksPerApp=20`
- `--maxMinutesPerApp=30`
- `--pollMs=3000`
- `--maxConsecutiveFailures=5`
- `--browserWeight=0.1`
- `--dryRun`

### 8.1 Dry Run

`--dryRun` only verifies:

- app can launch
- preload chat API is reachable
- observation snapshot can be collected

It must not send real sampling tasks.

## 9. Final Report Contract

`final-report.json` should include at least:

```json
{
  "startedAt": "",
  "finishedAt": "",
  "since": "",
  "toolEvents": 0,
  "capabilityEvents": 0,
  "coverage": 0,
  "capabilityTypes": [],
  "aggregationGain": 0,
  "trendCorrelation": 0,
  "taskCounts": {},
  "failureCounts": {},
  "gateReached": false,
  "authorityReviewGranted": false
}
```

The field `authorityReviewGranted` remains `false` for all M5.7 runner outputs.

## 10. Governance Boundaries

This design freezes the following invariants:

- Legacy Evolution authority remains active
- capability observation remains shadow-only
- executor authority remains legacy-only
- no synthetic telemetry writes are permitted
- browser sampling is optional evidence enrichment, not a global blocker
- runner success must never be interpreted as cutover approval

## Status

**M5.7 Status:** Design Frozen  
**Authority:** No capability-first execution authority granted  
**Next:** Implementation plan for observation runner infrastructure only
