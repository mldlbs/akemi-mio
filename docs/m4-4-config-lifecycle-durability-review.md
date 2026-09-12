# M4.4 Config Lifecycle Durability & Consistency Model — Design Review

## Context

M4.3 交付了一个运行时可用的 GuardrailConfigStore，但有两个已知约束需要在此阶段解决：

- **C1 — Persistence Boundary**: ConfigStore 当前是纯内存实现，重启后 version history 丢失
- **C2 — Consistency Model**: `activateConfig()` → `emit()` 之间存在间隙，emit 失败时 state/event 可能 divergence

M4.4 不扩展功能（不增加新 EventType、不修改 Config Schema），只回答 durability 和 consistency 的设计问题。

## 现有耐久性模式盘点（代码库已存在的能力）

| 模式 | 位置 | 成熟度 |
|------|------|--------|
| Telegram Outbox | `db/outbox.ts` + `telegram/OutboxWorker.ts` | 生产级 — 哈希去重、重试(3)、TTL 清理 |
| SQLite WAL journal | `db/connection.ts:82` — `PRAGMA journal_mode = WAL` | 已启用 |
| 周期性 dirty-flush | `db/connection.ts:125-131` — 10s 间隔 | 已启用 |
| Checkpoint 文件持久化 | `agent/SessionRecoveryManager.ts` | 生产级 — 会话级 JSON 快照 |
| ResourceBudget 文件持久化 | `core/ResourceBudget.ts:537-567` | 生产级 — 跨进程计数器持久化 |
| EvaluationStore flush | `evaluation/EvaluationStore.ts:78-101` | ⚠️ 失败时静默丢弃 |

## Design Review — 四个议题

### 议题 1: Config Mutation Durability Model

#### 选项 A: EvaluationEvent 日志重建（Event Sourcing）

**方案**:
- ConfigStore 不做独立持久化
- 启动时从 `evaluation_events` 表回放 `guardrail.config.activated` / `guardrail.config.rollback` 事件重建 state
- 运行时仍然保持内存 Map 提供 O(1) 访问

**优点**:
- 零额外持久化设施（复用 EvaluationStore）
- 与 Replay Contract 一致（Event 是 truth source）
- ConfigStore 真的是"运行时优化"

**缺点**:
- EvaluationStore flush 失败时，Config 事件和 Config 状态一起丢失（没有独立耐久性）
- 启动重建需要全量 scan evaluation_events 表（目前无该索引优化）
- 依赖 EvaluationStore 的持久化保证（当前是有损的）

**依赖关系**: ConfigStore durability = EvaluationStore durability

#### 选项 B: 独立 Config DB 表

**方案**:
- 新增 `config_versions` 表和 `config_active` 表（或单表 with active flag）
- ConfigStore 每次 mutation 同步写 DB
- 启动时从 DB 表重建内存 state

**优点**:
- 独立于 EvaluationStore 的 flush 问题
- 查询效率高（按 version 索引）
- 可保证 monotonic version 跨进程持续

**缺点**:
- 需要 DB schema migration（生产环境变更）
- Config DB 表与 EvaluationEvent 可能不一致
- 跨两个存储的原子性需要事务

**依赖关系**: ConfigStore durability = DB 表写成功

#### 选项 C: 复用 SessionRecoveryManager 的快照模式

**方案**:
- ConfigStore 定时写入 JSON snapshot 到文件系统
- 启动时加载最新 snapshot

**优点**:
- 实现简单（文件写 JSON）
- 不依赖 DB 状态
- ResourceBudget 已有相同模式

**缺点**:
- 快照可能落后于内存状态
- 无并发写保护
- 不自然作为"事实源"

**依赖关系**: ConfigStore durability = 文件系统写成功

### 议题 2: Event Delivery Guarantee

当前 `state-first` 模型:

```
ConfigStore.activateConfig()
  └─ state mutated ← 成功
EvaluationEmitter.emit()
  └─ EvaluationStore.append()
     └─ 推入内存 batch ← 成功（O(1)）
     └─ 异步 flush 到 SQLite ← 可能失败
```

问题: emit 成功 ≠ Event 已持久化。Event 要到 flush 后才 durable。

#### 建议: 不做第 N 次提交硬保证

当前 EvaluationStore 的设计选择是 **batch-and-flush**（非同步写），这不是可靠性问题，而是设计哲学：

- 如果追求 "emit 完成即 durable"，需要同步写 DB，这会阻塞 Runtime emit 路径
- 当前设计选择 emit 路径非阻塞，flush 失败静默丢弃

**M4.4 冻结**: Config lifecycle event（`guardrail.config.activated` / `guardrail.config.rollback`）与所有 EvaluationEvent 共享相同的持久性等级，不提供 stronger guarantee。不要误认为 config activation 是 control-plane transaction。

### 议题 3: State/Event Reconciliation Strategy

需要直接回答 C2 中提出的问题:

| 问题 | 回答 |
|------|------|
| emit failure 后如何检测？ | 运行时不做检测。启动时通过 scan Event 重建 state，发现 Event 缺失则接受 inconsistency |
| 是否允许短暂 state/event divergence？ | 允许。state-first 模型下，state 先变，Event 追记，有短暂窗口 |
| recovery source 是？ | **EvaluationEvent log**（Truth Source）。ConfigStore 是运行时优化 |

**Reconciliation 流程**:

```
AppRuntime 启动
  ↓
scan evaluation_events WHERE type IN ('guardrail.config.activated', 'guardrail.config.rollback')
  ↓
按 timestamp ASC 排序
  ↓
if events 为空（首次安装 / 无任何 config event）:
  → 使用 DEFAULT_GUARDRAIL_POLICY_CONFIG（正常 fallback）
else if timeline 完整（activated → rollback 成对闭合，无断裂）:
  → playback 重建：每个 activated → 创建 ConfigRecord；每个 rollback → 设置 activeVersion
  → 最终 activeVersion = 该 trace 的最后一次 rollback 目标或最后一次 activated 版本
else（timeline 断裂 / event 缺失导致无法确定最终版本）:
  → FAIL STARTUP / degraded mode
  → 不允许静默回退 DEFAULT（会隐藏数据损坏）
```

**DEFAULT 的适用边界**:
- ✅ 首次安装（无任何 config event 的环境）
- ✅ 启动时重建结果为空（0 events）
- ❌ Event 存在但不完整（timeline 断裂） — 必须  fail/degrade，不能 fallback

**限制条件**:
- 如果 `activateConfig()` 成功 + `emit()` 追加到 batch → **进程 crash 前未 flush** → Event 和 State 都丢失 → scan 结果为空 → 使用 DEFAULT fallback（合法，因为没有 event 存在）
- 如果 `activateConfig()` 成功 + `emit()` 成功追加到 batch → **flush 失败** → Event 丢失（batch drained），但 memory ConfigStore 持有状态 → scan 结果为空 → DEFAULT fallback → 运行时 state（v?）与 Event log（空）不一致 → **这是可接受的风险**，与 EvaluationStore 的 flush 失败共享同一缺陷模型

**是否需要补偿机制？**
- M4.4 scope: **不需要**
- 原因是: EvaluationStore 的整体可靠性不高于 ConfigStore 的可靠性。如果 EvaluationStore 的 flush 失败模式不被认为是需要补偿的问题，那么 ConfigStore 同样不需要。
- 如果未来 EvaluationStore 获得 retry/DLQ，ConfigStore 自动受益（Event 持久化保证提升）

### 议题 4: EvaluationStore 与 ConfigStore 的持久化关系

#### 当前关系:

```
EvaluationStore (evaluation_events 表)
  └─ 所有 EvaluationEvent 的持久化存储

GuardrailConfigStore (纯内存)
  └─ 无持久化
  └─ 运行时从 Event 重建
```

#### 建议冻结关系:

```
Truth: EvaluationEvent log (evaluation_events 表)
  └─ 由此重建: ProgressSnapshot / GuardrailDecision / GuardrailConfig state

Cache: GuardrailConfigStore (内存)
  └─ 由 EvaluationEvent 重建
  └─ 运行时优化，非 truth source
```

这个关系与"Replay 可仅从 Event 重建版本迁移图"（M4.3 Schema Freeze Q4）一致。

## 最终 Design Freeze

### C1 — Persistence Boundary

| 项目 | 冻结 |
|------|------|
| GuardrailConfigStore 持久化策略 | **Event Sourcing from EvaluationEvent log**（议题 1 选项 A） |
| 启动时重建 | scan `guardrail.config.activated` / `guardrail.config.rollback` |
| 重建结果为空时 | fallback 到 `DEFAULT_GUARDRAIL_POLICY_CONFIG` |
| 首次实现时间 | **M4.4**（伴随本次设计 review） |
| 新增 DB 表 | **不需要**（复用 evaluation_events 表） |

### C2 — Consistency Model

| 项目 | 冻结 |
|------|------|
| 模型 | state-first（ConfigStore state 先变，Event 追记） |
| startup consistency check | 以 Event log 为准重建 state（接受运行时 state ≠ Event log） |
| emit failure 补偿 | M4.4 不实现补偿机制 |
| flush failure | 与 EvaluationStore 共享相同的 durability 等级（不单独增强） |
| 约束 | ConfigStore 的可靠性不高于 EvaluationStore |

### 约束对 Implementation 的影响

因选择 **选项 A（Event Sourcing from EvaluationEvent log）**：
- GuardrailConfigStore 必须支持 `loadFromEvents(events)` 方法
- 需要在 AppRuntime 启动时 EvaluationStore ready 之后调用重建
- ConfigStore 的 `activateConfig()` 必须**改为非副作用**：不再自生成 `version`，而是 emit callback（调用方 emit event，event 持久化后调用 ConfigStore.applyEvent）
- 或者在 ConfigStore 内完成 state + event 并返回，由调用方 emit

