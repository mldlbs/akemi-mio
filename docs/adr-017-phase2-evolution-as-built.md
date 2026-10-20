# ADR-017 Phase 2: Evolution Plane — As-Built Reconciliation

> 对账日期：2026-10-20。背景：ADR-017 工具表把 `mio.evolution.report` 标为
> "Planned / Phase 2"，并在 Next Steps 把"是否进入 Evolution 自动建议阶段"当成
> 待决的未来决策。代码与测试表明，整个 Evolution 平面（8 个工具）**已实现并随
> MCP 上线**。本文是对账，不是新设计。

## 1. ADR 声明 vs 代码现状

| ADR 说法 | 代码现状 | 证据 |
|---|---|---|
| `mio.evolution.report` = Planned / Phase 2 | **已实现 + 测试** | `server/evolution-report.js` 完整实现；MCP `mio.evolution.report` 已注册分派（`index.js:592/1238`）；CLI `mio evolution report` 共用同一实现（`bin/mio.js:146`）；`evolution-report.test.js` 7/7 通过 |
| Evolution 平面是"评估期后再决定"的未来工作 | **8 个 Evolution 工具全部已在 MCP 注册** | `index.js` 注册：`report`(:592) / `status`(:604) / `shadow.record`(:620) / `dual_write.record`(:635) / `cutover.readiness`(:651) / `migration.plan`(:663) / `authority.plan`(:674) / `cutover.apply`(:687) |

## 2. 工具契约（evolution.report）

`createEvolutionReport({ dataDir, projectName }).report({ project, period })`：

- `period ∈ {24h, 7d, 30d, all}`，默认 `all`；非已知值回退 `all`。
- 读取 4 个既有 jsonl（均按 `project` 过滤）：`memory.jsonl` / `traces.jsonl` /
  `experience_reuse.jsonl` / `agents.jsonl`。
- 输出结构：
  - `ecosystem`：活跃 agent 数、`task_outcome` 成功/失败计数、已验证复用、待确认复用。
  - `agents`：每 agent 的表现汇总。
  - `crossAgentPatterns`：跨 agent 复用/行为模式。
  - `memoryHealth`：记忆健康度。
  - `suggestions`：路由/优化建议，按 `high/medium/low` 优先级排序
    （`high` 映射为 0，排序用 `hasOwnProperty` 防止 falsy 误排）。
- MCP 与 CLI 共用同一实现（`bin/mio.js:146` 注释明确"so the two cannot drift"），保证两数一致。

其余 7 个工具由 `server/evolution-cutover.js`（`createEvolutionCutoverTools`）支撑：
`status` 由 `runtime-modules.js` 的 `getEvolutionStatus` 提供，CLI 同样共用。

## 3. 数据模型

Evolution 平面**不引入新的持久化工件**——全部基于既有 jsonl 只读聚合。
注：当前 `evolution.report` **尚未消费**本次新增的 `route_events.jsonl`
（见 `adr-017-phase2-identity-registry-as-built.md` §6），可作为后续增强，让
采纳数据进入生态汇总。

## 4. 真实缺口 / 后续

- ✅ **建议已自动闭环（2026-10-20）**：原缺口"建议自动回写并驱动 `task.route`"已由
  `adr-017-phase2-evolution-autosuggest.md` 设计并经 PR2/PR3/PR4 实现：
  - PR2 `server/evolution-suggestions.js` + MCP 工具 `mio.evolution.suggestion.list` /
    `.apply`：把高置信路由建议纳入带人审授权门禁（`approvedBy` 必填、永不自动应用）
    的状态机（`proposed→shadowing→dual_writing→ready→authorized→applied`），`apply`
    落盘 `routing_preferences.jsonl`（30 天有效期）。
  - PR3 `server/task-store.js#routeTask`：消费 `routing_preferences.jsonl`，对
    `sourceAgents`/`targetAgents` 命中 `preferAgent` 的路由做**有界权重提升**（+3，
    只重排序、不强制切换 agent、不凭空造路由）。
  - PR4 `evolution-autosuggest-e2e.test.js`：端到端验证
    `report → propose → 授权 apply → task.route 命中提升` 全链路。
  测试 `evolution.report generates routing suggestion when agents differ` 仍绿；
  `task-route-preferences.test.js`（4/4）、`evolution-autosuggest-e2e.test.js`（1/1）覆盖闭环。
- 增强（仍待做）：`evolution.report` 纳入 `route_events.jsonl` 的采纳率数据，提升建议依据。

## 5. 测试

`packages/mio-cli/server/mio-intelligence-mcp/__tests__/evolution-report.test.js`
（7 用例，全绿，运行需 EBUSY shim `node --require <shim> --test`）：

- `evolution.report returns ecosystem summary`
- `evolution.report includes agent performance`
- `evolution.report detects cross-agent patterns`
- `evolution.report includes memory health`
- `evolution.report generates routing suggestion when agents differ`
- `evolution.report returns empty state gracefully`
- `evolution.report respects period filter`
