# 团队/组织共享记忆 + 治理看板（首个付费层设计草案）

> TaskHub: `414f6369` · 阶段：brainstorming → 设计草案（**未实现**，待评审）
> 关联：ADR-017 Memory 平面、Identity/Registry 平面（多 Agent 注册）；TaskHub `9ec502e6`（治理/审计面板，单体版）；`07e7ed52`（工程卫生，治理看板的可复现性前提）

## 0. 目标与动机

单体版 Mio 的记忆与治理是**按 agent / 按 project** 隔离的（每个 `MIO_HOME` 一份）。但团队场景需要：(a) 一个组织内**多个 agent、多个项目共享同一份记忆**（避免"同一个坑每个 agent 各踩一遍"）；(b) 一个**跨 agent/项目的治理看板**，让负责人一眼看到组织级策略健康度与审计轨迹。这是最自然的**首个付费层**：单体免费，组织能力付费。

## 1. 现状（as-built，已核实）

- **Memory 平面**：`createMemoryStore({ dataDir, project })`，按 project 隔离；`scoreRecord` 在 `memory.project !== project` 时返回 0（跨项目不共享）。
- **Identity/Registry**：`mio.agent.register / list / report` 已支持多 agent（codex/opencode/workbuddy/claude）在同一 `MIO_HOME` 共存（`df0029af` 已实现）。
- **治理/审计**：`mio agents evaluation`（四指标）、`mio policy check`、`mio phase0 report` 已存在；`9ec502e6` 草案提出聚合 `governance report` + `governance_audit.jsonl`。
- **结论**：多 agent 已能共存，但记忆仍按 project 孤岛；治理视图是单 `MIO_HOME` 视角，无组织聚合。

## 2. 设计

### 2.1 组织级共享记忆命名空间

在现有 memory store 之上增加 **org scope**：

- `createMemoryStore({ dataDir, org, project })`：`org` 为空时退化为现状（per-project）；`org` 非空时，记忆写入 `org/<orgId>/` 命名空间，同一 org 下的不同 project/agent **可读写同一份**（带 `project`/`agentId` 标签以便溯源，但不隔离读写）。
- 访问模型：组织管理员可授权哪些 agentId/project 属于该 org（复用 Identity/Registry 的 agent 登记）。
- 隔离保证：不同 org 之间**物理分目录**，杜绝跨组织泄露；单 org 内的"共享"是产品特性而非漏洞。

### 2.2 组织治理看板

复用 `9ec502e6` 的 `governance report`，扩展为**跨 agent/项目聚合**：

```
mio governance report --org <orgId> [--json]
```

聚合维度：org 内所有 agent 的 evaluation 四指标均值、所有 `policy check` 审计汇总、各 project 的 phase0 闸门、Evolution 建议分布。输出可导出为静态面板（`9ec502e6` 的 `export`）。

### 2.3 付费层界定（草案）

| 层 | 范围 | 包含 |
|---|---|---|
| Free | 单体 | 单 agent/project 的记忆、路由、策略、演化；本地治理视图 |
| Team（首个付费层） | 组织 | org 共享记忆、跨 agent 治理看板、审计日志留存、多项目聚合 |
| （未来）Enterprise | 组织+ | SSO、合规导出、自托管、角色细粒度权限 |

> 定价数字不在本草案范围；此处只界定"什么能力属于哪层"，供后续商业设计填数。

## 3. 安全与兼容

- org 间物理分目录，跨 org 零共享；单 org 共享是显式授权结果。
- 现有 per-project 行为**完全不变**（org 缺省时退化），不回归 Free 层。
- 审计日志 append-only，组织管理员可只读回放，不篡改历史。
- 治理看板只读聚合，不写业务数据。

## 4. 验收标准

- `createMemoryStore` 带 `org` 时，同 org 不同 project 的 agent 能互相读取记忆；无 `org` 时退化为现状（既有测试仍绿）。
- 不同 org 目录之间无任何共享文件/记录。
- `mio governance report --org <id>` 跨 agent/project 聚合四指标 + 审计汇总，且 `--json` 可机读。
- Free 层体验与引入 org 前完全一致。

## 5. 范围外 / 需协调

- 实现会改 `memory-store.js`（加 org scope）与 `bin/mio.js`（治理看板聚合）。`memory-store.js` 与 `index.js` 当前可能受**并发会话**改动影响；落地须排查并排期，避免冲突。
- 付费/计量（licensing、配额、SSO）属商业层，本草案只做能力边界界定，不含计费实现。
- 本轮仅交付设计草案，不写实现代码。

## 6. 建议拆分

- **PR-A**：`memory-store` org scope（分目录 + 共享读写 + 隔离保证）+ 单测。
- **PR-B**：org 授权模型（复用 agent 登记，定义谁属于哪个 org）。
- **PR-C**：`governance report --org` 跨 agent/project 聚合 + 导出。
- **PR-D**：Free/Team 能力边界的 CLI 提示与文档（不含计费）。
