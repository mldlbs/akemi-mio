# Decision Research 004 — Review Record

> **Phase:** ADR-004 Phase 0: Decision Research — Closure Review
> **Date:** 2026-07-08
> **Reviewing:** `docs/decision-research-004.md`
> **Status:** 3/4 Pass — 1 finding in D-3

---

## D-1: Interface Closure

**判定：✅ Pass**

所有受 ADR-004 影响的接口均已识别：

| 接口 | 位置 | 影响方式 |
|------|------|---------|
| `ProgressConsumer.consume(snapshot): void \| Promise<void>` | `progress.ts:228` | 可能增加 Decision 输出能力 |
| `GuardrailPolicy.evaluate(snapshot): GuardrailDecision` | `GuardrailTypes.ts:82` | 不受影响（Consumer 内部） |
| `GuardrailPipeline.check(traceId, turn): PipelineResult \| null` | `GuardrailPipeline.ts:66` | 移除 Analyzer 引用，改为接收 Decision |
| `PipelineResult` | `GuardrailPipeline.ts:36-38` | 可能需要重构 |
| `RunContext.guardrailStop: boolean` | `runstate.ts:75` | 不受直接影响 |
| `EvaluationEmitter.emit(type, payload, meta?)` | `EvaluationEmitter.ts` | 使用方式可能变化 |

**确认没有遗漏的参与者或交互边界。**

---

## D-2: Constraint Closure

**判定：✅ Pass**

| # | 硬约束 | 来源 | 已记录 |
|---|--------|------|--------|
| REQ-1 | Decision 到达后下一个 LLM 调用前必须生效 | ChatExecutor 同步 await | ✅ REQ-1 |
| REQ-2 | TERMINATE 必须当前轮次到达 | 无 buffer | ✅ REQ-2 |
| REQ-3 | WARNING 可以延迟 | 仅日志，非控制流 | ✅ REQ-3 |
| REQ-4 | Decision 错误不能中断 toolLoop | catch → return null | ✅ REQ-4 |
| REQ-5 | consume() 签名最小变化 | ADR-003 冻结 | ✅ REQ-5 |
| REQ-6 | Pipeline 不直接依赖 Observer | 架构解耦 | ✅ REQ-6 |
| REQ-7 | Runtime 只消费 RuntimeAction | 现有架构 | ✅ REQ-7 |
| REQ-8 | 单 trace 一次性 routing | ChatExecutor 单例 | ✅ REQ-8 |
| — | ADR-003: consume() 签名不可修改 | §ADR-4 | ✅ R-4 |
| — | ADR-003: Consumer 无状态 | §ADR-4 | ✅ R-4 |
| — | ADR-003: Consumer 独立 | §ADR-4 | ✅ R-4 |
| — | ADR-003: Observer 不参与 Decision Delivery | §ADR-5 | ✅ R-4 |
| — | ADR-003: Observer 不引用 ChatExecutor | §ADR-5 | ✅ R-4 |

额外确认：`getTrace` 查询延迟随 trace 增长而增长，但这是已有约束（非 ADR-004 新增），不影响候选模式的可行性。

---

## D-3: Option Completeness

**判定：⚠️ Partial — 缺少一个候选模式**

Research 文档列出 5 种模式：A-Callback, B-Output Interface, C-EventBus, D-Shared State, E-Queue。

**遗漏的模式：**

**Pattern F: 修改 `consume()` 返回类型**

```
consume(snapshot: ProgressSnapshot): GuardrailDecision | Promise<GuardrailDecision>
```

即 Consumer 直接返回 Decision，替代通过回调/输出接口传递。

评估：

| 维度 | 评价 |
|------|------|
| 与 ADR-003 兼容？ | ❌ 修改了已冻结的 `consume(): void` 签名 |
| C-5 合规？ | ✅ Consumer 不调 Producer API |
| Governance 路径 | ⚠️ 需要 ADR 提出"修改已冻结协议"的论证 |
| 实现复杂度 | 最低 |

ADR-003 §ADR-4 明确 `consume()` 不定义统一返回值，理由是"不同 Consumer 的输出不同"。但这不等于**技术上不能**改为返回 `GuardrailDecision | void`（Guardrail 返回 Decision，Fitness 返回 void）。

