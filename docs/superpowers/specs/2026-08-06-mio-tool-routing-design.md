# Mio Tool Routing Design

Date: 2026-08-06

## Problem

Mio currently behaves as if chat is the default and tools are optional. The failure is not only prompt wording. The deeper issue is that Mio does not reliably distinguish:

- casual conversation that should stay chat-first
- ambiguous requests that need local observation before answering
- task-oriented requests that should immediately use tools
- hard task requests where replying without tools is a regression

Today that distinction is driven mostly by regex-like signals and scene defaults in `ToolPolicyPlanner`, plus a soft prompt hint that still ends in `tool_choice: "auto"`. This creates three bad behaviors:

1. Mio can misread vague engineering requests such as "帮我看看", "继续做", "改一下这个", "这里不对" as normal chat.
2. Even when the planner returns a proactive preference, the final LLM request still lets the model decide whether to call tools.
3. The system prompt in `context.ts` still contains a strong chat-first instruction, so prompt and scheduler are working against each other.

## Goals

1. Replace regex-first routing with semantic routing.
2. Make "cannot tell yet" default to observe-first, not chat-first.
3. Separate intent discrimination from response tone and scene analysis.
4. Let scheduler enforce the route instead of treating it as a suggestion.
5. Preserve smooth pure-chat behavior for real casual conversation.

## Non-goals

1. Replacing `UserBehaviorAnalyzer` scene analysis for tone adaptation.
2. Reworking the full tool ecosystem or tool schema layer.
3. Solving every domain-specific intent in one pass.
4. Removing all heuristics from the codebase. Heuristics may remain as last-resort fallback, but not as the primary route decision.

## Proposed Design

### 1. Add a semantic routing layer

Introduce a new routing component that runs before `ChatExecutor.toolLoop()` decides how to call the main model.

Suggested location:

- `src/main/agent/routing/IntentRouter.ts`
- `src/main/agent/routing/types.ts`
- `src/main/agent/routing/prompts.ts`

The router consumes:

- current user text
- recent user and assistant turns
- current session state
- recent tool activity and failures
- coarse scene metadata when available

The router outputs a structured decision:

```ts
type IntentRoute = 'chat_only' | 'observe_first' | 'tool_first' | 'tool_required'

interface IntentRouteDecision {
  route: IntentRoute
  confidence: number
  reason: string
  suggestedTools?: string[]
}
```

The important change is that the route is no longer derived from regex matches. The route is a semantic judgment.

### 2. Use an LLM classifier as the primary router

Mio already has a lightweight intent-classification transport in `LlmService.classifyIntent()`. We should reuse that path, but upgrade the prompt and result schema for routing instead of the current pump/control example payload.

Primary behavior:

- call a low-cost classification model through `LlmService.classifyIntent()`
- send a routing prompt with session-aware context
- require JSON-only output
- parse into `IntentRouteDecision`

The prompt should instruct the classifier to decide:

- whether the request can be answered from current conversation alone
- whether the request needs local observation first
- whether the request is clearly asking for action, inspection, or modification
- whether answering without tools would be misleading

The classifier must explicitly treat vague engineering requests in an active project context as `observe_first` or stronger, never as default chat.

Examples that should route away from chat:

- "帮我看看"
- "继续做"
- "改一下这个"
- "这里不对"
- "为什么没生效"
- "看看日志"
- "这个文件有问题"

### 3. Keep `UserBehaviorAnalyzer` for style, not route authority

`UserBehaviorAnalyzer` should continue to power:

- response mode selection
- warm chat vs concise vs technical tone
- behavior evidence and scene memory

It should no longer be the authority for whether tools are needed. Scene analysis may still be passed into the router as weak context, but scene output must not directly decide tool routing.

### 4. Introduce observe-first as a first-class path

`observe_first` is the new default for ambiguous but likely task-oriented requests.

Meaning:

- Mio should not reply from guesswork.
- Mio should first perform one cheap observation pass.
- The first pass must be read-only and low-risk.

Default observation tool set:

- `list_files`
- `read_file`
- `grep`
- `analyze_codebase`
- optionally `list_plans` or other read-only status tools when session state is the likely target

This is the key behavioral change. When Mio is uncertain, it should gather evidence before talking.

### 5. Let scheduler enforce route semantics

`ChatExecutor` should consume the route result and enforce it. The route should map to execution policy like this:

- `chat_only`
  - no tool forcing
  - tool filter may be empty
  - normal chat response allowed immediately

- `observe_first`
  - first round limited to read-only observation tools
  - `tool_choice` forced away from free chat for that first round
  - after one observation batch, subsequent round can expand to normal allowed tools

