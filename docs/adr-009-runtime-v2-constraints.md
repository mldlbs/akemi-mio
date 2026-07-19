# ADR-009: Runtime v2 Architecture Constraints

**Status:** Draft
**Date:** 2026-07-19
**Supersedes:** None (extends ADR-00X Architecture Freeze v1)
**Upstream Dependencies:**
- ADR-00X (Runtime Architecture Freeze) — Frozen
- ADR-005 (Reliability/Scale) — Design Review

---

## Context

P1 Stable 已建立（`p1-stable` tag）。Runtime v1 完成了核心状态的契约冻结和 Harness 验证：
6 个 Contract 已冻结，27/28 测试通过，零 illegal transition、零 worker leak。

但 Runtime v1 的能力边界是明确的：**一次性的任务执行层**。它没有持久化、没有调度、没有断点恢复。
下一个阶段（Runtime v2）需要引入 Checkpoint、Scheduler、Workflow Runtime 等能力，但这需要先在架构层面定义约束，防止三个反模式：

1. **状态所有权混淆** — Agent 自持 checkpoint 逻辑，或 Runtime 侵入 Agent 内部状态
2. **恢复语义膨胀** — 承诺"对象级完全恢复"，导致序列化框架替代架构设计
3. **能力分叉** — 新能力和 legacy 路径各自演化，产生不可收敛的双轨维护

本 ADR 不定义具体实现，只定义 Runtime v2 必须在什么边界内演进。

---

## 1. 状态所有权分层

### 原则：层间单向依赖，状态归属清晰

```
Agent
  └─ 产生状态变化（对话上下文、工具调用结果、决策记录）

Runtime
  └─ 管理生命周期（Worker 状态机、Supervisor 协调、任务级控制）

CheckpointManager
  └─ 保存/恢复状态（序列化、存储、版本迁移）

Tool Runtime
  └─ 管理工具调用状态（执行上下文、重试状态、中间结果）
```

### 1.1 Agent 不持有持久化逻辑

**允许：**
- Agent 报告自身状态（`state: RuntimeState`）
- Agent 在 SafePoint 响应 `pause`/`cancel` 等 RuntimeCommand

**禁止：**
- Agent 直接调用 CheckpointManager（`agent.saveCheckpoint()`）
- Agent 假设自己是唯一状态来源

### 1.2 CheckpointManager 不持有 Agent 引用

**允许：**
- CheckpointManager 通过 Runtime 获取序列化所需的状态快照
- CheckpointManager 在恢复时重建 RuntimeTask 并注入状态

**禁止：**
- CheckpointManager 直接操作 Agent 内部对象
- CheckpointManager 运行时保持 Agent 引用（只在保存/恢复瞬间接触）

### 1.3 Runtime 是唯一生命周期锚点

**允许：**
- RuntimeTask 持有 Checkpoint 引用（`task.checkpointRef`）
- RuntimeManager 决定何时 checkpoint（worker 完成、pause、周期）

**禁止：**
- Agent 绕过 Runtime 创建/恢复任务
- 外部代码直接读取 Worker 内部状态

### 1.4 Tool Runtime 状态所有权（未解决 — 阻塞 checkpoint contract）

当前 Tool Runtime 的状态管理职责边界未定义：

```
Tool Runtime
  └─ 管理工具调用状态
```

需要回答：谁负责保存和恢复 Tool 的中间状态（文件描述符、API polling、分页 cursor）？

**已知约束：**
- Tool 不应自行调用 CheckpointManager（违反 1.1 原则）
- CheckpointManager 不应直接操作 Tool 内部对象（违反 1.2 原则）

**必须在下阶段 checkpoint contract 定稿前解决。**

---

## 2. 恢复语义边界

### 2.1 明确支持的恢复语义

| 语义 | 说明 | 示例 |
|------|------|------|
| **task resume** | 同一 Agent 在同一上下文继续执行 | 用户说"继续刚才的任务" |
| **execution continuation** | 从最近 SafePoint 恢复工具循环 | Worker crash 后从 after_tool 继续 |
| **memory reload** | 恢复时重新加载 LTM 上下文 | 跨会话的 Agent 记忆 |
| **tool context reconstruction** | 恢复工具执行所需的临时状态 | 文件句柄、API 会话 Token |

### 2.2 明确不支持的恢复语义

| 语义 | 原因 |
|------|------|
| **进程内对象完全恢复** | 对象引用、闭包、事件监听器无法可靠序列化 |
| **任意第三方状态恢复** | Toolkit/Plugin 有权管理自身状态，Runtime 不应假设可恢复 |
| **网络连接恢复** | WebSocket/gRPC 连接状态超出 Runtime 范围 |
| **UI 渲染状态恢复** | 前端渲染状态恢复属于 Electron 层的职责 |

### 2.3 恢复契约

