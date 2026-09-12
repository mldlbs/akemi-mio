# Capability-First Raw Boost Guard Design

> **For agentic workers:** This document defines a narrow Phase C prerequisite. It does not remove raw tool fallback, does not redesign Memory, and does not authorize capability-priority ranking.

**Goal:** Prevent tool-level memory or analytics priority boosts from pulling LLM selection back toward raw tools while `capability-first` schema exposure is active.

**Status Baseline:** Capability-aware Memory write and recall are already present. The remaining risk is raw tool schema ordering when code paths still ask `ServerManager.getAllSchemas()` for raw schemas.

**Architecture Direction:** Keep capability-first selection space capability-led. Raw tool boost remains valid for legacy or dual raw-schema exposure, but it must not influence capability-first schema exposure.

## 1. Purpose

ADR-015 moved the main LLM tool surface toward capability-first mode:

```text
LLM sees capability schemas + call_raw_tool fallback
```

Memory has also moved beyond pure tool identity:

```text
postCall(toolName, ...)
  -> CapabilityResolver.resolveByTool(toolName)
  -> Memory structuredData.identity

preCall(toolName, ...)
  -> capability:{id} operation:{op} tool:{toolName}
  -> capability-aware recall query
```

The remaining Phase C risk is narrower: `ServerManager.getAllSchemas()` still reorders raw tool schemas using tool-level memory and analytics boosts. In capability-first mode, that raw-tool ordering should not become an indirect preference signal.

## 2. Scope

### In Scope

- Guarding raw tool schema priority boosts from affecting capability-first exposure.
- Preserving raw fallback through `call_raw_tool`.
- Preserving Memory `preCall` and `postCall` capability identity behavior.
- Adding regression tests that prove capability-first schemas are stable even when raw tool priority data exists.
- Documenting the current M5.5/M5.6 state without reopening ADR-015 design decisions.

### Out of Scope

- Removing raw tool schemas from the system.
- Removing `call_raw_tool`.
- Replacing `ToolPriorityInfo.toolName` with capability priority.
- Rewriting `MemoryAwareInterceptor` statistics storage.
- Changing persisted memory schema.
- Changing `BehaviorPredictor`, `ToolCallLogStore`, or evolution analytics identity contracts.
- Tuning actual priority boost values.

## 3. Current State

The current implementation has three relevant layers:

```text
MemoryAwareInterceptor
  -> stores capability-aware memory entries
  -> builds capability-aware recall queries
  -> still computes toolName-keyed priority boosts

ServerManager.getAllSchemas()
  -> builds raw tool schemas
  -> sorts raw schemas using memory and analytics priority boosts

ToolSchemaProvider
  -> dual: raw tool schemas + capability schemas
  -> capability-first: capability schemas + call_raw_tool
```

This means the capability-first path is mostly protected, because `ToolSchemaProvider.getCapabilityFirstSchemas()` does not call `ServerManager.getAllSchemas()`. The guard still matters because future changes or fallback helpers may accidentally reuse raw-prioritized schemas inside capability-first mode.

## 4. Design

### 4.1 Raw Priority Is Mode-Scoped

Raw tool priority boost is valid only when raw tools are intentionally exposed as individual functions.

Allowed:

```text
dual mode
  -> raw tool schemas may be sorted by tool-level priority

legacy direct raw schema consumers
  -> raw tool schemas may be sorted by tool-level priority
```

Not allowed:

```text
capability-first LLM schema exposure
  -> raw tool priority must not affect schema order
  -> raw tool priority must not create extra raw schemas
  -> raw tool priority must not reorder capability schemas
  -> raw tool priority must not reorder call_raw_tool
```

### 4.2 Capability-First Schema Contract

When `ToolSchemaProvider.getMode() === 'capability-first'`, `getSchemas()` returns:

```text
CapabilityFunctionSchemaAdapter.buildSchemas()
  + call_raw_tool
```

The returned list must not depend on:

- `ServerManager.getAllSchemas()` ordering
- `MemoryAwareInterceptor.getToolPriorities()`
- `toolAnalytics.getPriorityRecommendations()`
- raw tool success frequency
- raw tool feedback state

### 4.3 Raw Fallback Contract

`call_raw_tool` remains available and unchanged.

The guard does not block explicit fallback. It only ensures fallback stays an explicit selection made through the fallback function, not an implicit consequence of raw tool schema priority.

### 4.4 Observability

If logging is added or changed during implementation, it should report mode and source clearly:

```text
tool_schema_provider.capability_first
  capabilityCount
  hasFallback
```

No new runtime event family is required for this guard.

## 5. Impact Analysis

### L0 Target Files

- `src/main/tool/ToolSchemaProvider.ts`
- `src/main/tool/__tests__/P1_3b_exit_gate.test.ts`

### L1 Direct Dependents

- `src/main/llm/LlmService.ts` receives schemas through `ToolSchemaProvider`.
- `src/main/tool/ToolInvocationRouter.ts` dispatches selected capability or fallback functions.
- `src/main/bootstrap/AppRuntime.ts` sets `capability-first` by default.

### L2 Behavioral Dependents

- `src/main/mcp/ServerManager.ts` remains the raw tool schema source.
- `src/main/mcp/MemoryAwareInterceptor.ts` remains the raw tool priority source.
- `src/main/mcp/BehaviorPredictor.ts` and `src/main/tool/ToolCallLogStore.ts` continue to receive capability identity through telemetry paths.

### Risk

Risk is low if the change stays at the schema-provider boundary. The main risk is overcorrecting by disabling raw fallback or changing Memory statistics. Both are explicitly out of scope.

## 6. Test Strategy

Tests should prove the boundary rather than implementation details:

1. In `capability-first` mode, `ToolSchemaProvider.getSchemas()` returns capability schemas plus exactly one `call_raw_tool` fallback.
2. In `capability-first` mode, raw tool schemas do not appear even if the raw schema source returns boosted or reordered tools.
3. In `dual` mode, existing raw schema exposure remains available.
4. `call_raw_tool` dispatch behavior remains covered by existing router tests.

The preferred regression test uses a fake `ToolSchemaSource` whose `getAllSchemas()` would expose a high-priority raw tool if called. The assertion should verify that capability-first output ignores it.

## 7. Rollback

Rollback is simple:

```text
CAPABILITY_FIRST_MODE=false
```

This restores dual exposure without changing persisted memory or telemetry.

If implementation touches only `ToolSchemaProvider` tests and guard assertions, reverting the code change does not require data migration.

## 8. Acceptance Criteria

- Capability-first schema output is independent from raw tool schema ordering.
- `call_raw_tool` remains present in capability-first mode.
- Dual mode behavior remains compatible with existing raw schema consumers.
- No persisted memory schema changes are introduced.
- No production code change is made before a failing regression test exists.

## 9. Next Step

After this design is approved, write an implementation plan for a TDD change focused on `ToolSchemaProvider` and its exit-gate tests.