- `tool_first`
  - first round uses normal allowed tool set
  - `tool_choice` forced for the first round
  - direct answer without attempting tools is not allowed unless no tools are actually available

- `tool_required`
  - same as `tool_first`, but stricter failure handling
  - if the model produces plain chat instead of tools, the loop injects a correction hint and retries

### 6. Extend `LlmService.chatWithTools()` to accept tool-choice policy

Today `LlmService` hardcodes `tool_choice: "auto"`. That prevents scheduler from enforcing behavior.

Add a request-level policy parameter, for example:

```ts
type ToolChoiceMode = 'auto' | 'required'
```

Then thread it through:

- `ChatExecutor.toolLoop()`
- `LlmService.chatWithTools()`
- `_chatWithToolsStream()`
- `_doFetch()` for non-stream tool requests

Phase-one design only needs `auto` and `required`. We do not need a larger policy surface yet.

### 7. Update prompt language to match the new routing model

`context.ts` must stop teaching Mio that "if it can answer directly, answer immediately" as the top-level rule.

Replace that section with a split like:

- casual conversation can answer directly
- task, code, file, log, status, and fresh-information requests should use observation or tools first
- ambiguous project requests should inspect before replying

This prompt change is supportive, not authoritative. The scheduler still owns the final route.

## Control Flow

### New flow in `ChatExecutor.run()`

1. Gather current user text and compact context snapshot.
2. Call `IntentRouter.route(...)`.
3. Store the routing decision on the executor for the current turn.
4. Build prompt modules using the route as context.
5. Enter `toolLoop()`.
6. On the first loop iteration, translate the route into:
   - allowed tools
   - first-round tool filter
   - `tool_choice` mode
7. Execute first-round tool policy.
8. After first observation/tool batch, relax to normal loop behavior unless the route is `tool_required`.

### New flow inside `toolLoop()`

First turn only:

- `chat_only`: current behavior
- `observe_first`: force read-only inspection
- `tool_first` / `tool_required`: force tool call attempt

Later turns:

- resume normal planning loop
- continue honoring scene restrictions and guardrails
- keep `tool_required` correction if the model repeatedly tries to answer without acting

## Fallback Behavior

Primary routing must be semantic. Fallbacks exist only for robustness.

### Router failure fallback

If the classifier call fails due to timeout, invalid JSON, or missing key:

1. If the current session already has recent tool activity or an active engineering context, fall back to `observe_first`.
2. If the scene clearly looks like casual chat, fall back to `chat_only`.
3. Otherwise fall back to `observe_first`.

This preserves the new core principle: uncertainty defaults to observation, not chat.

### First-round no-tool fallback

If route is `observe_first`, `tool_first`, or `tool_required`, but the model still returns plain text with no tool call:

1. inject a compact correction hint
2. retry one first-round request with `tool_choice: "required"`
3. if still no tool call and no tools are available after filtering, degrade gracefully and explain the limitation

## Testing

### Unit tests

Add tests for:

- router JSON parsing
- route-to-policy mapping
- fallback behavior on invalid classifier output
- `observe_first` first-round tool filtering
- `tool_required` correction retry

Suggested files:

- `src/main/agent/routing/__tests__/IntentRouter.test.ts`
- `src/main/agent/toolPolicy/__tests__/route-policy.test.ts`
- `src/main/llm/__tests__/LlmService.tool-choice.test.ts`

### Integration tests

Cover end-to-end chat behavior in `ChatExecutor`:

- casual greeting stays chat-only
- "帮我看看这个仓库" becomes `observe_first`
- "修这个 bug" becomes `tool_first`
- "查看这个文件并改掉问题" becomes `tool_required`
- router failure still defaults ambiguous engineering input to observation

## Risks

1. Extra classification call adds latency.
Mitigation:
- keep routing prompt short
- use low-temperature structured output
- only pass compact recent context, not the full transcript

2. Over-routing pure chat into observation.
Mitigation:
- preserve `chat_only`
- test casual conversation explicitly

3. Read-only observation may still choose the wrong first tool.
Mitigation:
- keep the observation tool palette small and cheap
- let later rounds expand once evidence is collected

## Rollout Plan

1. Add semantic router and types behind a feature flag.
2. Thread route decisions through `ChatExecutor`.
3. Add `tool_choice` policy support in `LlmService`.
4. Update prompt wording in `context.ts`.
5. Add tests.
6. Enable by default after passing chat and tool-loop regression coverage.

## Recommendation

Implement this as "semantic route first, tool policy second, prompt support third."

The most important product rule is:

When Mio is unsure in a project or task context, it should observe first instead of chatting first.