```
恢复保证：
  相同 taskId
  相同 logical state（执行位置、已完成步骤、pending 消息）
  新的 Runtime 实例（非原进程）

不保证：
  相同 object graph
  相同内存地址
  原进程的未 flush 日志
```

---

## 3. 兼容性策略

### 3.1 Legacy Path 约束

**当前状态：**
```
ChatExecutor
  ├─ Runtime 路径（RUNTIME_ENABLED=1）
  └─ Legacy SubAgentPool 路径（RUNTIME_ENABLED=0）
```

**v2 规则：**
- Legacy path 保持 adapter（`SubAgentPoolAdapter`）不变
- Legacy path **不新增能力** — 新功能只在 Runtime v2 路径上添加
- Legacy path 的删除依据是使用率和风险，而非时间节点
- Runtime 和 Legacy 路径的能力差距允许暂时存在，但必须收敛

### 3.2 能力收敛检查清单

每个 Runtime v2 新增功能后，检查：

- [ ] Legacy path 是否已适配该能力？（如否，确认不产生行为差异）
- [ ] 如果需要适配，adapter 是否足够？（如否，说明架构继承出现问题）
- [ ] 两条路径在该能力上是否产生不可逆的分叉？

### 3.3 生命周期策略

```
┌─────────────────────────────────────────────────┐
│  Runtime v2 Feature Development                  │
│  (checkpoint, scheduler, workflow, ...)          │
├─────────────────────────────────────────────────┤
│  Legacy Path (SubAgentPool)                      │
│  existing features only, no new additions        │
├─────────────────────────────────────────────────┤
│  Future: Legacy removal when usage → 0           │
│  (not time-driven, not migration-proj driven)    │
└─────────────────────────────────────────────────┘
```

---

## 4. Checkpoint 版本化约束

### 4.1 三层版本语义

#### 4.1.1 Schema Version（必须）

描述 checkpoint 数据结构的版本。用途：字段新增、字段删除、数据迁移。

```
格式: MAJOR.MINOR (如 "1.0", "1.1", "2.0")
规则:
  小版本 (1.x → 1.y): 向后兼容变化，可直接 restore
  大版本 (1.x → 2.0): 需要 migration 才能 restore
```

#### 4.1.2 Runtime Compatibility Version（必须）

描述哪个 Runtime 可以恢复。字段存在 ≠ 语义一致 — 同一字段名在不同版本可能含义不同。

```
checkpoint.runtimeVersionRange: { min: "2.0", max: "2.x" }
```

#### 4.1.3 Component State Version（按需）

复杂组件（Tool Runtime、Memory、Workflow）各自独立演进，不强制随整体 schema 升级。

```
checkpoint.componentVersions: { memory: "3", workflow: "1", tools: "2" }
```

### 4.2 Migration 策略约束

- Restore 前必须完成 schema compatibility check
- 不兼容版本必须显式 migration，不允许静默恢复
- 当前阶段不设计完整 migration framework；等 migration 实际出现后再引入

---

## 5. RuntimeMessage 扩展规则（适用于 v2）

v1 冻结规则（Additive Evolution）继续适用，v2 补充：

- 新 RuntimeEvent 类型可以是 Task 级事件（不绑定具体 Worker）
- 如果新事件导致 Worker 行为变化，需要新的 SafePoint 枚举值
- 禁止在 RuntimeCommand 中嵌入 Agent-specific 指令（保持命令通用性）

---

## 6. 架构边界检查（新增功能时回答）

1. **这个功能应该属于哪一层？**
   - 状态变更 → Agent
   - 生命周期 → Runtime
   - 持久化 → CheckpointManager
   - 工具执行 → Tool Runtime

2. **恢复后行为是否可预测？**
   - 从 checkpoint 恢复 → 同一输入 → 相同输出
   - 恢复后的 Agent 不应感知到自己曾被暂停/恢复

3. **是否创建了新状态种类？**
   - 如果是 → 需要加入 RuntimeState 枚举（或子状态）
   - 如果不属于 RuntimeState → 说明不是 Runtime 层的状态

4. **两条路径的能力是否收敛？**
   - 新功能只在 v2 路径添加 → 差距扩大
   - 但如果有意让 legacy 路径也获得该能力 → 检查是否通过 adapter 自然继承

---

## 6. 下一步建议

1. 基于本约束，定义 **Checkpoint Contract**（保存什么、恢复保证什么）
2. 实现 CheckpointManager + StorageAdapter
3. 实现 Restore 测试（从持久化恢复、SafePoint 续传、跨会话 resume）
4. 按需进入 Scheduler / Workflow Runtime

---

**References:**
- ADR-00X Architecture Freeze v1 — `docs/../memory/runtime-architecture-migration.md`
- RC Runtime Checklist — `docs/rc-runtime-checklist.md`
