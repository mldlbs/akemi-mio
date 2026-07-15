# ADR-008：Tool Decision Contract

**Status:** ✅ Accepted (Frozen) — P1–P4.1 Implementation Complete (Design Validation Passed, Runtime Validation Pending)
**Date:** 2026-07-15
**Supersedes:** None
**Supersedes by:** None
**References:**
- ADR-006 — Reasoning Contract
- `src/main/agent/UserBehaviorAnalyzer.ts` — Scene Classification
- `src/main/agent/ChatExecutor.ts` — Tool Loop
- `src/main/agent/toolPolicy/ToolPolicyPlanner.ts` — Planner 实现
- `src/main/agent/toolPolicy/ToolPromptAssembler.ts` — Assembler 实现

---

## Context

Agent Mio 有两个独立的 Runtime 能力：**对话** 和 **工具执行**。

在 P1 之前，工具策略被嵌入在 `UserBehaviorAnalyzer` 的 `SCENE_PROMPTS` 中：

```typescript
// 旧：风格 Prompt 包含工具策略
concise: `...
- 不需要使用工具，除非用户明确要求`

warm_chat: `...
- 简短亲切，不要使用工具`

technical: `...
- 优先使用工具完成任务`
```

这种设计隐含了一个耦合：**场景风格 = 工具策略**。

当用户说"现在 Mio 只说不做了"时，触发了如下自强化循环：

```
工具少
    ↓
用户投诉
    ↓
Scene 误判为 quick_qa
    ↓
注入"不要使用工具"的 Prompt
    ↓
LLM 决定不调工具
    ↓
工具更少
```

这个循环不是 Prompt 文案的问题，而是架构问题：**两条决策路径（"怎么回应"和"是否用工具"）被捆在同一条 Prompt 中，无法独立演进。**

---

## Problem

### 核心问题

工具使用决策（Tool Planning）与回复风格决策（Response Styling）共享同一决策路径，导致：

1. **负反馈闭环无法自愈。** 用户越投诉 Agent 不做工具，系统越判定为"快速问答"，越抑制工具调用。
2. **不可独立演进。** 修改 `technical` 模式的 Prompt 时，会意外改变工具策略；修改工具策略时，又可能影响回复风格。
3. **缺乏可见性。** 无法独立查询"当前系统决定用什么工具策略"——策略被硬编码在 Prompt 字符串中，无法日志化、度量化。

### 非问题

本 ADR 不解决以下问题（它们已有各自的归属）：

- Scene 分类器的准确度 → `UserBehaviorAnalyzer` 的职责
- Prompt 文案的优化 → `PromptAssembler` 的职责
- 工具执行的成功率 → `ToolScheduler` 的职责
- 具体工具的可用性 → `ServerManager` + `ToolProviderRegistry` 的职责

---

## Decision

### 决策 1：工具决策是独立的运行时规划层

工具使用决策（何时调用工具、调用哪种工具）属于 **运行时规划（Runtime Planning）**，不属于场景识别（Scene Classification）或响应生成（Response Generation）。因此需要独立的规划层，以保证职责单一和可演进性。

```
SceneClassifier ──→ ResponsePlanner ──→ Style Prompt
                          │
                    ToolPolicyPlanner ──→ Tool Prompt + Safety Filter
```

### 决策 2：不使用 LLM 做工具策略决策

工具策略决策（"当前是否应该积极使用工具"）是低延迟、高频调用的同步决策。它不依赖 LLM，而是基于 Scene 标签 + 轻量信号检测。这保证了策略决策不会引入额外的 LLM 延迟或成本。

### 决策 3：Prompt 不应知道 ToolDecision 的结构

`ToolPolicyPlanner` 输出结构化 `ToolDecision`，由 `ToolPromptAssembler` 翻译为 LLM Prompt。Planner 与 Prompt 之间通过契约隔离，允许 Prompt 文案独立演进。

---

## Architecture

### 分层

