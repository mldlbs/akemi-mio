# ADR-017 Phase 2: Evolution 建议回写路由 — 设计规格

> 起草日期：2026-10-20。背景：见 `adr-017-phase2-evolution-as-built.md` §4 —— `mio.evolution.report`
> 已能生成 `suggestions`，但建议是**纯文本诊断**，无结构化 `target`、也无任何回写路径。
> 这是 Evolution 平面唯一剩余的「真 Phase 2」工作。本文是**设计规格**，落地前需评审确认。

## 0. 缺口定义

`evolution-report.js` 的 `suggestions` 引擎产 5 类建议：

| category | 当前形态 | 本期是否回写 |
|---|---|---|
| `routing` | 文本 "X 成功率 N% vs Y M%，建议优先路由到 X" | ✅ 是（本规格核心） |
| `evidence` | "N pending auto-claims 待确认" | ❌ 仅结构化，不回写 |
| `memory` | "Memory quality N%" | ❌ 仅结构化，不回写 |
| `interop` | "多 agent 但无跨 agent 复用" | ❌ 仅结构化，不回写 |
| `coverage` | "X 7 天未活跃" | ❌ 仅结构化，不回写 |

目标：把高置信度的 `routing` 建议**经门控管道**回写进 `task.route` 的排序，让控制面能
自我优化路由，而非只出报告。

## 1. 设计原则

1. **绝不裸自动应用**：复用 Evolution 平面已有的 gated-rollout 工具链
   （`shadow.record` / `dual_write.record` / `cutover.readiness` / `authority.plan` /
   `cutover.apply`，均在 `server/evolution-cutover.js`）。回路：
   `建议 → 影子 → 双写 → 就绪门控 → 人工授权 → 应用`。
2. **只偏排序，不改语义**：回写只调整 `task.route` 的权重/提示，绝不删除/改写记忆，
   也绝不强制切换执行 agent。
3. **可观测、可回滚**：每条建议有生命周期状态与审计轨迹；cutover 可随时回退。
4. **样本门槛继承**：沿用现有 `best.tasks.total >= 5 && successRate 差 >= 15` 的保守阈值
   （`evolution-report.js:160`），避免小样本误判。

## 2. 现状资产（避免重复造轮子）

- `server/evolution-report.js`：`report()` 生成 5 类 suggestions；`routing` 建议已含
  `best.agentId` / `worst.agentId` / 成功率差（line 157-168）。
- `server/evolution-cutover.js`：`createEvolutionCutoverTools` 提供 shadow/dual-write/
  readiness/authority/apply 全套门控 rollout。
- `server/task-store.js#routeTask`：返回 `routes`（每条含 `sourceAgents`/`targetAgents`），
  权重由 `scoreRecord + (confirmed ? 2 : 1.5)` 决定（line 160）。**回写点即此权重**。
- `route_events.jsonl`（70716301 新增）：门控各阶段写入同类审计轨迹。

## 3. 设计

### 3.1 结构化建议（改 `evolution-report.js`）

`routing` 建议从纯文本升级为结构化对象（其余 4 类本期仅补 `target` 字段、不回写）：

```js
{
  category: 'routing',
  priority: 'high',
  preferAgent: best.agentId,
  baselineAgent: worst.agentId,
  successRateDelta: best.tasks.successRate - worst.tasks.successRate,
  minSamplePerAgent: 5,            // 继承现有门槛
  evidence: { best: best.tasks, worst: worst.tasks, basis: 'task_outcome comparison' },
  description: '...'               // 保留人类可读文本
}
```

### 3.2 建议生命周期存储（新增 `server/evolution-suggestions.js`）

`createEvolutionSuggestionStore`，持久化到 `evolution_suggestions.jsonl`：

- 字段：`id, category, priority, target{preferAgent,baselineAgent,...}, status, createdAt,
  appliedAt, expiresAt, shadowRunCount, mismatchRate, authorityApprovedBy`。
