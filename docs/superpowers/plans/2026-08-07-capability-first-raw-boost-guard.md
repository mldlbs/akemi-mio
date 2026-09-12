# Capability-First Raw Boost Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a regression guard proving raw tool priority and raw schema ordering cannot influence `capability-first` schema exposure.

**Architecture:** `ToolSchemaProvider` is the boundary. In `capability-first` mode it must return capability schemas plus `call_raw_tool` without consulting `ToolSchemaSource.getAllSchemas()`. If the regression test already passes, no production code change is required.

**Tech Stack:** TypeScript, Vitest, existing ADR-015 capability test suite.

---

## File Structure

- Modify: `src/main/tool/__tests__/P1_3b_exit_gate.test.ts`
  - Adds regression coverage under `P1.3b Exit Gate - Capability-First Schema Mode`.
  - Verifies capability-first output is independent from raw tool schemas and raw schema ordering.
- Modify only if the new regression test fails: `src/main/tool/ToolSchemaProvider.ts`
  - Keeps `capability-first` mode on the capability-only branch before any raw schema source call.
- No docs update is required during implementation because the design spec already exists at `docs/superpowers/specs/2026-08-07-capability-first-raw-boost-guard-design.md`.

## Task 1: Add Capability-First Raw Source Isolation Regression

**Files:**
- Modify: `src/main/tool/__tests__/P1_3b_exit_gate.test.ts`

- [ ] **Step 1: Add a regression test inside the capability-first schema mode describe block**

Insert this test after the existing `[Exit Gate 1] capability-first mode outputs capability schemas + call_raw_tool` test:

```typescript
  it('[Exit Gate 1] capability-first mode ignores raw tool schemas and their ordering', () => {
    const rawSchemaSource = {
      getAllSchemas: vi.fn().mockReturnValue([
        {
          type: 'function' as const,
          function: {
            name: 'browser_navigate',
            description: 'Boosted raw browser tool',
            parameters: { type: 'object' as const, properties: {}, required: [] },
          },
        },
        {
          type: 'function' as const,
          function: {
            name: 'write_file',
            description: 'Boosted raw file tool',
            parameters: { type: 'object' as const, properties: {}, required: [] },
          },
        },
      ]),
    }
    const provider = new ToolSchemaProvider(rawSchemaSource, adapter)

    provider.setMode('capability-first')
    const schemas = provider.getSchemas()
    const names = schemas.map((s) => s.function.name)

    expect(rawSchemaSource.getAllSchemas).not.toHaveBeenCalled()
    expect(names).toContain('browser_automation')
    expect(names).toContain('file_management')
    expect(names).toContain('call_raw_tool')
    expect(names).not.toContain('browser_navigate')
    expect(names).not.toContain('write_file')
    expect(names[names.length - 1]).toBe('call_raw_tool')
  })
```

- [ ] **Step 2: Run the targeted test**

Run:

```powershell
npm test -- src/main/tool/__tests__/P1_3b_exit_gate.test.ts -t "capability-first mode ignores raw tool schemas"
```

Expected:

```text
PASS src/main/tool/__tests__/P1_3b_exit_gate.test.ts
```

This test is a regression characterization. If it passes immediately, the current production implementation already satisfies the guard and Task 2 should be skipped.

If it fails because `rawSchemaSource.getAllSchemas` was called or raw names appear in output, continue to Task 2.

## Task 2: Patch ToolSchemaProvider Only If Task 1 Fails

**Files:**
- Modify: `src/main/tool/ToolSchemaProvider.ts`
- Test: `src/main/tool/__tests__/P1_3b_exit_gate.test.ts`

- [ ] **Step 1: Verify the failure reason before editing production code**

The only acceptable failure for this task is one of:

```text
expected "spy" to not be called
expected [...] not to contain "browser_navigate"
expected [...] not to contain "write_file"
```

If the failure is a typo, import error, or test setup error, fix the test and rerun Task 1 instead of editing production code.

- [ ] **Step 2: Keep capability-first branch before raw schema source access**

In `src/main/tool/ToolSchemaProvider.ts`, ensure `getSchemas()` has this structure:

```typescript
  getSchemas(): ToolSchema[] {
    if (this._mode === 'capability-first') {
      return this.getCapabilityFirstSchemas()
    }

    const toolSchemas = this.toolSource.getAllSchemas()
    const capSchemas = this.capabilityAdapter?.buildSchemas() ?? []

    if (capSchemas.length === 0) return toolSchemas

    log('INFO', 'tool_schema_provider.merged', {
      toolCount: toolSchemas.length,
      capabilityCount: capSchemas.length,
    })

    return [...toolSchemas, ...capSchemas]
  }
```

Do not change `getToolSchemasOnly()`. That method is explicitly raw-only and may continue to call the raw source.

- [ ] **Step 3: Run the targeted regression test again**

Run:

```powershell
npm test -- src/main/tool/__tests__/P1_3b_exit_gate.test.ts -t "capability-first mode ignores raw tool schemas"
```

Expected:

```text
PASS src/main/tool/__tests__/P1_3b_exit_gate.test.ts
```

## Task 3: Add Dual Mode Compatibility Regression

**Files:**
- Modify: `src/main/tool/__tests__/P1_3b_exit_gate.test.ts`

- [ ] **Step 1: Add a dual-mode control test**

Insert this test near the raw isolation test:

```typescript
  it('[Exit Gate 1] dual mode still exposes raw tool schemas from the raw source', () => {
    const rawSchemaSource = {
      getAllSchemas: vi.fn().mockReturnValue([
        {
          type: 'function' as const,
          function: {
            name: 'browser_navigate',
            description: 'Raw browser tool',
            parameters: { type: 'object' as const, properties: {}, required: [] },
          },
        },
      ]),
    }
    const provider = new ToolSchemaProvider(rawSchemaSource, adapter)

    const schemas = provider.getSchemas()
    const names = schemas.map((s) => s.function.name)

    expect(provider.getMode()).toBe('dual')
    expect(rawSchemaSource.getAllSchemas).toHaveBeenCalledTimes(1)
    expect(names).toContain('browser_navigate')
    expect(names).toContain('browser_automation')
    expect(names).not.toContain('call_raw_tool')
  })
```

- [ ] **Step 2: Run both focused schema-mode tests**

Run:

```powershell
npm test -- src/main/tool/__tests__/P1_3b_exit_gate.test.ts -t "raw tool schemas"
```

Expected:

```text
PASS src/main/tool/__tests__/P1_3b_exit_gate.test.ts
```

## Task 4: Run Exit-Gate Suite

**Files:**
- Test: `src/main/tool/__tests__/P1_3b_exit_gate.test.ts`

- [ ] **Step 1: Run the full P1.3b exit-gate test file**

Run:

```powershell
npm test -- src/main/tool/__tests__/P1_3b_exit_gate.test.ts
```

Expected:

```text
PASS src/main/tool/__tests__/P1_3b_exit_gate.test.ts
```

- [ ] **Step 2: Run typecheck for touched TypeScript**

Run:

```powershell
npm run typecheck
```

Expected:

```text
No TypeScript errors.
```

If unrelated existing type errors appear, capture the first failing file and confirm it is unrelated to this plan before proceeding.

## Task 5: Commit the Implementation

**Files:**
- Stage: `src/main/tool/__tests__/P1_3b_exit_gate.test.ts`
- Stage if modified: `src/main/tool/ToolSchemaProvider.ts`

- [ ] **Step 1: Inspect the diff**

Run:

```powershell
git diff -- src/main/tool/__tests__/P1_3b_exit_gate.test.ts src/main/tool/ToolSchemaProvider.ts
```

Expected:

```text
Diff contains only the regression tests, unless Task 2 was needed.
```

- [ ] **Step 2: Stage only files from this plan**

Run:

```powershell
git add -- src/main/tool/__tests__/P1_3b_exit_gate.test.ts src/main/tool/ToolSchemaProvider.ts
```

If `src/main/tool/ToolSchemaProvider.ts` was not modified, Git will ignore it.

- [ ] **Step 3: Commit**

Run:

```powershell
git commit -m "test: guard capability-first raw boost isolation"
```

Expected:

```text
[feat/evaluation-bridge <hash>] test: guard capability-first raw boost isolation
```

## Self-Review Checklist

- Every acceptance criterion in the design spec maps to a task.
- The implementation keeps `call_raw_tool` present in capability-first mode.
- The implementation keeps dual mode raw schema exposure intact.
- No persisted memory schema changes are introduced.
- No Memory statistics or priority semantics are rewritten.
- Production code is edited only if the regression test exposes an actual gap.
