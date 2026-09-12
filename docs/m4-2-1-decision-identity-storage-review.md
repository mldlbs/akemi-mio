# M4.2.1 Decision Identity & Storage Boundary Review

**Status:** Review  
**Precondition:** M4.2 Schema/Producer/Verification ✅  
**Requires:** Freeze two open items before entering M4.3

---

## 1. Decision Identity 语义冻结

### 当前实现（已修正）

`decisionId` 的生成已从 `Policy.evaluate()` 移至 `Pipeline`：

```typescript
// Policy.evaluate() — 纯函数，不生成随机 ID
evaluate(input: PolicyInput): GuardrailDecision {
  return {
    // 无 decisionId
    action, reason, decidedAt, traceId, signals, snapshot, policyVersion,
  }
}

// Pipeline.onGuardrailDecision() — 生成决策实例 ID
onGuardrailDecision(decision: GuardrailDecision): void {
  this.latestDecision = decision
  this.latestRuntimeAction = toRuntimeAction(decision.action)
  this.latestDecisionId = randomUUID()        // ← 实例身份在此产生
}

// Pipeline.check() — 将 decisionId 放入 PipelineResult
async check(traceId, currentTurn): Promise<PipelineResult | null> {
  ...
  return { decisionId: this.latestDecisionId, runtimeAction, decision }
}
```

### 冻结语义

| 概念 | 类型 | 生成者 | 用途 |
|------|------|--------|------|
| `DecisionIdentity` | 确定性比较键 | `Policy.evaluate()` | Replay 等值性判断 |
| `PipelineResult.decisionId` | 运行时实例 ID | `Pipeline` | Delivery Trace 关联 |

两者不冲突：

```
Replay:   input → evaluate() → DecisionIdentity  ← 确定性，对比用
Runtime:  input → evaluate() → Decision → Pipeline → decisionId  ← 唯一实例标识
```

**冻结结论：** `DecisionIdentity`（replay 比较）和 `decisionId`（trace 关联）是两个不同的概念，同一个 Pipeline 下共存。

---

## 2. Delivery Trace 存储边界

### 当前状态

Delivery Event 通过 `EvaluationEmitter` 写入 `EvaluationStore`：

```
ChatExecutor
  ↓
EvaluationEmitter.emit('guardrail.action_delivered')
  ↓
EvaluationStore.append()
```

### 风险分析

| 风险 | 评估 | 缓解措施 |
|------|------|---------|
| EvaluationStore 从"Evaluation facts"扩展为"Runtime facts" | ⚠️ 语义边界模糊 | 逻辑隔离：Delivery Event 不会被 `compute()` 读取（T-4 已验证） |
| Replay 数据边界变模糊 | ⚠️ Replay 只读 `model.* / tool.* / task.*` 等 | Delivery Event 不在 `compute()` 输入范围内（T-4 已验证） |
| 未来 Filter 逻辑负担 | ⚠️ 所有 query 需要额外 filter | 通过 `EventType` 天然隔离 |

### 存储策略选择

| 方案 | 成本 | 收益 | 推荐 |
|------|------|------|------|
| A: 同一 Store，类型隔离 | 无额外成本 | 统一持久化、统一事务 | ✅ **冻结** |
| B: 独立 DeliveryTraceStore | 额外存储实现、迁移成本 | 物理隔离，query 时无需 filter | ❌ 当前阶段过度设计 |

**冻结结论（方案 A）：**

```
EvaluationStore (single append-only log)
  ├── evaluation events (model.*, tool.*, task.*, workflow.*)
  ├── decision events (guardrail.checked, guardrail.terminated)
  └── delivery events (guardrail.action_delivered, guardrail.action_delivery_failed)
      ↑ T-4 已验证不影响 compute()
```

**隔离承诺：**

- Delivery Event 永远不被 `ProgressAnalyzer.compute()` 消费（T-4）
- Delivery Event 不作为 Replay 输入
- 查询 Delivery Trace 通过 `EventType` 过滤（`query({ type: 'guardrail.action_delivered' })`）
- 不需要独立存储实现

若未来出现以下场景，可重新评估方案 B：

1. Delivery Event 的写入频率超过 Evaluation Event 的 10 倍；
2. Delivery Event 需要独立的 TTL / 清理策略；
3. 需要将 Delivery Trace 暴露给外部审计系统，同时隔离 Evaluation 数据。

---

## 3. 冻结 Checklist

| # | 项目 | 决策 | 状态 |
|---|------|------|------|
| I-1 | `decisionId` 属于哪个层？ | Pipeline 层（实例身份），不是 Policy 层（语义身份） | ✅ 已实现 |
| I-2 | `DecisionIdentity` 和 `decisionId` 冲突吗？ | 不冲突：前者是语义比较键，后者是实例 trace ID | ✅ |
| S-1 | Delivery Trace 存 EvaluationStore 还是独立 Store？ | 同一 Store，类型隔离（方案 A） | ✅ 冻结 |
| S-2 | Delivery Event 会被 `compute()` 消费吗？ | ❌ 永不（T-4） | ✅ 已验证 |
| S-3 | Delivery Trace 的查询方式？ | `EventType` 过滤 | ✅ |
| S-4 | 什么条件下需要独立 Store？ | 频率 10x+、独立 TTL、外部审计 | ⏳ 将来 |

---

**下一步：**

```
M4.3 PolicyConfig Versioning
```

冻结条件：I-1 ✅, I-2 ✅, S-1 ✅, S-2 ✅, S-3 ✅, S-4 ⏳
