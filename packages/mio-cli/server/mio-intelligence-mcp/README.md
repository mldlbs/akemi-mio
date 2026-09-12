# mio-intelligence-mcp

Mio Agent Enhancement Layer 的最小 MCP 实现。

第一阶段目标：让 Codex / OpenCode / WorkBuddy 通过 MCP 接入 Mio，积累真实 Agent 行为数据。

## 当前工具

- `mio.memory.query` — 查询本地项目记忆；支持 `kind` / `tags`（AND）过滤、`scope` 跨项目命名空间（`project` / `global` / `all`），并采用混合检索评分（词法命中 + 拉丁子串召回 + CJK 双字短语加权 + 新近度加分）。
- `mio.memory.record` — 记录决策、上下文或历史问题；`scope: global` 写入跨项目可复用的全局记忆（`project` 置空），默认 `scope: project`。
- `mio.memory.analyze` — 分析记忆质量：kind 分布、重复组（内容相似度 ≥ 0.75）、低质量记录（缺 kind/content 或内容过短），并返回维护建议。
- `mio.memory.archive` — 按 id 归档（或 `restore: true` 恢复）记忆记录，非破坏性：归档记录默认从 `memory.query` / `memory.analyze` 中排除，便于去重整理。
- `mio.memory.migrate` — 跨项目经验迁移（P3）：把记录在 project / global 两层之间迁移；迁到 global 后跨项目可见（`project` 置空），迁回 project 恢复项目隔离；保留 `migratedAt` / `migratedFrom` 溯源。
- `mio.observer.ingest` — 接收 Agent Trace / tool call / error / retry / outcome。
- `mio.policy.check` — 根据历史 trace 结果，为即将执行的操作返回风险建议（`riskLevel`、outcome 分布、最近失败证据 `failureExamples`）与执行指导 `guidance`：无历史=`none` / 有证据=`advisory` / 有 verified 经验=`actionable`（含安全替代方案与验证步骤），始终不设硬门禁。
- `mio.observer.subscribe` — 订阅观察事件（项目、事件类型、可选 topic 关键词），订阅有效期内可被 `mio.observer.digest` 拉取。
- `mio.observer.digest` — 拉取自上次 digest 以来匹配订阅的新事件（游标自动推进），实现 pull 式事件订阅。
- `mio.experience.reuse` — 记录 Phase 0 跨 Agent 经验复用的验证证据；每次记录后同时返回当前 Phase 0 剩余门槛。
- `mio.experience.confirm` — 确认一条 `source: auto_claim` 的复用证据为真实复用（`behaviorChanged` 置为 true 并标记 `confirmed`），使记录计入 verified reuse 门槛。
- `mio.experience.list` — 列出 Phase 0 复用证据，可按 `status`（`pending` / `confirmed` / `verified` / `auto_claim` / `agent_report` / `all`）、`targetAgent`、`project` 过滤，默认返回最近 20 条。
- `mio.phase0.report` — 生成当前 Phase 0 验证报告，返回门槛状态、复用漏斗（含 `pendingAutoClaims`，即待确认的 auto_claim 数）、Agent 覆盖（含每个 host 的健康状态）、trace outcome 分布；支持 `format: markdown` 直接返回渲染报告。
- `mio.task.route` — 把任务路由到最相关的**已验证经验**与相关记忆（P1）：对任务描述做混合检索匹配 verified 经验，返回可直接采用的模式（含 `reuseCount` 复用次数、确认状态、来源/目标 Agent 与记忆内容），把「查询响应」升级为「决策影响」；路由结果会进入查询日志，便于后续 `task_outcome` 自动关联复用证据。

- `mio.agent.register` — 注册或更新 Agent 到 Mio Agent Registry（按 agentId+project 去重）：首次调用创建记录（registered=true），后续调用更新 lastSeenAt 并递增 sessionCount。支持 hostType（mcp/observer/plugin）和 capabilities。
- `mio.agent.list` — 列出所有已注册 Agent，支持按 project 过滤。返回每个 Agent 的 id、agentId、hostType、capabilities、注册/最近活跃时间、会话数。