**是否需要补充到 Research 文档？**

- 如果 ADR-004 认为"修改冻结协议"是不可接受的 → Pattern F 直接淘汰，不影响已有结论
- 如果 ADR-004 认为"可以重新评估该冻结决策" → Pattern F 应被列入候选

这取决于 ADR-004 对 ADR-003 §ADR-4 的态度。建议在 ADR-004 的 Considered Options 中明确记录此模式被拒绝的理由，而非在 Research 阶段排除。

**因此 D-3 判定为 Partial — Research 文档应增加 Pattern F 的备注，但不改变研究本身的结构。**

---

## D-4: Migration Impact

**判定：✅ Pass**

### 完整影响矩阵

| 模块 | 是否受影响 | 影响类型 | 说明 |
|------|-----------|----------|------|
| `progress.ts` — ProgressConsumer 接口 | ⚠️ 取决于决策 | **契约** | A/Callback → 新增参数；B/Output → 不变；F/Return → 改返回类型 |
| `ProgressObserver.ts` | **否** | — | Observer 止于 `consume()`，不参与 Decision Delivery |
| `GuardrailTypes.ts` — Decision/RuntimeAction | **否** | — | 类型定义已完整，不变 |
| `GuardrailPolicy.ts` | **否** | — | 内部逻辑不变，作为 Consumer 的组成部分 |
| `GuardrailProgressAnalyzer.ts` | **否** | — | 纯函数保持不变 |
| `GuardrailPipeline.ts` | **是** | **调用路径** | 移除 Analyzer 引用；移除 `analyze()` 调用；改从 Consumer 接收 Decision；保留 throttle/mapping/return |
| `EvaluationEmitter.ts` | ⚠️ 取决于决策 | **Event Domain** | 如果 Decision Channel 独立 → 可能减轻 Emitter 负载；如果保留 → 不变 |
| `EvaluationStore.ts` | **否（预期）** | — | 持久层应保持不变 |
| `types.ts` — EventType | ⚠️ 取决于决策 | **Schema** | `guardrail.checked`/`guardrail.terminated` 可能移出 EventType |
| `ToolEventBridge.ts` | **否** | — | EventBus → EvaluationEmitter 桥不变 |
| `MetricsEngine.ts` | **否** | — | 独立子系统 |
| `ChatExecutor.ts` | **是** | **Runtime 集成** | Decision 获取方式从 `await pipeline.check()` 变为从 Consumer 输出接收 |
| `AgentService.ts` | **否**（预期） | — | ChatExecutor 接口不变 |
| `runstate.ts` | **否**（预期） | — | `guardrailStop` 字段保持不变 |
| `Guardrail.ts` (local) | **否** | — | 本地 guardrail 无关 |
| `ProgressGuardrail.ts` | **否** | — | 本地 heuristic 无关 |
| `ExecutionGovernor.ts` | **否** | — | 独立 decision gate |
| `AppRuntime.ts` | **是** | **Wiring** | Pipeline 构建方式变化；Consumer 注册方式变化 |

### 影响矩阵总结

| 范围 | 数量 |
|------|------|
| 确认受影响 | 3 (GuardrailPipeline, ChatExecutor, AppRuntime) |
| 视决策而定 | 3 (progress.ts, EvaluationEmitter, types.ts) |
| 不受影响 | 12 个模块 |

**ADR 边界收敛**：影响范围未扩大，核心 Producer（Analyzer/Store/Policy）保持不变。

---

## Review 结果

| 检查项 | 状态 |
|--------|------|
| D-1: Interface Closure | ✅ Pass — 所有受影响接口已识别 |
| D-2: Constraint Closure | ✅ Pass — 13 条硬约束已收集 |
| D-3: Option Completeness | ⚠️ Partial — 缺少 Pattern F (修改 consume() 返回类型) |
| D-4: Migration Impact | ✅ Pass — 影响范围收敛，3 模块确认 + 3 待定 |

**3/4 Pass，D-3 需在 ADR-004 中处理。**

---

## 对 ADR-004 的建议

限于记录一个 Review 发现：

> **Pattern F（修改 consume() 返回类型）应在 ADR-004 中以 Considered Options 形式记录，并明确拒绝理由（修改已冻结协议），而非在 Research 阶段排除。**