```
UserBehaviorAnalyzer.analyzeScene()
        │
        ▼
SceneLabel  ──────────────────────────→  SCENE_TO_MODE  ──→  SCENE_PROMPTS
（用户当前做什么）                           │                     │
                                           │                     ▼
                                           │              Style Prompt
                                           │          （语气/长度/格式）
        │                                  │
        ▼                                  │
ToolPolicyPlanner.decide()                 │
   ├─ Signal Detection                     │
   ├─ Scene Default                        │
   ▼                                       │
ToolDecision                               │
   ├─ preference                           │
   ├─ confidence                           │
   └─ reason                               │
        │                                  │
        ▼                                  │
ToolPromptAssembler.assemble()             │
        │                                  │
        ▼                                  ▼
   Tool Prompt                     Style Prompt
        │                                  │
        └──────────┬───────────────────────┘
                   ▼
           PromptAssembler
                   │
                   ▼
                 LLM

ToolDecision ──→ toToolFilter() ──→ allowedToolNames（Safety Net）
```

### 职责分配

| 组件 | 职责 | 不负责 |
|------|------|--------|
| UserBehaviorAnalyzer | 场景分类、话题提取、回复风格选择 | 工具策略、Prompt 生成 |
| ToolPolicyPlanner | 工具策略决策（是否主动使用工具） | Prompt 文案、工具调用、过滤器 |
| ToolPromptAssembler | 将 ToolDecision 翻译为 LLM Prompt | 策略决策、工具执行 |
| ChatExecutor.toolLoop() | 调用合并后的 Prompt，执行工具循环 | 策略决策、风格选择 |

### 信号 vs 场景

`ToolPolicyPlanner.decide()` 使用两层决策：

1. **强信号优先** — 独立于 Scene 标签的信号检测，如 meta_feedback、explicit_tool_request、fresh_information_query、execution_task
2. **场景兜底** — 当无强信号命中时，以 Scene 标签作为弱信号做默认策略

这保证了强信号可以覆盖场景误分类的 case。

### Runtime Decision Flow

以下序列定义了一次用户消息处理中各组件的执行顺序和依赖关系。这是运行时最重要的契约之一：

```
User Message
      │
      ▼
SceneClassifier.analyzeScene()        ① Scene 分类
      │
      ▼
  ┌──────────────────────────────────────────────┐
  │  ToolPolicyPlanner.decide()        ② 策略决策│
  │  ┌─────────────────┐                        │
  │  │ Signal Detection │  强信号优先            │
  │  └──────┬──────────┘                        │
  │         ▼                                   │
  │  ┌─────────────────┐                        │
  │  │ Scene Default   │  弱信号兜底            │
  │  └──────┬──────────┘                        │
  └─────────┼────────────────────────────────────┘
            ▼
      ToolDecision        ③ 输出契约（独立、不可变）
            │
      ┌─────┴─────┐
      ▼           ▼
  ToolPrompt    SafetyFilter
  Assembler     Assembler
      │           │
      │           ▼
      │      allowedToolNames（Safety Net）
      ▼
  PromptAssembler             ④ 合并 Prompt
      │
      ▼
    LLM                         ⑤ 模型推理
      │
      ▼
  ToolLoop                      ⑥ 执行循环
```

**决策顺序契约：**

- `ToolPolicyPlanner.decide()` 在 `PromptAssembler` 之前执行，两者不共享状态
- `ToolPolicyPlanner` 不依赖任何 Prompt 文案或模板结构
- `SafetyFilterAssembler` 与 `ToolPromptAssembler` 并行执行，互不依赖
- 所有组件在 LLM 调用之前完成执行

---

## Frozen Contracts

### 1. ToolDecision 契约

```typescript
/**
 * ADR-008 Frozen Contract.
 *
 * ToolPolicyPlanner 的输出契约。
 * 描述"是否应该使用工具"的策略倾向。
 *
 * confidence 表示 Planner 对自身决策的置信度，
 * 不是 LLM 成功调用工具的概率，也不是 Tool 可用性评分。
 */
export interface ToolDecision {
  /** 工具使用倾向，按优先级从高到低排列 */
  preference: 'proactive' | 'auto' | 'avoid' | 'forbidden'

  /**
   * Planner 对自身决策的置信度（0-1）。
   * 注意：不是 LLM 成功调用工具的概率，也不是工具可用性评分。
   * 用于后续 adaptive policy 的阈值判断（如 confidence < 0.4 时重新分类 Scene）。
   */
  confidence: number

  /** 决策原因。冻结为确定字符串，禁止自由文本 */
  reason: ToolDecisionReason
}
```