- `mio.evolution.report` — 生成跨 Agent 演化报告（ADR-017 Evolution 平面）：生态系统摘要（agent/task/memory/reuse 总量）、Agent 性能对比（成功率/memory 数/verified reuse）、跨 Agent 复用模式、Memory 健康度（质量评分/低质量记录/缺失字段）、优化建议（路由/证据确认/记忆质量/覆盖度，按优先级排序）。支持 `period`（24h/7d/30d/all）和 `project` 过滤。- `mio.agent.report` — 生成 Agent 性能报告：聚合 task_outcome（成功率）、memory 数量、experience reuse（总次数/verified 数量）和活跃状态。支持指定 agentId 或 project 过滤。

- `mio.evolution.status` — 通过 `mio-agent-runtime` 的 canonical runtime module registry 返回独立模块加载与健康状态，和 CLI `mio evolution status` 同源。
- `mio.host.capabilities` — 返回 Codex / OpenCode / WorkBuddy / Hermes adapter plugin 的只读安装状态和能力边界。runtime 模块只能通过这些 host capability 执行宿主相关动作，不直接修改桌面宿主状态。
- `mio.evolution.shadow.record` — 记录 legacy / modular 路径输出的 shadow comparison 样本，写入 `evolution_shadow.jsonl`，不改变当前权威路径。
- `mio.evolution.dual_write.record` — 记录 legacy / modular 双写结果样本，写入 `evolution_dual_write.jsonl`，用于后续切换前的分歧分析。
- `mio.evolution.cutover.readiness` — 基于 shadow / dual-write 样本评估是否可考虑切换；只返回 `pass` / `hold` / `fail` 和原因，不执行切流。
- `mio.evolution.migration.plan` — 预览 legacy / modular 状态记录的迁移差异，返回待创建、额外记录和冲突列表，不写入状态。
- `mio.evolution.authority.plan` — 基于 readiness 结果生成权威路径切换计划；只有 readiness 为 `pass` 时才给出 `set_authority` / fallback / monitor 动作，仍不执行切换。
- `mio.evolution.cutover.apply` — 仅 dry-run 预演 authority plan；必须传 `dryRun: true`，返回计划动作但固定 `applied: false`，不修改权威路径。

- `mio.task.record_outcome` — 一键记录任务结果：原子写入 traces.jsonl + 更新 Agent Registry（taskCount/successCount/failureCount）+ 自动关联 experience reuse auto-claim。替代手动调用 observer.ingest + agent.register 的分离流程，完成任务生命周期闭环。## 项目识别

不传 `project` 时，服务会通过当前 Git 仓库自动识别项目名：

1. 读取 `git rev-parse --path-format=absolute --git-common-dir`
2. 取其父目录名作为项目名
3. 非 Git 目录回退到当前目录名

因此同一个仓库无论在主工作区还是 worktree 中，都会得到一致的项目名。

## 跨项目命名空间与混合检索（P0）

`memory.query` 支持 `scope`：

- `project`（默认）：只搜当前项目记忆，全局记忆不可见。
- `global`：只搜 `scope: 'global'` 的全局记忆。
- `all`：当前项目记忆 + 全局记忆（其他项目仍不可见）。

`memory.record` 支持 `scope: 'global'` 写入跨项目经验（如「如何在本机配置 MCP」）；全局记录 `project` 置空，防止项目上下文泄露。

混合检索评分（无需外部模型）：

1. 词法命中：查询词与记录内容的精确匹配（中文按单字）。
2. 拉丁子串召回：`retriev` 可召回含 `retrieval` 的记录。
3. CJK 双字短语加权：含 `部署环境` 连续短语的记录排名更高。
4. 新近度加分：仅对已有内容匹配的记录生效，不放大零匹配记录。