- 状态机：`proposed → shadowing → dual_writing → ready → authorized → applied`，
  可流转 `rejected / expired`。
- 进入 `proposed` 的门槛：仅 `category==='routing'` 且 `priority==='high'` 且
  `minSamplePerAgent` 满足。
- 新增 MCP 工具：`mio.evolution.suggestion.list` / `mio.evolution.suggestion.apply`
  （`apply` 内部走 cutover 门控，不裸生效）。

### 3.3 门控回写回路（复用 cutover 工具）

1. `proposed` 的 routing 建议 → `evolution.shadow.record`：对同一批 query 分别记录
   「现状路由」与「加偏路由」的命中/成功率，**不生效**。
2. 影子运行 ≥ `minShadowRuns`（建议 20）→ `evolution.cutover.readiness`：
   `mismatchRate ≤ 阈值`（建议 10%）才放行。
3. 进入 `dual_write`：后续 query 同时产出两种结果，比较长期指标。
4. 就绪后 `evolution.authority.plan` 生成**人工授权**方案（必须人工确认，不自动切权）。
5. `evolution.cutover.apply --dry-run` 验证 → 人工授权后 `applied`：将 `preferAgent`
   写入**路由偏好表** `routing_preferences.jsonl`（按 `project + task 类型` 键），
   `task.route` 消费它。

### 3.4 `task.route` 消费回写（改 `task-store.js#routeTask`）

- 读 `routing_preferences.jsonl`，对命中的 route 在 `weight` 计算处加偏好加成
  （例如 `+1.0` 当 route 的 `targetAgent`/`sourceAgent` 含 `preferAgent`）。
- 仅 `status==='applied'` 的偏好生效；`shadowing/dual_writing` 只记录、不生效。
- 回写**仅调权重**，不改 `scoreRecord` 语义，不改变返回结构（向后兼容）；
  仅在 `routes` 上附加 `routingHint: { preferredAgent, reason }` 便于调试。

## 4. 安全与护栏

- 禁止裸自动应用；任何生效都必须经过 cutover 授权门控。
- routing 回写只偏排序，不删除/改写记忆，不强制切换执行 agent。
- `routing_preferences` 设 `expiresAt`（建议 30d），到期需重新评估，避免陈旧偏好。
- 门控各阶段写入与 `route_events.jsonl` 同源的审计轨迹（与 70716301 一致）。

## 5. 验收标准

- `evolution.report` 的 routing 建议为结构化对象（含 `preferAgent`/`baselineAgent`/`evidence`）。
- 存在完整回路 `建议 → 影子 → 双写 → 就绪 → 授权 → 应用`，且每步可经现有 cutover 工具触发。
- `task.route` 在 `applied` 偏好下，对同分布 query 的命中/成功率相较基线有**可观测**提升
  （影子阶段即能量化，不靠人工判断）。
- 任意阶段可回滚；偏好有过期机制。
- 新增/修改均有测试（`evolution-report`、`evolution-suggestions`、`routeTask` 消费）。

## 6. 范围之外（本期不做）

- `evidence`/`memory`/`interop`/`coverage` 四类建议的回写（仅结构化，不回写）。
- 跨 project 的全局偏好合并。
- 真正「自动切换执行 agent」的调度能力（超出路由排序范畴）。

## 7. 实施切分（建议提交顺序）

1. **PR1**：`evolution-report.js` routing 建议结构化 + 测试。
2. **PR2**：`evolution-suggestions.js`（store + 状态机）+ MCP 工具 `suggestion.list`/`apply`。
3. **PR3**：`task-store.js#routeTask` 消费 `routing_preferences` + 测试。
4. **PR4**：端到端测试（建议 → 影子 → 应用 → `task.route` 命中提升）+ 文档
   （ADR-017 补 Evolution 闭环说明；`adr-017-phase2-evolution-as-built.md` §4 标 RESOLVED）。