### 2. ToolDecisionReason 契约

```typescript
/**
 * ADR-008 Frozen Contract.
 *
 * ToolDecision 的原因枚举。冻结以防止原因字段漂移。
 * 后续扩展必须通过 ADR 修订。
 *
 * UNKNOWN 提供统一落点：未识别原因、实验阶段、向后兼容
 * 场景均回退至此值，而非回退成自由字符串。
 */
export enum ToolDecisionReason {
  /** 用户明确要求执行操作 */
  USER_REQUEST = 'USER_REQUEST',
  /** 检测到文件上传或新信息可用 */
  FILE_AVAILABLE = 'FILE_AVAILABLE',
  /** 检测到执行型任务（实现、开发、部署等） */
  EXECUTION_TASK = 'EXECUTION_TASK',
  /** 检测到实时信息查询（天气、新闻、搜索等） */
  FRESH_INFORMATION = 'FRESH_INFORMATION',
  /** 检测到用户对 Agent 行为的元反馈 */
  META_FEEDBACK = 'META_FEEDBACK',
  /** 安全限制导致禁止或限制工具 */
  SAFETY = 'SAFETY',
  /** 无强信号命中，由场景兜底 */
  DEFAULT = 'DEFAULT',
  /** 未识别原因或实验阶段回退值 */
  UNKNOWN = 'UNKNOWN',
}
```

### 3. Planner 职责边界

```typescript
/**
 * ADR-008 Frozen Contract.
 *
 * ToolPolicyPlanner 的输入/输出接口。
 */
export interface ToolPolicyPlanner {
  /**
   * 基于 Scene + 用户消息 + 上下文信号，输出结构化策略契约。
   *
   * 输入：
   *  - scene: SceneClassifier 输出的场景标签
   *  - userText: 当前轮用户消息
   *  - context: 可选上下文（如是否有近期工具调用记录）
   *
   * 输出：
   *  - ToolDecision: 结构化策略契约
   *
   * 不负责：
   *  - 生成 Prompt 文案
   *  - 设置 allowedToolNames
   *  - 调用任何工具
   */
  decide(scene: SceneLabel, userText: string, context?: { hasRecentToolCalls?: boolean }): ToolDecision
}
```

### 4. ToolPromptAssembler 职责边界

```typescript
/**
 * ADR-008 Frozen Contract.
 *
 * ToolPromptAssembler 将 ToolDecision 翻译为 LLM Prompt。
 *
 * 职责：
 *  - 将 ToolDecision.preference 映射为 LLM 可理解的自然语言指令
 *  - 仅在 non-auto 时注入 Prompt（auto 时不需要提示）
 *
 * 不负责：
 *  - 决策策略
 *  - 工具过滤器
 */
export interface ToolPromptAssembler {
  assemble(decision: ToolDecision): string | null
}
```

### 5. Safety Filter 职责边界

```
ADR-008 明确声明：

ToolFilter = Safety Enforcement ≠ Tool Planning

toToolFilter() 的输出（allowedToolNames）是 Safety Net，
不是 Planning Decision。它的作用是：
"即使 Prompt 注入失败或 LLM 行为异常，也不能调用危险工具。"

不改变真正决定工具调用的是 ToolDecision + LLM 这个事实。
```

---

## Not Frozen

以下变更**不属于** Breaking Change，无需新的 ADR：

- ✓ **Signal Detection 算法** — `_detectSignals()` 中的 regex pattern 和信号加权逻辑可自由优化。契约要求的是输出为 ToolDecision，不是如何到达该输出
- ✓ **confidence 计算方式** — 阈值为 0.8/0.65/0.4 等具体数字不冻结，属于实现细节
- ✓ **Prompt 文案** — `ToolPromptAssembler` 的 `assemble()` 输出的字符串不冻结，属于表达层
- ✓ **Scene 分类模型** — `UserBehaviorAnalyzer` 的 `_classifyScene()` 算法不冻结。新增 Scene 标签、修改阈值都无需修改 ADR
- ✓ **Story 检测的具体信号** — meta_feedback 的检测规则（如 keyword list、信号加权权重）可自由优化