向量/语义嵌入（真正按「含义」召回）留作后续阶段（P0.5），评分接口已预留扩展位。

## 证据加权排名（P2）

`memory.query` / `policy.check` / `task.route` 的检索排序会叠加「证据权重」：

- 来源：`experience_reuse.jsonl` 中满足 verified（reuse + behaviorChanged + outcomeImproved）的记录。
- 加分：`min(2, reuseCount * 0.6 + (confirmedCount > 0 ? 1 : 0))`——被成功复用过的记忆排名更高，确认过的额外 +1，封顶 2 分，保证内容相关度仍是主导。
- 边界：证据加分只作用于「已内容匹配」的记录，不会让零匹配记录被召回（与新近度加分同一原则）。
- 可见性：`memory.query` 命中带证据的记忆时，结果带 `evidence: { reuseCount, confirmedCount, lastReusedAt }`；`policy.check` 的 `related_memories` 同样带 `evidence`。

task_outcome 通过 auto-claim → confirm 沉淀为 verified 复用记录，从而进入该权重——即「任务结果反哺检索排序」的自改进闭环。

## 跨项目经验迁移与分层记忆（P3）

记忆分两层：项目级（默认，`project` 隔离）与全局级（`scope: global`，跨项目可见）。

- `mio.memory.migrate` — 把记忆在两层间迁移（`ids` + `scope: global|project`）。迁到全局后 `project` 置空、可被任意项目召回；迁回项目恢复隔离；保留 `migratedAt` / `migratedFrom` 溯源。
- `memory.query` 响应带 `layers: { project, global }` 计数；`scope: all` 下全局记录有 +0.5 可见性加分，防止跨项目经验被项目记录挤掉（内容相关度仍主导排序）。
- `memory.analyze` 现在同时分析项目与全局记录，并报告 `layers` 分层计数。
- 边界：迁移是显式操作，避免项目上下文意外泄露到全局层。

## Policy 执行指导（P4）

`policy.check` 在风险建议之上增加 `guidance`，把「警告」升级为「可执行指导」：

- `level`：`none`（无历史）→ `advisory`（有证据但未验证）→ `actionable`（存在 verified 经验，直接给出可采用的方案）。
- `saferAlternatives`：来自带证据的 related_memories（verified 复用经验），给出 `memoryId` / `reuseCount` / 内容摘要。
- `verificationSteps`：执行后的验证步骤与 outcome 记录建议。
- `avoid`：重复失败场景下的失败模式摘要（取自 `failureExamples`）。
- `hardGate`：恒为 `false`——P4 只做指导，不设硬门禁（确凿证据继续积累后再考虑）。

task_outcome 数据经 auto-claim → confirm 后会自动升级后续同类动作的指导级别。

## 全局 Codex 配置

`C:\Users\gf191\.codex\config.toml` 中配置：

```toml
[mcp_servers.mio-intelligence]
command = 'C:\nvm4w\nodejs\node.exe'
args = ['/absolute/path/to/mio-agent-runtime/server/mio-intelligence-mcp/index.js']
startup_timeout_sec = 30

[mcp_servers.mio-intelligence.env]
MIO_DATA_DIR = 'C:\Users\gf191\.mio-intelligence'
MIO_CONTEXT = '{"agentId":"codex","project":"akemi-mio","workspace":"D:/work/code/akemi-mio","sessionId":"codex-session"}'
```

这样所有 Codex 工作区都能调用 Mio 工具，数据统一存储在全局目录，并通过 `project` 字段隔离。

## 统一调用方身份

每个 Agent 启动 Mio MCP 时通过 `MIO_CONTEXT` 提供身份：

```json
{
  "agentId": "codex",
  "project": "akemi-mio",
  "workspace": "D:/work/code/akemi-mio",
  "sessionId": "codex-session"
}
```

