# Consumer Implementation Review (M4)

**Status:** Review  
**Precondition:** M4 Contract Frozen ✅  
**Next:** Consumer Implementation

---

## 问题 1：Consumer 是否负责 Decision 生成？

**结论：Consumer 不生成 Decision。**

当前数据流不可改变：

```text
Observer.onEvent()
   ↓
Analyzer.compute()
   ↓
Snapshot
   ↓
Consumer.consume(snapshot)
   ↓
   ┌─ (内部调用 Policy.evaluate(input)) ─→ Decision → onDecision callback
   └─ (其他副作用，无返回值)
```

Consumer 接收 Snapshot（事实），Policy 产出 Decision（判断），Pipeline 消费 RuntimeAction（执行指令）。Consumer 只负责"消费事实并触发副作用"——其中 GuardrailConsumer 的唯一副作用是通过 `onDecision` callback 向 Pipeline 投递 Decision。

### 理由

- **单一职责分离**：GuardrailConsumer 不应既 evaluate 又 deliver；但当前它是 Policy 的调用方，Pipeline 的交付方。这层 Bridge 角色是 ADR-004 的原因（Consumer 持有 Policy 引用，Pipeline 不持有）。
- **未来 Consumer 不需要 Policy**：FitnessConsumer / ReflectionConsumer 只需要 Snapshot，不需要 Policy 或 Decision。
- **现有约束已在 C-5 验证**：Consumer 不持有 Store / Analyzer / Emitter 引用，这些是 Pipeline 的职责。

## 问题 2：Consumer 是否负责 Runtime Action？

**结论：Consumer 不直接产生 Runtime Action，通过 onDecision callback delivery。**

```text
Snapshot
   ↓
Consumer.consume(snapshot)
   ↓
   ┌─ GuardrailConsumer
   │     policy.evaluate(input)
   │       ↓
   │     Decision → onDecision(decision) ——→ Pipeline.check() → RuntimeAction
   │
   ├─ FutureFitnessConsumer (snapshot only, no callback)
   ├─ FutureReflectionConsumer (snapshot only, no callback)
   └─ FutureEvolutionConsumer (snapshot only)
```

### Runtime Action Delivery 路径

```
Consumer.onDecision callback
        ↓
Pipeline.onGuardrailDecision(decision)  ← 缓存 latestDecision
        ↓
Pipeline.check(traceId, turn)          ← throttle + traceId 匹配
        ↓
toRuntimeAction(decision.action)       ← GuardrailAction → RuntimeAction
        ↓
RuntimeAction → ChatExecutor.toolLoop  ← 'CONTINUE' | 'WARNING' | 'TERMINATE'
```

### 约束

| 层 | 产出 | 谁消费 |
|----|------|--------|
| Policy.evaluate(input) | GuardrailDecision | Consumer（onDecision callback） |
| Pipeline.onGuardrailDecision() | 缓存 + 预计算 RuntimeAction | Pipeline.check() |
| Pipeline.check() | PipelineResult { runtimeAction, decision } | ChatExecutor |
| ChatExecutor | toolLoop 退出/放行 | Chat Runtime |

**禁止：Consumer 直接调用 Pipeline.check() 或访问 RuntimeAction。**

## 问题 3：Failure Semantics

### 已验证

| 场景 | 当前行为 | 验证 |
|------|---------|------|
| Consumer 抛出异常 | 不阻断其他 Consumer | V-4 (producer-boundary-verification) |
| Consumer 数量变化 | Snapshot 不变 | V-4 |
| Pipeline 无 callback Decision | check() 返回 null | guardrail-kernel (C) |

### 需定义

| 场景 | 建议行为 | 理由 |
|------|---------|------|
| Pipeline.onDecision 未调用（Consumer 未投递） | check() 返回 null，Runtime 不干预 | 已实现 |
| Action delivery 失败 | Pipeline 日志 warning，不重试 | Action delivery 是 Runtime 生命周期之外 |
| Guardrail 产生 terminate 但 Runtime 已完成 | 放行已结束的 trace，不追溯 | Pipeline reset() 清除 throttle |
| Consumer onDecision 重复调用 | 覆盖 latestDecision（当前行为） | ADR-004 设计：Final Decision Only |

### Audit Event

当前 Consumer 不写入 Audit Event。Pipeline 负责 `guardrail.checked` / `guardrail.terminated` 事件。

**建议：Consumer 不直接写 EventBus。** Consumer 的可见性通过 Pipeline 的 Audit Event 实现。未来 O-2 决定 Audit Event 归属时，Consumer 不应成为候选。

---

## 实现顺序建议

### Phase A — GuardrailConsumer（当前已完成，contract compliance check）

验证当前 GuardrailProgressConsumer 是否符合新的 Consumer Contract：

| 约束 | 检查 | 状态 |
|------|------|------|
| consume(snapshot) 签名 | consume() 接收 ProgressSnapshot | ✅ |
| 不生成 Decision 作为返回值 | 返回 void | ✅ |
| 不产生 RuntimeAction | callback → Pipeline，非直接调用 | ✅ |
| 异常不阻断其他 Consumer | 已在 V-4 验证 | ✅ |
| 不持有 Store/Analyzer/Emitter | 无这些字段 | ✅ (C-5) |

### Phase B — FutureConsumer 实现（仅在不违反 contract 的前提下）

| Consumer | Policy 依赖 | Audit Event | 优先级 |
|----------|------------|-------------|--------|
| FitnessConsumer | ❌ 不需要 | ⏳ O-2 后 | 低 |
| ReflectionConsumer | ❌ 不需要 | ⏳ O-2 后 | 低 |
| EvolutionConsumer | ❌ 不需要 | ⏳ O-2 后 | 低 |

### Phase C — M4 Verification

与 M3 模式一致：

| Invariant | 验证内容 |
|-----------|---------|
| C-1 | Consumer 不影响 Producer |
| C-2 | Consumer 不依赖其他 Consumer |
| C-3 | Consumer 异常不阻断 Pipeline |
| C-4 | Runtime Action delivery 与 Consumer 解耦 |

---

## Review 结论

当前 GuardrailConsumer 符合所有 Consumer Contract 约束，不需要修改即可进入后续实现。

但建议在当前轮次不要实现新 Consumer。M4 的第一优先级不是 Consumer 数量，而是：

1. **Contract verification 到 production** — 确认 GuardrailConsumer 在 true Runtime 中的行为（不仅仅是 test fixture）
2. **Action delivery trace** — guardrail.checked / guardrail.terminated 事件可被下游消费
3. **PolicyConfig 版本化回退** — 如果 config 变更导致 Decision 变化，是否有回退机制

这些完成后，再考虑 Fitness / Reflection / Evolution Consumer。