---

## Breaking Changes

以下操作必须通过新的 ADR 审核：

- ✗ 删除或重命名 `ToolDecision.preference` 的枚举值（`proactive` / `auto` / `avoid` / `forbidden`）
- ✗ 修改 `ToolDecision.confidence` 的类型（当前为 `number`，0.0–1.0）
- ✗ 删除或重命名 `ToolDecisionReason` 的枚举值
- ✗ 使 `ToolPolicyPlanner.decide()` 变为异步或有副作用
- ✗ 允许 ToolPolicyPlanner 直接生成 Prompt（跨层职责）
- ✗ 允许 ToolPolicyPlanner 直接修改 allowedToolNames（跨层职责）
- ✗ 将`auto`默认行为改为注入工具提示（当前 auto = null，不注入任何提示）

## Contract Evolution

本 ADR 冻结的是架构边界和数据类型，而非实现细节。以下明确列出未来允许和禁止的演进方向。

### 允许的扩展（无需新的 ADR）

| 扩展方向 | 说明 |
|----------|------|
| 新增 `ToolDecisionReason` 枚举值 | 新的决策原因需要新值，不影响现有值语义 |
| 新增 Signal Source | 如增加 calendar_event、weather_alert 等新信号源，不影响现有信号 |
| 替换 Prompt 文案 | `ToolPromptAssembler.assemble()` 输出的字符串不冻结 |
| 调整 Signal Detection 算法 | Regex pattern、加权权重、信号组合方式均可自由优化 |
| 更换 SceneClassifier | `UserBehaviorAnalyzer` 的算法或模型可替换，只要输出仍是 `SceneLabel` |
| 新增 preference 的映射行为 | 如为 `proactive` 增加新的 Prompt 模板变体 |
| 调整 confidence 阈值 | 具体的数值阈值（如 0.8/0.65/0.4）属于实现参数 |

### 禁止的扩展（需要新的 ADR）

| 方向 | 原因 |
|------|------|
| Planner 直接生成 Prompt | 跨越 Planner ↔ Assembler 的职责边界 |
| Planner 直接调用 Tool | 跨越 Planning ↔ Execution 的职责边界 |
| `SCENE_PROMPTS` 携带 ToolPolicy | 倒退为旧架构，违反 I-4 |
| 修改 `ToolDecision` 不可变性 | 违反 I-7，破坏日志/Replay/调试可靠性 |
| 将 `auto` 默认行为改为注入提示 | 改变 "auto = 不注入" 的语义契约 |

---

## Invariants

| # | Invariant | 验证方式 |
|---|-----------|----------|
| I-1 | **确定性：** `∀ scene, text, context, decide(scene, text, context) = decide(scene, text, context)`。相同输入必然产生完全相同的 `ToolDecision`。 | Contract Test |
| I-2 | **无副作用：** `decide()` 不修改任何外部状态（输入、全局变量、文件系统）。 | 代码审查 |
| I-3 | **无 LLM 调用：** `decide()` 不依赖任何模型调用，纯本地同步逻辑。 | 代码审查 + 依赖审计 |
| I-4 | **Prompt 不含策略：** `SCENE_PROMPTS` 中不出现任何"不要使用工具"、"优先使用工具"等工具策略语句。 | 代码审查 |
| I-5 | **auto 不注入：** 当 `preference === 'auto'` 时，`assemble()` 返回 `null`。不存在任何代码路径在本策略下注入工具提示。 | Contract Test |
| I-6 | **Safety Filter < ToolDecision：** `toToolFilter()` 的输出不影响 `decide()` 的逻辑。Filter 与 Planner 是单向依赖（Planner → Filter，Filter 不反馈给 Planner）。 | 代码审查 |
| I-7 | **ToolDecision 不可变：** `ToolDecision` 在 `decide()` 输出后不可修改。如果后续组件需要调整策略，应生成新的 `ToolDecision` 实例，而非修改已有实例。 | Contract Test |

---

## Consequences

### Positive