Mio 会把 `agentId` 注入记忆来源和观察事件，把 `project` 作为默认项目名。这样 Codex、OpenCode、WorkBuddy 连接同一个 Mio 服务时，经验来源可区分。

OpenCode / WorkBuddy 的 MCP 配置只需保持同样语义：

```json
{
  "mcpServers": {
    "mio": {
      "command": "node",
      "args": [
        "/absolute/path/to/mio-agent-runtime/server/mio-intelligence-mcp/index.js"
      ],
      "env": {
        "MIO_DATA_DIR": "C:/Users/gf191/.mio-intelligence",
        "MIO_CONTEXT": "{\"agentId\":\"opencode\",\"project\":\"akemi-mio\",\"workspace\":\"D:/work/code/akemi-mio\",\"sessionId\":\"opencode-session\"}"
      }
    }
  }
}
```

## 自动使用规则

全局规则位于 `C:\Users\gf191\.codex\AGENTS.md`。Codex 会在每个工作区执行：

- 规划前查询 `mio.memory.query`
- 关键决策后写入 `mio.memory.record`
- 报错或重试时上报 `mio.observer.ingest`
- 每个任务结束前上报 `mio.observer.ingest`，`event_type` 为 `task_outcome`，并填写 `outcome` 和非敏感 `payload`
- 高风险操作前检查 `mio.policy.check`

## 复用证据自动关联

服务端会把最近 200 次返回非空结果的 `mio.memory.query` 持久化到 `queries.jsonl`（含 `expiresAt`，过期项自动清理），因此匹配可以跨进程、跨重启生效。当同一 `agent + project` 在匹配窗口内（默认 60 分钟，可用环境变量 `MIO_REUSE_MATCH_WINDOW_MIN` 覆盖）上报 `task_outcome` 时，自动生成一条 `source: auto_claim` 的复用证据：

- `sourceAgent` 优先取被召回记忆中与执行 Agent 不同的来源（跨 Agent 证据），否则为执行 Agent 自身。
- `behaviorChanged` 初始为 `false`；`outcomeImproved` 取决于 outcome 是否为 `success`。
- 自动证据只计入 `autoClaimedReuse` / `claimedReuse`，**默认不满足** verified reuse 门槛。
- Agent 确认真实发生复用后，调用 `mio.experience.confirm`（参数为 auto-claim 记录的 `id`），把 `behaviorChanged` 置为 true 并标记 `confirmed: true` / `confirmedBy`；若 `outcomeImproved` 同时为 true，该记录计入 `confirmedReuse` 与 verified reuse 门槛。
- 也可以直接调用 `mio.experience.reuse`（三个布尔位为真）记录 `agent_report` 证据。

## Host 健康状态

`mio.phase0.report` 的 `agentCoverage` 对每个 host 返回：

- `memoryRecords` / `traceEvents` / `taskOutcomes` / `verifiedReuseAsTarget` — 该 host 的贡献计数。
- `lastActiveAt` / `lastActiveHoursAgo` — 最近一条证据的时间。
- `active` — 7 天内（`HOST_ACTIVE_WINDOW_MS`）是否有活动。
- `dataSources` — 该 host 出现在哪些证据文件（`memory` / `trace` / `reuse`）。

同时返回 `activeHostCount`，用于判断 “≥2 hosts” 门槛当前是否真的有多个活跃 Agent，避免“注册过但已停用”的假阳性。

## 数据文件

- `memory.jsonl` — 记忆记录。
- `traces.jsonl` — Agent Trace 事件。
- `experience_reuse.jsonl` — Phase 0 有效复用证据。
- `queries.jsonl` — 最近 `memory.query` 的持久化记录，用于自动关联复用证据。
- `evolution_shadow.jsonl` — 阶段 8 shadow comparison 样本。
- `evolution_dual_write.jsonl` — 阶段 8 dual-write 结果样本。

均为本地 JSONL，不依赖数据库。后续可以从这里逐步替换为 Mio 现有 SQLite / MemoryService。
