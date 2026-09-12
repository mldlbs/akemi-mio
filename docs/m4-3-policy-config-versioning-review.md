# M4.3 PolicyConfig Versioning Design Review

**日期:** 2026-07-09
**阶段:** Design Review → Schema Freeze
**前置:** M4.2.1 Decision Identity & Storage Boundary ✅

## 1. 当前状态

```
GuardrailPolicyConfig {
  version: '1.0.0'   ← 存在，纯静态字符串
  stateChange { degrading, stalled }
  informationGain { lowOutput*, repeatedContent* }
  goalProgress { degrading, stalled }
}
```

`config.version` 已出现在：
- `GuardrailDecision.policyVersion` — 决策输出中记录
- `DecisionIdentity.policyVersion` — Replay 等值性比较
- `GuardrailActionDeliveredPayload.policyVersion` — Delivery Trace
- `GuardrailActionDeliveryFailedPayload.policyVersion`

**问题：**
- `version` 是纯字符串，无生成/验证/分发机制
- `GuardrailProgressConsumer` 构造函数接收 `config`，无全局 Config Store
- 无运行中切换、无多版本共存、无版本回滚

## 2. 三个冻结问题

### Q1: Version Identity

| 问题 | 方案 |
|------|------|
| `configVersion` 由谁生成？ | 由 Guardrail Config Store 生成，Policy 本身不负责版本号生成 |
| Decision 如何引用版本？ | 当前已通过 `policyVersion: string` 传递，冻结此字段 |
| `configVersion` 是否参与 Replay Input？ | 是。`PolicyInput` 已包含 `config: GuardrailPolicyConfig.version`，Replay 保证相同 configVersion 映射相同行为 |

**冻结：** `configVersion` 由 Config Store 管理，Policy 消费但不生产。Replay Input 中 `config.version` 构成 Deterministic 输入的一部分。

### Q2: Activation Boundary

| 问题 | 冻结 |
|------|------|
| 是否允许运行中切换 config？ | **允许**，但有边界约束 |
| 切换生效时机？ | 仅在**下一次 `consume(snapshot)` 时**生效。即新 ProgressSnapshot → 新 PolicyInput → 新 Decision。不中断正在计算的 Decision |
| 如何避免 in-flight 混乱？ | 当前 `GuardrailProgressConsumer` 已是最佳设计：config 作为 `evaluate(input)` 的输入参数传递，非构造函数不可变绑定。切换 config 只需更新 Consumer 的 config 引用 |
| Decision 如何追溯 config？ | `policyVersion` 已记录。Audit 时可以反向查询 `version → config` |

**冻结约束：**
1. Config Store 不保证 Decision 与 Delivery Event 之间的 config 一致性。
   这是故意的 —— Decision 记 `policyVersion`，Delivery 也记 `policyVersion`，两者只有在同一 `version` 下才可比对。
2. Config Store 只负责存储 + 版本管理，**不负责** 运行时一致性（Runtime Consistency 属 Observability 范畴）。

### Q3: Rollback Fact

核心问题：Rollback 是一个 **Control Command** 还是 **Evaluation Event**？

| 维度 | Control Command | Evaluation Event |
|------|----------------|------------------|
| 是否记录在 EvaluationEvent 流中？ | ❌ 不记录 | ✅ 作为新 EventType 记录 |
| 是否可用于 Metrics 分析？ | ❌ Metrics 不可见 | ✅ Metrics 可感知回滚频率 |
| 是否可 Replay？ | ❌ Replay 无法复现控制动作 | ✅ Replay 可回放 |
| 是否可 Audit？ | ❌ 只能从系统日志推断 | ✅ Event 流直接查询 |

**冻结决策：** Rollback 是 **Evaluation Event**。

```
 'guardrail.config.rollback'  ← 新增 EventType
```

Payload 语义（见 Q4 冻结）：

```typescript
interface GuardrailConfigRollbackPayload {
  fromVersion: string   // 回滚前版本（被废弃的版本）
  toVersion: string     // 回滚目标版本（恢复到的版本）
  trigger: 'manual' | 'automated_guardrail' | 'deployment_failure'
  reason: string
  timestamp: number
}
```

理由：
- 只有作为 Event 记录，Metrics Engine 才能计算「回滚率」「版本稳定性」
- 只有作为 Event 记录，Audit 才能追溯「谁在何时将版本从 X 回退到 Y」
- `guardrail.config.rollback` 不属于 Delivery Trace（不关联具体 Decision）
- 也与 `guardrail.checked` / `guardrail.terminated` 正交（不表示 Policy 对 Agent 行为的判断）

### Q4: Version Lifecycle Identity（需要冻结）

当前 Schema Freeze 遗漏了一个关键契约：**版本事件中 version 字段的语义**。

#### 问题

Rollback 事件使用 `fromVersion / toVersion` 还是 `version`？
两者的含义差异：

| 方案 | 含义 | 问题 |
|------|------|------|
| `version` | 被回滚的版本 | `version: "2.0.0"` 无法区分「从 2.0.0 回退」还是「回退到 2.0.0」 |
| `fromVersion / toVersion` | 完整迁移链 | 明确描述「从 A 迁移到 B」，Audit 可还原版本图 |

#### 冻结决策

**采用 `fromVersion / toVersion` 方案。**