1. **自愈能力。** 用户对 Agent 行为的投诉（meta_feedback）会触发 proactive 策略，而非抑制工具调用。原有的负反馈循环被打破。
2. **独立演进。** `SCENE_PROMPTS` 只控制回复风格，`ToolPromptAssembler` 只控制工具策略。修改任一不影响另一。
3. **可观测性。** 每一轮都可以独立日志化 `ToolDecision`（preference + confidence + reason），方便调试和度量。
4. **Adaptive Policy 基础。** `confidence` 为后续的阈值自适应（如 "confidence < 0.4 时重新分类 Scene"）预留了接口。
5. **Safety Net。** `toToolFilter()` 提供了双保险——即使 Prompt 注入失败，Filter 也能防止危险工具被调用。

### Negative

1. **新增一个规划层。** 从 Scene 到 LLM 之间新增了 ToolPolicyPlanner + ToolPromptAssembler 两个组件，增加了架构复杂度。
2. **Signal Detection 准确度。** 基于 regex 的信号检测在 edge case 下可能误判（如 "Mio 不会让人失望" 被检测为 meta_feedback）。但这是实现细节，可迭代优化。
3. **Scene 分类的剩余耦合。** ToolPolicyPlanner 仍然以 Scene 作为弱信号输入。如果 SceneClassifier 长期错误分类，ToolPolicy 也会继承这个错误。强信号检测可以缓解，但不能完全消除。

---

## Alternatives Considered

### Alternative 1：只修 Prompt，不拆架构

只把 `SCENE_PROMPTS` 中的"不要使用工具"改为更温和的表述，不引入 ToolPolicyPlanner。

**否决原因：** 治标不治本。修改 Prompt 只是更换了文案，没有切断负反馈循环的因果关系——场景风格与工具策略仍然是同一个决策路径。

### Alternative 2：用 LLM 做工具策略决策

在 ChatExecutor 中增加一次 LLM 调用，让模型来决定"当前是否应该使用工具"。

**否决原因：** 增加延迟和成本。工具策略决策需要的是低延迟、高确定性，LLM 不适合这个场景。同时，让 LLM 来自我决定"是否使用自己"存在反身性问题。

### Alternative 3：在 ChatExecutor 中直接写 if-else

不引入 ToolPolicyPlanner，在 `ChatExecutor.run()` 中直接根据 Scene 写 if-else 决定工具策略。

**否决原因：** ChatExecutor 的职责是执行工具循环，不是策略决策。随着 Scene 和策略数量增加，ChatExecutor 的复杂度会线性增长。同时，这种方式无法单独测试策略决策逻辑。

---

## Related

- [ToolPolicyPlanner 实现](../src/main/agent/toolPolicy/ToolPolicyPlanner.ts) — ADR-008 驱动实现
- [ToolPromptAssembler 实现](../src/main/agent/toolPolicy/ToolPromptAssembler.ts) — ADR-008 驱动实现
- [Validation Scenarios](adr-008-validation-scenarios.md) — 场景测试矩阵与 Invariant 验证
- [UserBehaviorAnalyzer](../src/main/agent/UserBehaviorAnalyzer.ts) — Scene 分类和风格 Prompt 的所属组件
- [ChatExecutor](../src/main/agent/ChatExecutor.ts) — 消费 ToolDecision + Style Prompt 的 Runtime

---

## Appendix A: Runtime Validation

### A.1 Design Validation

以下 7 项 Invariant 通过静态审计和代码审查验证。这是设计验证（Design Validation），不是运行时验证（Runtime Validation）。

| # | Invariant | 验证方式 | 证据 |
|---|-----------|----------|------|
| I-1 | **确定性：** 相同输入必然产生完全相同的 `ToolDecision` | 代码审查 | `decide()` 纯函数，无外部状态、无随机 |
| I-2 | **无副作用：** `decide()` 不修改任何外部状态 | 代码审查 | `decide()` / `toToolFilter()` 均无写操作 |
| I-3 | **无 LLM 调用：** `decide()` 纯本地同步逻辑 | 代码审查 | 仅 Regex，无 async/await，无模型访问 |
| I-4 | **Prompt 不含策略：** `SCENE_PROMPTS` 中无工具策略语句 | 代码审查 | P3 commit `18eb201` 已清理 |
| I-5 | **auto 不注入：** `preference === 'auto'` 时 `assemble()` 返回 `null` | 代码审查 | `ToolPromptAssembler` 第 39 行 |
| I-6 | **Safety Filter < ToolDecision：** `toToolFilter()` 不影响 `decide()` | 代码审查 | 单向依赖，Planner → Filter，无反写 |
| I-7 | **ToolDecision 不可变：** 输出后不可修改 | 代码审查 | `decide()` 每次返回新对象 |

