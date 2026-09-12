# Mio Tool Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Mio semantic-route requests before chatting, default ambiguous task requests to observe-first, and let the scheduler enforce tool-first behavior.

**Architecture:** Add a new semantic router that returns structured route decisions, thread that route through `ChatExecutor`, and extend `LlmService` so tool calls can be forced on the first round when needed. Keep `UserBehaviorAnalyzer` for style and scene flavor, but stop using regex-like heuristics as the authority for tool routing.

**Tech Stack:** TypeScript, Electron, Vitest, existing `LlmService` / `ChatExecutor` / conversation context modules.

---

### Task 1: Add semantic routing primitives

**Files:**
- Create: `src/main/agent/routing/types.ts`
- Create: `src/main/agent/routing/prompts.ts`
- Create: `src/main/agent/routing/IntentRouter.ts`
- Create: `src/main/agent/routing/routePolicy.ts`
- Create: `src/main/agent/routing/__tests__/IntentRouter.test.ts`
- Create: `src/main/agent/routing/__tests__/routePolicy.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it, vi } from 'vitest'
import { IntentRouter } from '../IntentRouter'

it('routes vague engineering asks to observe_first', async () => {
  const classifier = {
    classifyRouteIntent: vi.fn().mockResolvedValue({
      reply: '{"route":"observe_first","confidence":0.78,"reason":"active project context and vague request"}',
    }),
  }
  const router = new IntentRouter(classifier as any)

  await expect(
    router.route({
      userText: 'help me look at this repo',
      scene: 'unknown',
      hasProjectContext: true,
      recentToolNames: ['read_file'],
    }),
  ).resolves.toMatchObject({ route: 'observe_first' })
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/main/agent/routing/__tests__/IntentRouter.test.ts`
Expected: fail because `IntentRouter` and route types do not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
export type IntentRoute = 'chat_only' | 'observe_first' | 'tool_first' | 'tool_required'

export interface IntentRouteDecision {
  route: IntentRoute
  confidence: number
  reason: string
  suggestedTools?: string[]
}