```typescript
/** Rollback 触发源分类 */
export type RollbackTrigger =
  | 'manual'                 // 人工介入回滚
  | 'automated_guardrail'    // Guardrail 自动触发（如新版本上线后决策异常率过高）
  | 'deployment_failure'     // 部署失败触发

/** 冻结完整 Payload Schema */
export interface GuardrailConfigActivatedPayload {
  /** 新上线的版本 Identity */
  version: string
  /** Config 实际生效时间戳（可能与 Event.timestamp 不同） */
  activatedAt: number
}

export interface GuardrailConfigRollbackPayload {
  /** 回滚前版本（被废弃的版本），必须等于当前 active 版本 */
  fromVersion: string
  /** 回滚目标版本，必须是历史中曾 active 过的版本 */
  toVersion: string
  /** 回滚来源分类，仅表示触发原因分类，不表示执行命令 */
  trigger: RollbackTrigger
  /** 回滚原因，人工或系统说明 */
  reason?: string
}
```

## 3. Schema Freeze

### 3.1 新增 EventType

```typescript
// types.ts — EventType union
| 'guardrail.config.activated'    // 新版本上线
| 'guardrail.config.rollback'     // 版本回退
```

### 3.2 新增 Payload

```typescript
// types.ts — Guardrail 新增

/** Rollback 触发源分类，限定 Metrics 聚合维度 */
export type RollbackTrigger =
  | 'manual'                 // 人工介入回滚
  | 'automated_guardrail'    // Guardrail 自动触发
  | 'deployment_failure'     // 部署失败触发

export interface GuardrailConfigActivatedPayload {
  /** 新上线的版本 Identity */
  version: string
  /** Config 实际生效时间戳（可能与 Event.timestamp 不同） */
  activatedAt: number
}

export interface GuardrailConfigRollbackPayload {
  /** 回滚前版本（被废弃的版本），必须等于当前 active 版本 */
  fromVersion: string
  /** 回滚目标版本（恢复到的版本），必须是历史中曾 active 过的版本 */
  toVersion: string
  /** 回滚来源分类，仅表示触发原因分类，不表示执行命令 */
  trigger: RollbackTrigger
  /** 回滚原因，人工或系统说明，可选 */
  reason?: string
}
```

### 3.3 EventPayload union 追加

```typescript
| ({ type: 'guardrail.config.activated' } & GuardrailConfigActivatedPayload)
| ({ type: 'guardrail.config.rollback' } & GuardrailConfigRollbackPayload)
```

### 3.4 GuardrailPolicyConfig 不变

当前结构已满足：

```typescript
GuardrailPolicyConfig {
  version: string         // 由 Config Store 管理
  stateChange { ... }     // 不变
  informationGain { ... } // 不变
  goalProgress { ... }    // 不变
}
```

## 4. 冻结后的架构关系

```
Guardrail Config Store        ← 新增：版本管理 + 持久化
  │
  ├─ getConfig(version?) → GuardrailPolicyConfig
  ├─ setActiveConfig(version) → guardrail.config.activated
  ├─ rollback(from, to) → guardrail.config.rollback
  │
  ▼
GuardrailProgressConsumer     ← 消费最新 config
  │
  evaluate({ snapshot, config })
  │
  ▼
GuardrailDecision {
  policyVersion: config.version  ← 引用而非嵌入
  ...
}
```

关键约束：
- Config Store 只负责版本管理和存储，不决定如何 evaluate
- Policy 是纯函数，不持有 config
- Decision 通过 `policyVersion` 引用 config，不嵌入 config 全文
- Rollback/Activation 作为 Event 记录，可被 Metrics Engine 消费

## 5. Schema Freeze 结论

| 冻结项 | 状态 | 变更文件 |
|--------|------|---------|
| `EventType` 新增 `guardrail.config.activated` / `guardrail.config.rollback` | ✅ Freeze | `types.ts` |
| `GuardrailConfigActivatedPayload { version, activatedAt }` | ✅ Freeze | `types.ts` |
| `GuardrailConfigRollbackPayload { fromVersion, toVersion, trigger: RollbackTrigger, reason? }` | ✅ Freeze | `types.ts` |
| `RollbackTrigger` 枚举 `'manual' \| 'automated_guardrail' \| 'deployment_failure'` | ✅ Freeze | `types.ts` |
| `GuardrailPolicyConfig` 结构不变 | ✅ No change | `GuardrailTypes.ts` |
| `GuardrailDecision.policyVersion` 冻结 | ✅ No change | `GuardrailTypes.ts` |
| `DecisionIdentity.policyVersion` 冻结 | ✅ No change | `GuardrailTypes.ts` |
| Version Lifecycle Identity：Replay 可仅从 Event 重建版本迁移图 | ✅ 满足 | — |

**不在此次冻结范围内（后续迭代）：**
1. Config Store 实现（M4.4）
2. 运行中 Config 切换 UI（无 UI 需求时跳过）
3. Evolution 驱动的自动版本调整（M5+）

---

**M4.3 Schema Freeze Gate: ✅ 通过。**

Implementation 阶段重点验证：
1. Config Store 是否保证 version 单调且不可复用。
2. activation/rollback event 是否与实际 active state 原子一致。
3. Replay 是否仅依赖 Event，而不回查 Config Store。
