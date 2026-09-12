# Consumer Boundary Review (M4)

**Status:** Review  
**Precondition:** Policy Contract Frozen ✅  
**Next:** Consumer Implementation

---

## Review 四问

### 问题 1：Consumer 输入是否只能是 `consume(snapshot: ProgressSnapshot)`？

**当前冻结状态：**

```typescript
interface ProgressConsumer {
  consume(snapshot: ProgressSnapshot): void | Promise<void>
}
```

**结论：保持现状。Consumer 不接收 Decision。**

理由：
- Consumer 和 Policy 是独立的语义层。Consumer 接收 ProgressSnapshot（事实），Policy 产出 Decision（判断）。
- 如果 Consumer 同时接收 `snapshot + decision`，Consumer 可能依赖 Policy 输出，这是隐式耦合。
- 未来若有 Consumer 需要决策上下文（如 Health Dashboard 同时展示事实和判断），应通过 `AuditEvent` 或 `DashboardEvent` 服务，不由 Observer 注入。

| 输入 | 是否允许 | 理由 |
|------|---------|------|
| ProgressSnapshot | ✅ 唯一输入 | M2/M3 冻结 |
| GuardrailDecision | ❌ | 允许则 Consumer 可能变成 Policy 的副消费方 |
| EvaluationEvent[] | ❌ | 违反 Progress 语义分层 |
| Runtime context | ❌ | 违反 M3 Observer 隔离 |

### 问题 2：Consumer 是否产生副作用？

**结论：允许有上下界副作用。禁止跨域副作用。**

```text
Allowed:
  ✔ 写 Audit Event（记录消费结果）
  ✔ 发 Notification（如 terminate → UI 通知）
  ✔ 触发 Runtime Action（通过 Pipeline callback，已实现）

Forbidden:
  ✗ 修改 ProgressSnapshot（只读）
  ✗ 修改 PolicyConfig（只读）
  ✗ 修改 Observer 行为（不注册/注销其他 Consumer）
  ✗ 访问 EvaluationEvent[]（绕过语义分层）
```

**边界规则：副作用只能在 consume() 内部执行，Observer 不代为执行。**

当前实现已验证此边界：

```typescript
// GuardrailProgressConsumer — 正确
async consume(snapshot: ProgressSnapshot): Promise<void> {
  const decision = this.policy.evaluate({ snapshot, config })
  this.onDecision(decision)  // 副作用：callback
  // 不写 Audit Event，不修改任何状态
}
```

### 问题 3：Consumer 输出是否需要 Contract？

**结论：不需要。`void` 冻结，不提前抽象 `ConsumerResult`。**

```typescript
consume(snapshot: ProgressSnapshot): void | Promise<void>
```

约束：
- Consumer 没有统一返回值
- Consumer 的"输出"通过副作用渠道传递（callback / event / notification）
- 未来如有跨 Consumer 的输出聚合需求，应定义新 Event Type，不是新接口

| 候选输出形式 | 结论 | 理由 |
|-------------|------|------|
| `void` | ✅ 冻结 | M3 认定 |
| `ConsumerResult { success, error }` | ❌ 不引入 | 错误应由 Observer 捕获，非 Consumer 返回 |
| `Decision | Score | Insight` | ❌ 不统一 | 各 Consumer 输出异构，统一是无意义抽象 |

### 问题 4：多 Consumer 执行顺序是否有语义？

**当前 Observer 实现：**

```typescript
// ProgressObserver — 注册的 Consumer 按注册顺序执行
for (const consumer of this.consumers) {
  await consumer.consume(snapshot)
}
```

**结论：Consumer 执行顺序无语义。所有 Consumer 必须是顺序无关的。**

保证：
- 任何 Consumer 不依赖其他 Consumer 的输出
- 任何 Consumer 的执行顺序互换时，Final Decision 不变
- Consumer 是独立副作用的集合，非管道

**失败隔离：**

| 场景 | 当前行为 | 是否可接受 |
|------|---------|-----------|
| Consumer A 抛异常 | B/C 继续执行 | ✅ 已验证（V-4） |
| Consumer A 慢查询 | B/C 等待 | ⚠️ 当前串行，未来可考虑并发 |
| Consumer A `onDecision` 死循环 | 阻塞 Observer | ⚠️ 需要 caller 侧超时保护 |

**恢复策略：**
- any Consumer 失败 → 标记该 Consumer 异常，其他 Consumer 继续
- Observer 应提供 `removeConsumer()` 用于健康管理
- 未来若出现慢 Consumer，Observer 可增加超时或并发执行（不改变 contract）

---

## Review 冻结范围

### 新增冻结项

```
Consumer Contract Freeze:
- consume(snapshot: ProgressSnapshot): void
- Consumer 输入仅限于 ProgressSnapshot
- Consumer 禁止修改 Snapshot / Config / Observer
- Consumer 顺序无关
- Consumer 异常不阻断其他 Consumer
```

### 不在此范围

```
- Consumer 实现逻辑（阈值、通知方式、输出格式）
- async vs sync 执行策略
- Consumer 健康管理/熔断
- Audit Event schema（O-2）
```

---

## 两步冻结汇总

| 层 | 冻结对象 | 状态 |
|----|---------|------|
| Policy Contract | `PolicyInput`, `evaluate(input)`, `DecisionIdentity` | ✅ Frozen |
| Consumer Boundary | `consume(snapshot)` 输入/输出/副作用/顺序规则 | ✅ Reviewed |
| Consumer Implementation | — | ❌ Not started |

下一步：在冻结的 Consumer Boundary 内实现具体 Consumer（Fitness / Reflection 等）。
