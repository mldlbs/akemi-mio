# LLM Config Source Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make development builds read LLM config from the project `.env`, while packaged/distributed builds read LLM config from the persisted credentials database instead of `userData/.env`.

**Architecture:** Move LLM env loading policy into `src/main/config/index.ts` so config bootstrap can distinguish dev from packaged runtime. Keep database-driven refresh in the distributed path by letting startup avoid `.env` LLM injection there and relying on `CredentialsManager` refresh.

**Tech Stack:** Electron, TypeScript, Vitest

---

### Task 1: Lock config-source behavior with tests

**Files:**
- Modify: `D:/work/code/akemi-mio/src/main/config/__tests__/index.test.ts`

- [ ] **Step 1: Write the failing tests**

Add tests that re-import `src/main/config/index.ts` under mocked Electron/runtime conditions and assert:

```ts
it('loads LLM env from project root in development mode', async () => {
  // mock app.isPackaged = false
  // mock app.getAppPath() = temp project root
  // mock app.getPath('userData') = temp userData root
  // write conflicting .env files to both locations
  // expect project-root values to win
})

it('does not load userData .env for packaged mode', async () => {
  // mock app.isPackaged = true
  // write only userData/.env with LLM values
  // expect default config values, not userData values
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/main/config/__tests__/index.test.ts`

Expected: FAIL because current config loader still prioritizes `userData/.env`.

### Task 2: Implement source split

**Files:**
- Modify: `D:/work/code/akemi-mio/src/main/config/index.ts`
- Modify: `D:/work/code/akemi-mio/src/main/bootstrap/AppRuntime.ts`

- [ ] **Step 1: Update config bootstrap**

Implement a helper that:

```ts
function getEnvPath(): string | null {
  // dev: project root .env
  // packaged: no LLM userData env loading
}
```

and only hydrate `process.env` from the chosen path.

- [ ] **Step 2: Update runtime startup wiring**

Adjust startup so:

```ts
if (app.isPackaged) {
  llmService.refreshFromCredentials((k) => credentialsManager.get(k))
} else if (llmKey) {
  llmService.setConfig(llmKey, llmCodeKey || llmKey)
}
```

and keep non-LLM credential-driven refresh behavior unchanged.

- [ ] **Step 3: Run tests to verify they pass**

Run: `npm test -- src/main/config/__tests__/index.test.ts`

Expected: PASS.

### Task 3: Verify runtime-facing behavior

**Files:**
- Modify: `D:/work/code/akemi-mio/src/main/config/__tests__/index.test.ts`
- Modify: `D:/work/code/akemi-mio/src/main/ipc/__tests__/handlers.test.ts`

- [ ] **Step 1: Add a packaged-path smoke test**

Add or update one IPC/runtime test asserting that credential refresh still happens for `llm_*` writes through:

```ts
credentials:set -> agentService.getLlmService().refreshFromCredentials(...)
```

- [ ] **Step 2: Run targeted tests**

Run: `npm test -- src/main/config/__tests__/index.test.ts src/main/ipc/__tests__/handlers.test.ts`

Expected: PASS.