两种子选项:

**A1 (Recommended): ConfigStore.applyActivated / applyRollback**

```
Producer
  └─ generate version (allocateVersion)
  └─ append Event to EvaluationStore
  └─ ConfigStore.applyActivated(version, config, activatedAt)
                        或 applyRollback(fromVersion, toVersion)

ConfigStore
  └─ 纯 Consumer / Projection
  └─ 不拥有 lifecycle truth
  └─ 从 Event 推导 state
```

ConfigStore 变为纯"Event Projection"——它不产生 Event，只消费 Event 来维护内存状态。

`allocateVersion()` 是辅助工具方法，不是最终事实：
- renamed from `generateVersion()` → `allocateVersion()`
- Event producer 可以：`version = store.allocateVersion()` → 构造 Event → append → store.applyActivated(version, config, activatedAt)
- ConfigStore 不验证 version 是否由它生成，只接受任意外部 version 字符串

**A2: 保持当前 API + 启动时全量重建**（不推荐）

```
activateConfig(config) — 当前 API 不变，返回 { version, activatedAt }
  
startupReconcile(events) — 新增方法
  └─ 清空 records
  └─ replay events 重建 state
```

**推荐 A1**，原因：
- ConfigStore 是 Event Projection，不是 Event Producer → A1 更准确
- 调用方负责 append Event + apply → 原子性由调用方保证
- 没有 state-first/event-last 间隙问题（因为 state 变化仅通过 applyActivated/applyRollback 入口）
- A2 的 activateConfig() 仍然有"state mutated but Event not written"的设计问题

## 最终 Design Freeze

### C1 — Persistence Boundary

| 项目 | 冻结 |
|------|------|
| GuardrailConfigStore 持久化策略 | **Event Sourcing from EvaluationEvent log**（议题 1 选项 A） |
| 启动时重建 | scan `guardrail.config.activated` / `guardrail.config.rollback` |
| 重建结果为空时 | ✅ **无历史**：fallback 到 `DEFAULT_GUARDRAIL_POLICY_CONFIG`（首次安装 / 无 config event） |
| 重建结果空时（非首次） | ❌ **不允许 fallback**：timeline 断裂时必须 fail startup 或 degraded mode |
| 新增 DB 表 | **不需要**（复用 evaluation_events 表） |

### C2 — Consistency Model

| 项目 | 冻结 |
|------|------|
| 模型 | ConfigStore 是 **Event Projection**，不拥有 lifecycle truth |
| Delivery guarantee | Config lifecycle event 与 EvaluationEvent 共享**同等级**持久性保证，不提供 stronger guarantee |
| startup consistency check | 以 Event log 为准重建 state；timeline 断裂时 fail/degrade，不静默回退 DEFAULT |
| emit failure 补偿 | M4.4 不实现补偿机制 |
| flush failure | 与 EvaluationStore 共享相同的 durability 等级（不单独增强） |
| 约束 | ConfigStore 的可靠性不高于 EvaluationStore |

### C3 — API Design

| 项目 | 冻结 |
|------|------|
| ConfigStore 角色 | **Event Projection**（Consumer，非 Producer） |
| 激活方法 | `applyActivated(version, config, activatedAt)` |
| 回滚方法 | `applyRollback(fromVersion, toVersion)` |
| 启动重建 | `loadFromEvents(events)` — scan + playback |
| 版本分配 | `allocateVersion()` — 辅助工具方法，不是最终事实 |
| 版本来源 | ConfigStore 不验证 version 来源，接受任意外部 version 字符串 |

## 实现范围

| 变更 | 文件 | 备注 |
|------|------|------|
| ConfigStore API 改为 applyActivated/applyRollback | `GuardrailConfigStore.ts` | 移除自生成 version；version 由调用方提供（或 ConfigStore 提供 generateVersion() 作为辅助工具函数） |
| 新增 loadFromEvents | `GuardrailConfigStore.ts` | 启动重建 |
| AppRuntime 启动时重建 | `AppRuntime.ts` | EvaluationStore init 后调用 loadFromEvents |
| ConfigStore 单元测试 | `GuardrailConfigStore.test.ts` | 追加 applyActivated/applyRollback/loadFromEvents 测试 |
| 集成验证 | `m4-3-config-store-integration.test.ts` + 扩展 | 重建后 state 正确 |

## 不在此次冻结范围内

- Config 持久化到独立 DB 表
- emit failure 的检测与补偿
- EvaluationStore 的 flush 可靠性提升
- 跨进程 ConfigStore 一致性
- Evolution 驱动的自动 Config 调整（M5+）

## 验收标准

1. `GuardrailConfigStore.loadFromEvents(events)` 重建与 M4.3 相同的 state
2. 启动重建后 getActiveConfig() 正确
3. 无 Event 时 fallback 到 DEFAULT
4. `applyActivated` + `applyRollback` 保持单调性和正确性
5. 重建性能：1000 events 以下重建在 10ms 内（纯内存排序 + 过滤）
