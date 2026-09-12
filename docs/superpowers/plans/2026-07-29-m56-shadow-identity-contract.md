# M5.6.2 Shadow Identity Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional capability identity fields to Evolution-facing telemetry without changing current tool-based Evolution behavior.

**Architecture:** Keep `toolName` as the primary execution identity, but enrich new telemetry writes with optional `capability`, `operation`, and `provider` fields. Perform best-effort enrichment in `ServerManager` so existing collectors, executors, and historical log readers keep working unchanged.

**Tech Stack:** TypeScript, Vitest, Electron main-process runtime, existing CapabilityResolver/ServerManager telemetry pipeline.

---

### Task 1: Lock shadow identity contract with tests

**Files:**
- Create: `src/main/tool/__tests__/ToolCallLogStore.shadow-identity.test.ts`
- Create: `src/main/mcp/__tests__/BehaviorPredictor.shadow-identity.test.ts`
- Create: `src/main/mcp/__tests__/ServerManager.shadow-identity.test.ts`

- [ ] **Step 1: Write the failing ToolCallLogStore tests**

```ts
it('stores optional shadow identity fields on new records', () => {
  const record = store.record(
    'write_file',
    { path: 'note.txt' },
    'ok',
    null,
    12,
    true,
    { capability: 'file.management', operation: 'write', provider: '@builtin/core' },
  )

  expect(record.capability).toBe('file.management')
  expect(record.operation).toBe('write')
  expect(record.provider).toBe('@builtin/core')
})

it('loads legacy records that do not include shadow identity fields', () => {
  expect(records[0].capability).toBeUndefined()
  expect(records[0].operation).toBeUndefined()
  expect(records[0].provider).toBeUndefined()
})
```

- [ ] **Step 2: Write the failing BehaviorPredictor tests**

```ts
it('records optional shadow identity metadata on recent calls', () => {
  predictor.recordCall('write_file', { path: 'a.txt' }, 5, true, {
    capability: 'file.management',
    operation: 'write',
    provider: '@builtin/core',
  })

  expect(predictor.getRecentCalls()[0]).toMatchObject({
    toolName: 'write_file',
    capability: 'file.management',
    operation: 'write',
    provider: '@builtin/core',
  })
})

it('keeps legacy call shape valid when no identity metadata is provided', () => {
  predictor.recordCall('list_files', { path: '.' }, 3, true)
  expect(predictor.getRecentCalls()[0].capability).toBeUndefined()
})
```

- [ ] **Step 3: Write the failing ServerManager enrichment tests**

```ts
it('enriches telemetry writes with capability identity when resolver succeeds', async () => {
  await manager.callTool('list_files', { path: '.' })

  expect(toolRecordSpy).toHaveBeenCalledWith(
    'list_files',
    { path: '.' },
    expect.any(String),
    null,
    expect.any(Number),
    true,
    expect.objectContaining({
      capability: 'file.management',
      operation: 'read',
      provider: '@builtin/core',
    }),
  )
})

it('does not block telemetry writes when resolver throws', async () => {
  await expect(manager.callTool('list_files', { path: '.' })).resolves.toEqual(expect.any(String))
  expect(toolRecordSpy).toHaveBeenCalledWith(
    'list_files',
    { path: '.' },
    expect.any(String),
    null,
    expect.any(Number),
    true,
    undefined,
  )
})
```

- [ ] **Step 4: Run failing tests**

Run:

```bash
npm test -- src/main/tool/__tests__/ToolCallLogStore.shadow-identity.test.ts src/main/mcp/__tests__/BehaviorPredictor.shadow-identity.test.ts src/main/mcp/__tests__/ServerManager.shadow-identity.test.ts
```

Expected: failing assertions or TypeScript signature errors because shadow identity support does not exist yet.

### Task 2: Implement shadow identity enrichment with compatibility

**Files:**
- Create: `src/main/tool/ToolCallIdentity.ts`
- Modify: `src/main/tool/ToolCallLogStore.ts`
- Modify: `src/main/mcp/BehaviorPredictor.ts`
- Modify: `src/main/mcp/ServerManager.ts`

- [ ] **Step 1: Add a shared shadow identity type**

```ts
export interface ToolCallIdentity {
  capability?: string
  operation?: string
  provider?: string
}
```

- [ ] **Step 2: Extend ToolCallLogStore records and record() signature**

```ts
export interface ToolCallRecord extends ToolCallIdentity {
  id: string
  toolName: string
  // ...
}

record(..., success: boolean, identity?: ToolCallIdentity): ToolCallRecord
```

- [ ] **Step 3: Extend BehaviorPredictor CallRecord and recordCall() signature**

```ts
export interface CallRecord extends ToolCallIdentity {
  toolName: string
  argSignature: string
  durationMs: number
  timestamp: number
  success: boolean
}
```

- [ ] **Step 4: Add best-effort identity enrichment in ServerManager**

```ts
private resolveTelemetryIdentity(
  toolName: string,
  args: Record<string, any>,
  provider: string,
): ToolCallIdentity | undefined
```

Behavior:
- ask `CapabilityResolver.resolveByTool(toolName)` if available
- map `file.management -> read/write`, `search.retrieval -> query`, `system.execution -> run`, `browser.automation -> navigate`, `publishing/content.drafting -> generate`
- return `undefined` when no capability is found or resolver throws
- never block tool execution

- [ ] **Step 5: Pass the optional identity to both telemetry writers**

```ts
toolCallLogStore.record(..., success, identity)
behaviorPredictor.recordCall(..., success, identity)
```

### Task 3: Verify compatibility and focused regression coverage

**Files:**
- Modify: `src/main/tool/__tests__/ToolCallLogStore.shadow-identity.test.ts`
- Modify: `src/main/mcp/__tests__/BehaviorPredictor.shadow-identity.test.ts`
- Modify: `src/main/mcp/__tests__/ServerManager.shadow-identity.test.ts`

- [ ] **Step 1: Run the focused shadow identity test suite**

Run:

```bash
npm test -- src/main/tool/__tests__/ToolCallLogStore.shadow-identity.test.ts src/main/mcp/__tests__/BehaviorPredictor.shadow-identity.test.ts src/main/mcp/__tests__/ServerManager.shadow-identity.test.ts
```

Expected: all targeted tests pass.

- [ ] **Step 2: Run a nearby regression slice**

Run:

```bash
npm test -- src/main/__tests__/tools.test.ts src/main/mcp/__tests__/MemoryAwareInterceptor.identity.test.ts
```

Expected: pass, showing shadow enrichment did not break base tool routing or M5.5 identity flow.

- [ ] **Step 3: Report results**

Include:
- which files changed
- which commands were run
- whether resolver-failure remained non-blocking
- note that Evolution collectors/executors and `problemId` were intentionally left unchanged