### A.2 Decision Flow Verification

```
User Message
     │
     ▼
SceneClassifier.analyzeScene()        ① Scene 分类
     │
     ▼
ToolPolicyPlanner.decide()
  ├── _detectSignals(userText)        ② 强信号优先
  │     └── META_FEEDBACK > USER_REQUEST > EXECUTION_TASK
  │         > FRESH_INFORMATION > FILE_AVAILABLE
  └── SCENE_DEFAULT[scene]            ③ 场景兜底
     │
     ▼
ToolDecision {preference, confidence, reason}
     │
  ┌──┴───────────┐
  ▼               ▼
Assembler      toToolFilter()
(pref≠auto)    (avoid/forbidden→[], else→undefined)
  │               │
  ▼               ▼
extraModules   chatWithTools(allowedToolNames)
```

### A.3 Regression Baseline

以下 10 个场景构成回归基线。任何修改 `ToolPolicyPlanner` 的变更必须与下表结果一致。

| # | 场景 | 用户输入 | 信号 | prefs | reason | filter | Prompt 注入 |
|---|------|----------|------|-------|--------|--------|-------------|
| 1 | Quick QA + 时间查询 | "现在几点了" | FRESH_INFORMATION | proactive | FRESH_INFORMATION | undefined | 是 |
| 2 | Quick QA（纯简短） | "你好" | — | avoid | DEFAULT | [] | 是 |
| 3 | 新鲜信息查询 | "今天天气怎么样" | FRESH_INFORMATION | proactive | FRESH_INFORMATION | undefined | 是 |
| 4 | 上传文件 | "我刚发了一个文件你看一下" | FILE_AVAILABLE | proactive | FILE_AVAILABLE | undefined | 是 |
| 5 | 执行任务 | "帮我实现一个排序函数" | EXECUTION_TASK | proactive | EXECUTION_TASK | undefined | 是 |
| 6 | Meta Feedback | "你只会说不会做" | META_FEEDBACK | proactive | META_FEEDBACK | undefined | 是 |
| 7 | 显式工具请求 | "用工具查一下这个" | USER_REQUEST | proactive | USER_REQUEST | undefined | 是 |
| 8 | Casual Chat | "今天心情不错" | — | avoid | DEFAULT | [] | 是 |
| 9 | Code Debugging | "这个bug怎么修" | — | proactive | DEFAULT | undefined | 是 |
| 10 | Deep Discussion | "你怎么看这个架构设计" | — | auto | DEFAULT | undefined | 否（null） |

### A.4 Log Schema

```typescript
// behavior_adaptive_scene 日志条目
{
  scene,        // SceneLabel: 当前场景
  mode,         // ResponseMode: 当前回复模式
  confidence,   // number: 场景分类置信度
  topics,       // string[]: 主导话题
  avgLen,       // number: 用户消息平均长度
  toolPreference, // 'proactive'|'auto'|'avoid'|'forbidden'
  toolReason,   // ToolDecisionReason 字符串
  toolFilter    // 'all'|'none'|'restricted'
}
```

工具调用日志由已有的事件系统处理：`agent.tool.invoked` + `agent.tool.completed`。

### A.5 Runtime Validation (Pending)

以下验证项依赖真实对话数据，当前未完成：

- [ ] 工具调用率是否改善（旧架构 vs 新架构，相同对话集）
- [ ] "Mio 只说不做"场景是否减少
- [ ] 信号检测误报率（false positive on "Mio 不会让人失望"）
- [ ] `avoid` 策略是否过度抑制合法工具调用
- [ ] `proactive` 策略是否引入不必要的工具调用
