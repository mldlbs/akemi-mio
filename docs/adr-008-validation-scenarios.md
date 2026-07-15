# P4 Validation — Scenario Test Spec

## Input → Expected Decision Matrix

| # | Scenario | User Text | Expected Scene | Expected Signal | prefs | reason | filter |
|---|----------|-----------|----------------|----------------|-------|--------|--------|
| 1 | Quick QA | "现在几点了" | quick_qa | FRESH_INFORMATION | proactive | FRESH_INFORMATION | undefined |
| 2 | Quick QA (no signal) | "你好" | quick_qa | — | avoid | DEFAULT | [] |
| 3 | Fresh Info | "今天天气怎么样" | quick_qa* | FRESH_INFORMATION | proactive | FRESH_INFORMATION | undefined |
| 4 | File Upload | "我刚发了一个文件你看一下" | — | FILE_AVAILABLE | proactive | FILE_AVAILABLE | undefined |
| 5 | Execution Task | "帮我实现一个排序函数" | — | EXECUTION_TASK | proactive | EXECUTION_TASK | undefined |
| 6 | Meta Feedback | "你只会说不会做" | — | META_FEEDBACK | proactive | META_FEEDBACK | undefined |
| 7 | Explicit Tool Request | "用工具查一下这个" | — | USER_REQUEST | proactive | USER_REQUEST | undefined |
| 8 | Casual Chat | "今天心情不错" | casual_chat | — | avoid | DEFAULT | [] |
| 9 | Code Debugging | "这个bug怎么修" | code_debugging | — | proactive | DEFAULT | undefined |
| 10 | Deep Discussion | "你怎么看这个架构设计" | deep_discussion | — | auto | DEFAULT | undefined |

\* Scene is a weak signal — when signal hits, the resulting ToolDecision is identical regardless of scene.

## Decision Flow Verification

```
userText ──→ UserBehaviorAnalyzer.analyzeScene() ──→ scene: SceneLabel
         │
         └──→ ToolPolicyPlanner.decide(scene, userText)
                  ├── _detectSignals(userText) ──→ null | {prefs, confidence, reason}
                  │      └── signals checked in order: META_FEEDBACK > USER_REQUEST > EXECUTION_TASK > FRESH_INFORMATION > FILE_AVAILABLE
                  │
                  └── SCENE_DEFAULT[scene] (fallback)
                           │
                           ▼
                  ToolDecision {preference, confidence, reason}
                           │
                  ┌────────┴────────┐
                  ▼                 ▼
        ToolPromptAssembler    toToolFilter()
        (pref≠auto → prompt)   (pref in [avoid,forbidden] → []; else → undefined)
                  │                 │
                  ▼                 ▼
           refreshMemory()    chatWithTools(allowedToolNames)
           via extraModules
```

## Invariant Verification

| Invariant | Status | Evidence |
|-----------|--------|----------|
| I-1: 确定性 | ✅ | `decide()` is pure function — no external state, no random |
| I-2: 无副作用 | ✅ | `decide()` writes nothing, `toToolFilter()` writes nothing |
| I-3: 无 LLM 调用 | ✅ | Regex-only, no async/await, no model access |
| I-4: Prompt 不含策略 | ✅ | `SCENE_PROMPTS` verified clean (P3 commit `18eb201`) |
| I-5: auto 不注入 | ✅ | `ToolPromptAssembler.assemble()` returns null for auto (line 39) |
| I-6: Safety Filter < ToolDecision | ✅ | `toToolFilter()` reads ToolDecision, never writes back — one-way dependency |
| I-7: ToolDecision 不可变 | ✅ | `decide()` returns new object each call, no mutation in ChatExecutor |

## Log Entry Schema (behavior_adaptive_scene)

```
{
  scene,        // SceneLabel
  mode,         // ResponseMode
  confidence,   // scene confidence
  topics,       // dominant topics
  avgLen,       // avg user message length
  toolPreference, // 'proactive'|'auto'|'avoid'|'forbidden'
  toolReason,   // ToolDecisionReason string
  toolFilter    // 'all'|'none'|'restricted'
}
```

Plus actual tool calls logged separately via existing `agent.tool.invoked` / `agent.tool.completed` events.
