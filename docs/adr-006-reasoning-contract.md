# ADR-006：Reasoning Contract

**Status:** ✅ Accepted — Frozen (M4.1)
**Date:** 2026-07-14
**Supersedes:** None
**Superseded by:** None
**References:**
- ADR-004 — Decision Delivery Contract
- [M4.1 Review Notes](../src/main/reasoning/__tests__/ReasoningPlanner.contract.test.ts) — Planner Contract Tests

---

## Context

秋山澪 的回复在复杂问题场景下逻辑性不足。此前尝试过多种方案（增强 Prompt、增加 CoT、ThinkStage 检查），但效果有限或成本过高。

经过对回复生成管线的完整审计，核心瓶颈不在模型能力不足，而在于：

1. **模型不知道应该用哪种思维模式回答当前问题。** 同一句"为什么会这样"，可以回答为因果链分析、也可以回答为假设验证。System Prompt 没有给模型这个上下文。
2. **现有 IntentClassifier 和 Scene 检测已输出语义标签，但这些标签没有被转化为推理指导。** 信息存在，但未被消费。

**关键决策：** 不引入第二次 LLM 调用，不堆砌通用 Prompt 规则，而是增加一层纯规则的推理规划层（ReasoningPlanner），在 System Prompt 中注入与当前问题匹配的推理框架。

---

## Decision Scope

本 ADR 仅回答一个问题：

> **如何让 LLM 在生成回复前获得与当前问题匹配的推理框架指导？**

本 ADR **不**回答：

- 具体的关键词匹配规则（Planner Rules 可演进）
- Prompt 模板的措辞（PromptBuilder 实现可更换）
- 多轮对话中的推理框架切换策略

---

## Frozen Contract

### 1. ReasoningDirective

纯数据契约，描述"应该用什么思维框架"。

```typescript
interface ReasoningDirective {
  pattern?: ThinkingPattern   // 缺省或 'default' → 无特殊推理要求
  goals: Goal[]
  constraints: Constraint[]
  outputStyle: OutputStyle
}
```

**冻结规则：** 字段语义（pattern/goals/constraints/outputStyle）冻结，不允许修改含义。新增字段需通过 ADR。

### 2. ThinkingPattern

有限枚举，每个 Pattern 代表一类通用的推理结构。

```typescript
type ThinkingPattern =
  | 'cause_effect'
  | 'hypothesis_verification'
  | 'option_evaluation'
  | 'goal_constraint_tradeoff'
  | 'default'
```

**冻结规则：** 现有 Pattern 语义冻结。**允许新增** Pattern（如 `'compare_analysis'`），新增不属于 Breaking Change。

### 3. ReasoningContext

ReasoningPlanner 的唯一输入。

```typescript
interface ReasoningContext {
  input: UserInput
  conversation?: ConversationSnapshot
}
```

**冻结规则：** 顶层字段（input/conversation）冻结。扩展点仅在 `ConversationSnapshot` 内部增加字段。

### 4. Dependency Direction

```
Reasoning
    ↓
ReasoningDirective
    ↓
LLM / PromptBuilder
```

**冻结规则：** 禁止反向依赖。Reasoning 层不得引用 Model / Prompt / Token / Temperature 等任何 LLM 概念。

---

## Invariants

| # | Rule | 验证方式 |
|---|------|----------|
| 1 | `ReasoningPlanner` 必须是纯函数。不得调用 LLM、Tool、Memory、Network。 | 代码审查 + Contract Tests |
| 2 | `ReasoningDirective` 为不可变值对象，生成后不允许修改。 | 代码审查 |
| 3 | `ReasoningContext` 是 Planner 唯一输入途经。不允许通过环境变量/全局状态/隐式参数传递辅助信息。 | 代码审查 |
| 4 | `ConversationSnapshot` 是 Context 唯一扩展点。`ReasoningContext` 顶层字段原则上不再新增。 | ADR Review |

---

## Not Frozen

以下项目不属于 Breaking Change，无需 ADR：

- ✓ **新增 ThinkingPattern** — 扩展枚举值
- ✓ **扩展 ConversationSnapshot** — 在预留的空接口中添加字段
- ✓ **优化 Planner Rules** — 关键词匹配、分类逻辑、Pattern 映射规则
- ✓ **更换 Prompt 模板** — PromptBuilder 中的中文措辞
- ✓ **更换 PromptBuilder 实现** — 适配不同模型
- ✓ **更换模型** — LLM 层独立演化

---

## Breaking Changes

以下操作必须通过 ADR 审核，不能作为日常变更：

- ✗ 修改 `ReasoningContext` 顶层接口
- ✗ 修改 `ReasoningDirective` 字段语义
- ✗ 修改 Planner 输入/输出契约（`plan()` 签名）
- ✗ Reasoning 层引入对 Prompt / Token / Model 的直接或间接依赖

---

## Verification

| Check | Status | Evidence |
|-------|--------|----------|
| Type Contract | ✅ | `tsc --noEmit` 0 errors |
| Planner Determinism | ✅ | 相同输入返回相同 Directive（Contract Tests） |
| Pattern Mapping | ✅ | 4 类输入 → 对应 4 种 Pattern |
| Default Fallback | ✅ | 闲聊/短查询 → EMPTY_DIRECTIVE |
| Dependency Direction | ✅ | Reasoning 无 Prompt import |
| Pure Function | ✅ | 无外部状态、无 I/O |

Contract Tests: `src/main/reasoning/__tests__/ReasoningPlanner.contract.test.ts` (14/14 passed)

---

## Consequences

### Positive

1. **推理指导不依赖模型** — Planner 是纯规则，更换模型不影响推理框架的选择。
2. **职责隔离** — Reasoning 管"想什么"，LLM 管"怎么想"，PromptBuilder 管"怎么说"。
3. **可测试** — Planner 是纯函数，Contract Tests 保证其行为稳定性。
4. **扩展安全** — 新增 Pattern 或扩展 Context 不破坏已有契约。

### Negative

1. **关键词规则只能覆盖常见场景** — 复杂或隐晦的推理需求仍需优化匹配规则。
2. **单轮推理指导** — 当前实现只对当前轮输入生成 Directive，不追踪多轮推理框架的切换和演进。
3. **无反馈闭环** — Planner 不消费 LLM 的回复质量反馈，规则优化依赖离线评估。

---

## Related

- [M4.1 Contract Tests](../src/main/reasoning/__tests__/ReasoningPlanner.contract.test.ts)
- [ReasoningPlanner Implementation](../src/main/reasoning/ReasoningPlanner.ts)
- [Reasoning Contract Types](../src/main/reasoning/types.ts)
- [PromptBuilder (LLM Layer)](../src/main/llm/PromptBuilder.ts)