export interface RouteInput {
  userText: string
  scene: string
  hasProjectContext: boolean
  recentToolNames: string[]
}
```

```ts
export function resolveRouteExecutionPolicy(decision: IntentRouteDecision) {
  if (decision.route === 'chat_only') {
    return { toolChoiceMode: 'auto' as const, allowedToolNames: [] as string[] }
  }
  if (decision.route === 'observe_first') {
    return { toolChoiceMode: 'required' as const, allowedToolNames: ['list_files', 'read_file', 'grep', 'analyze_codebase'] }
  }
  return { toolChoiceMode: 'required' as const, allowedToolNames: undefined }
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run src/main/agent/routing/__tests__/IntentRouter.test.ts src/main/agent/routing/__tests__/routePolicy.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/routing docs/superpowers/plans/2026-08-06-mio-tool-routing.md
git commit -m "feat: add semantic routing primitives"
```

### Task 2: Add a route classifier to `LlmService` and make tool choice explicit

**Files:**
- Modify: `src/main/llm/LlmService.ts`
- Create: `src/main/llm/__tests__/LlmService.routing.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it('sends the route prompt and returns the JSON reply', async () => {
  const service = new LlmService()
  service.setConfig('chat-key', 'code-key')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    choices: [{ message: { content: '{"route":"tool_first","confidence":0.91,"reason":"user asked to fix code"}' } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

  const result = await service.classifyRouteIntent({
    userText: 'fix this bug',
    scene: 'code_debugging',
    hasProjectContext: true,
    recentToolNames: ['read_file'],
  }, 'req-route')

  expect(result.reply).toContain('"route":"tool_first"')
})
```

```ts
it('forces tool_choice when requested', async () => {
  const service = new LlmService()
  service.setConfig('chat-key', 'code-key')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    choices: [{ message: { content: 'ok' } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

  await service.chatWithTools([{ role: 'user', content: 'fix it' } as any], 'req', 1000, undefined, undefined, undefined, {
    toolChoiceMode: 'required',
  })

  const body = JSON.parse((fetch as any).mock.calls[0][1].body)
  expect(body.tool_choice).toBe('required')
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/main/llm/__tests__/LlmService.routing.test.ts`
Expected: fail because `classifyRouteIntent` and `toolChoiceMode` are missing.

- [ ] **Step 3: Write minimal implementation**

```ts
async classifyRouteIntent(
  input: { userText: string; scene: string; hasProjectContext: boolean; recentToolNames: string[] },
  requestId?: string,
): Promise<ChatResult> {
  const prompt = buildRouteClassificationPrompt(input)
  const res = await fetch(this.codeApiUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${this.codeApiKey!}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: this.codeModel,
      messages: [{ role: 'system', content: prompt }, { role: 'user', content: input.userText }],
      stream: false,
      temperature: 0.1,
    }),
  })
  return this._checkStatus(res, requestId) || { reply: await res.text() }
}
```

```ts
async chatWithTools(
  messages: Message[],
  requestId?: string,
  timeoutMs = 60000,
  onChunk?: ChunkCallback,
  externalSignal?: AbortSignal,
  allowedToolNames?: string[],
  options?: { toolChoiceMode?: 'auto' | 'required' },
): Promise<{ reply?: string; toolCalls?: ToolCallInfo[]; error?: string }> {
  const toolChoiceMode = options?.toolChoiceMode ?? 'auto'
  const res = await this._doFetch(messages, false, controller.signal, this.codeModel, allowedToolNames, toolChoiceMode)
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run src/main/llm/__tests__/LlmService.routing.test.ts src/main/llm/__tests__/LlmService.dsml.test.ts`
Expected: pass, and DSML compatibility stays intact.

- [ ] **Step 5: Commit**

```bash
git add src/main/llm/LlmService.ts src/main/llm/__tests__/LlmService.routing.test.ts
git commit -m "feat: add route classifier and tool choice"
```

### Task 3: Wire `ChatExecutor` to route semantically and enforce first-round policy

**Files:**
- Modify: `src/main/agent/ChatExecutor.ts`
- Create: `src/main/agent/__tests__/ChatExecutor.routing.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it('uses observe_first to force read-only tools on the first round', async () => {
  const executor = createExecutor()
  ;(executor as any).intentRouter = { route: vi.fn().mockResolvedValue({ route: 'observe_first', confidence: 0.8, reason: 'vague project ask' }) }
  vi.spyOn((executor as any).llmService, 'chatWithTools').mockResolvedValue({ reply: 'ok' })

  await executor.run('help me inspect this repo', 'req-observe', 'electron', undefined, 'sess-observe', true)

  expect((executor as any).llmService.chatWithTools).toHaveBeenCalledWith(
    expect.any(Array),
    'req-observe',
    120000,
    expect.any(Function),
    undefined,
    ['list_files', 'read_file', 'grep', 'analyze_codebase'],
    expect.objectContaining({ toolChoiceMode: 'required' }),
  )
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/main/agent/__tests__/ChatExecutor.routing.test.ts`
Expected: fail because `intentRouter` and route-aware tool policy are not wired yet.

- [ ] **Step 3: Write minimal implementation**

```ts
private intentRouter: IntentRouter | null = null
private currentRouteDecision: IntentRouteDecision | null = null

setIntentRouter(router: IntentRouter | null): void {
  this.intentRouter = router
}

const routeDecision =
  (await this.intentRouter?.route({
    userText: text,
    scene: this.currentScene,
    hasProjectContext: this.currentDomainLabel === 'code' || this.currentDomainLabel === 'task',
    recentToolNames: [],
  })) ?? { route: 'observe_first', confidence: 0.5, reason: 'router unavailable' }
this.currentRouteDecision = routeDecision
const routePolicy = resolveRouteExecutionPolicy(routeDecision)
```

```ts
const routePrompt = buildRouteRuntimePrompt(this.currentRouteDecision)
if (routePrompt) this.workingMemory.scratchpad.add('system_hint', routePrompt)
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run src/main/agent/__tests__/ChatExecutor.routing.test.ts src/main/agent/__tests__/ChatExecutor.behavioral-evidence.test.ts`
Expected: pass, and the existing chat boundary events stay unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/ChatExecutor.ts src/main/agent/__tests__/ChatExecutor.routing.test.ts
git commit -m "feat: wire semantic tool routing into chat executor"
```

### Task 4: Update Mio prompt copy to match the new routing contract

**Files:**
- Modify: `src/main/agent/context.ts`
- Modify: `src/main/agent/__tests__/context.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it('teaches task requests to inspect or use tools before replying', () => {
  const p = buildSystemPrompt()
  expect(p).toContain('task, code, file, log')
  expect(p).toContain('inspect or use tools before answering')
  expect(p).not.toContain('can answer directly')
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/main/agent/__tests__/context.test.ts`
Expected: fail because the prompt still says chat-first.

- [ ] **Step 3: Write minimal implementation**

```ts
const PROMPT_IDENTITY = `You are Akiyama Mio, a warm and capable AI partner.

## Rules
Casual conversation can answer directly. Task, code, file, log, status, external fresh-info, and vague engineering requests should inspect or use tools before answering.`
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run src/main/agent/__tests__/context.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/context.ts src/main/agent/__tests__/context.test.ts
git commit -m "feat: align system prompt with semantic routing"
```

### Task 5: Verify the whole routing path end to end

**Files:**
- No new code expected unless verification exposes a real gap

- [ ] **Step 1: Run the focused routing suite**

Run: `npx vitest run src/main/agent/routing/__tests__/IntentRouter.test.ts src/main/agent/routing/__tests__/routePolicy.test.ts src/main/llm/__tests__/LlmService.routing.test.ts src/main/agent/__tests__/ChatExecutor.routing.test.ts src/main/agent/__tests__/context.test.ts`
Expected: all pass.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: clean TypeScript compile.

- [ ] **Step 3: Sanity-check the old chat and DSML tests**

Run: `npx vitest run src/main/llm/__tests__/LlmService.dsml.test.ts src/main/agent/__tests__/ChatExecutor.behavioral-evidence.test.ts`
Expected: pass, proving the new routing work did not break existing chat/tool plumbing.

- [ ] **Step 4: Commit the finished feature**

```bash
git add src/main/agent/routing src/main/agent/ChatExecutor.ts src/main/agent/context.ts src/main/llm/LlmService.ts src/main/agent/__tests__ src/main/llm/__tests__
git commit -m "feat: add semantic tool routing for mio"
```
