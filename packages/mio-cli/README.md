# mio-agent-runtime

Mio Agent Runtime 的可发布 CLI 包。

安装一次，所有 Agent 自动接入 Mio。

## Install

```bash
npm install -g mio-agent-runtime
```

> 新机器 / 升级：请安装 `>=0.5.22`（5 host 被动观察 + trace 查询 + digest 价值管线）。
> 旧版本只有主动 MCP 规则注入，没有「无感存/取」。安装后执行一次
> `mio init && mio install <host>`。

## Commands

```text
mio init                    Initialize MIO_HOME
mio mcp                     Start Mio MCP server (stdio)
mio install <host>          Install Mio into a host (codex|opencode|workbuddy|hermes|claude)
mio status                  Show runtime and adapter status
mio agents                  List installed agents
mio evolution status        Show composed evolution module health
mio evolution shadow record      Record a shadow comparison sample
mio evolution dual-write record  Record a dual-write comparison sample
mio evolution cutover readiness   Assess shadow/dual-write cutover readiness
mio evolution authority plan      Preview a gated authority switch plan
mio evolution migration plan      Preview state migration diffs
mio evolution cutover apply --dry-run   Dry-run a cutover plan without switching authority
mio observe                 Watch WorkBuddy transcripts and auto-ingest task outcomes (foreground)
mio observe --start|--stop|--status|--once   Manage the background observer daemon
mio recall "<query>"        Search Mio memory from the terminal (--project/--scope/--kind/--tags/--limit)
mio traces                  Show recent observer traces (--type/--outcome/--agent/--since/--limit/--compact)
mio prune --days 30         Trim old traces/queries/reuse records and observe.log (--dry-run to preview; --memory needs --yes)
mio digest --days 7         Aggregate traces/memory/reuse into an actionable report (--write-back feeds agent context files; --json)
mio remember "<content>"    Write a memory record from the terminal (--kind/--tags/--scope/--project)
mio --json status           Machine-readable status
mio --json agents           Machine-readable agents
mio --json evolution status Machine-readable evolution module health
```

## MCP Tools

MCP server exposes 46 tools across 5 domains:

### Memory (9)
`mio.memory.query` · `mio.memory.record` · `mio.memory.archive` · `mio.memory.migrate` · `mio.memory.analyze` · `mio.experience.list` · `mio.experience.confirm` · `mio.experience.reuse` · `mio.policy.check`

### Observer Pipeline (14)
`mio.observer.world_model` · `mio.observer.trends` · `mio.observer.research` · `mio.observer.insights` · `mio.observer.status` · `mio.observer.collect` · `mio.observer.ferment` · `mio.observer.essays` · `mio.observer.dag` · `mio.observer.ingest` · `mio.observer.subscribe` · `mio.observer.digest`
`mio.trace.query` — query the trace log (task outcomes, tool errors) by type/outcome/agent/project/time window; also available as `mio traces` on the CLI
`mio.digest.generate` — aggregate recent data into an actionable digest (agent success rates, project activity, error hotspots, reuse evidence, suggestions); also available as `mio digest` on the CLI

### Insight Self-Observation (4)
`mio.insight.status` · `mio.insight.list` · `mio.insight.mark_reported` · `mio.insight.generate`

### Creativity Engine (4)
`mio.creativity.generate` · `mio.creativity.ferment` · `mio.creativity.list` · `mio.creativity.status`

### Task, Agent & Evolution (15)
`mio.task.route` · `mio.task.record_outcome` · `mio.agent.register` · `mio.agent.list` · `mio.agent.report` · `mio.host.capabilities` · `mio.evolution.status` · `mio.evolution.report` · `mio.evolution.shadow.record` · `mio.evolution.dual_write.record` · `mio.evolution.cutover.readiness` · `mio.evolution.cutover.apply` · `mio.evolution.migration.plan` · `mio.evolution.authority.plan` · `mio.phase0.report`

## Packages

Published to npm under `@akemi-mio` scope:

| Package | Description |
|---|---|
| `@akemi-mio/core` | Electron lifecycle, config, logging, EventBus, patterns, schemas |
| `@akemi-mio/cli` | CLI helpers |
| `@akemi-mio/runtime-contracts` | Shared type definitions |
| `@akemi-mio/runtime-foundation` | Logging, EventBus, memory schemas |
| `@akemi-mio/experience-memory` | Experience recording and retrieval |
| `@akemi-mio/evolution-learning` | Evolution learning engine |
| `@akemi-mio/evolution-strategy` | Evolution strategy engine |
| `@akemi-mio/evolution-safety` | Safety guardrails |
| `@akemi-mio/evolution-scheduler` | Evolution scheduler |
| `@akemi-mio/analysis` | ModuleScanner — static analysis of package source trees (zero deps) |
| `@akemi-mio/messaging` | ExternalMessageGateway — inbound message routing + notification dispatch via injected renderer/outbox (zero deps; telegram adapters stay host-side) |
| `@akemi-mio/reasoning` | Reasoning planner — pure-function scoring for reasoning directives (injectable logger) |
| `@akemi-mio/resource-control` | Resource budgets, background task runner, budget rebalancing (injectable runtime) |
| `@akemi-mio/agent-persona` | Persona drift control, content classification, user behavior analysis (injectable logger) |
| `@akemi-mio/creativity` | CreativityService — LLM-powered concept generation, conflict detection, merging, fermentation (TypeScript, depends on `@akemi-mio/core`) |
| `@akemi-mio/observer` | ObserverService — multi-source data collection, trend analysis, deep research, world model, fermentation, DAG state machine, self-evolution engine (zero npm deps) |
| `@akemi-mio/insight` | InsightService — LLM-based insight generation, conflict/drift/repetition/stalled-goal/friction detectors, presence service, insight scoring (zero npm deps) |
| `mio-agent-runtime` | This package — CLI + MCP server |

## Host notes

- OpenCode uses `~/.config/opencode/opencode.json` for MCP registration and
  `~/.config/opencode/AGENTS.md` for global instructions. `mio install opencode`
  writes both files and injects Mio usage rules into `AGENTS.md` so OpenCode
  calls Mio memory/observer/policy automatically. If OpenCode is already
  running, restart it once so it reloads both files. `mio observe` also
  passively tails the OpenCode session database (`opencode db`) without
  requiring the model to call Mio tools.
- Hermes uses `hermes mcp add mio-intelligence --command node --args <server>`
  to register the Mio MCP server. Hermes has native memory and reads
  AGENTS.md Context Files, so retrieval works without Mio rule injection.
- Claude Code: `mio install claude` registers the Mio MCP server at user
  scope in `~/.claude.json` (`mcpServers`) — no interactive approval needed,
  unlike project-scope `.mcp.json` — and injects Mio usage rules into
  `~/.claude/CLAUDE.md` (auto-loaded user memory) plus `<workspace>/CLAUDE.md`
  (project memory). Restart running Claude Code sessions to reload both.
  `mio observe` passively tails `<config-dir>/projects/<munged-cwd>/*.jsonl`
  session transcripts: sidechain (subagent) lines are skipped, each user
  prompt closes the previous turn, `tool_result.is_error` lines are recorded
  as error traces, and successful turn summaries are written back into the
  workspace `CLAUDE.md` MIO_CONTEXT block so the next session retrieves them
  passively. Set `CLAUDE_CONFIG_DIR` to override the config dir.
- WorkBuddy uses `~/.workbuddy/mcp.json` and requires each custom MCP server to
  be approved in `~/.workbuddy/mcp-approvals.json`. `mio install workbuddy`
  writes both files and injects Mio usage rules into
  `~/.workbuddy/CODEBUDDY.md` (user-level memory rules, auto-loaded by
  WorkBuddy into every session; the CLI hardcodes the CodeBuddy product name, so the file is CODEBUDDY.md not WORKBUDDY.md) plus `<workspace>/AGENTS.md` (project-level).
  If WorkBuddy is already running, restart it once so it reloads the approval
  and memory rule files.

## Passive observer (`mio observe`)

WorkBuddy 的默认模型不一定会主动调用 Mio MCP 工具，即使规则已注入
(`CODEBUDDY.md` / `AGENTS.md`)。`mio observe` 是一个不依赖模型自觉的
兜底：它持续监听 `~/.workbuddy/projects/**/*.jsonl` 会话记录，把每个任务的
结果（`task_outcome`）、工具调用错误（`error`）以及完成任务的摘要自动写入
`MIO_HOME/traces.jsonl` 和 `MIO_HOME/memory.jsonl`（与 MCP 服务同一套
schema，`source=workbuddy-observer`）。

- `mio install <host>` 会自动执行一次回填并启动后台观察器。

- 除了写入 `MIO_HOME`，观察器还会把任务摘要**写回 WorkBuddy 自己的记忆文件**
  (`<workspace>/.workbuddy/memory/YYYY-MM-DD.md`，标为 `## Mio 自动摘要`)。
  WorkBuddy 的系统提示要求模型每次会话维护并阅读这些文件，所以下一次会话
  WorkBuddy 会**被动取到** Mio 记录的内容——单 Agent 的「存 + 取」闭环不依赖
  模型调用 Mio 工具。
- 已处理的文件偏移记录在 `MIO_HOME/observe-state.json`，不会重复写入。
- 只回填最近 24h 内更新的会话，避免把历史记录灌入记忆库。

OpenCode 会话不依赖模型自觉：`mio observe` 通过 `opencode db` 增量读取
`~/.local/share/opencode/opencode.db`（Windows 下该文件被 OpenCode 独占锁定，
必须经 opencode 自带 CLI 读取），按 `part` 表的 rowid 做增量游标，只传输
`text`/`tool` 两种 part，把每个用户回合的 `task_outcome` 与工具错误写入
`MIO_HOME/traces.jsonl` / `memory.jsonl`（`source=opencode-observer`），并同样
把摘要写回 `<workspace>/AGENTS.md` 的 `MIO_CONTEXT` 块，供 OpenCode 下一会话
被动取用。首次启动只回填最近 24h 的 part，避免历史会话灌入记忆库。

Hermes（Nous hermes-agent）同理：`mio observe` 以只读方式增量读取
`<LocalAppData>/hermes/state.db`（`messages.id` 自增游标，无需调用 hermes CLI），
把每个用户回合的 `task_outcome` 写入 `MIO_HOME`（`source=hermes-observer`）。
Hermes 本身有原生记忆，Mio 只负责让 Hermes 经验进入跨 Agent 生态；仅当会话
发生在真实 git 仓库时才写回该仓库的 `AGENTS.md`，避免污染用户主目录。

## MIO_HOME

默认 `~/.mio-intelligence`，可通过环境变量 `MIO_HOME` 覆盖。

## Package layout

```text
packages/mio-cli
├── bin/mio.js
├── adapters/
│   ├── codex.js
│   ├── hermes.js
│   ├── opencode.js
│   ├── workbuddy.js
│   └── claude-code.js
├── observe/
│   └── observer.js
├── server/
│   ├── host-capabilities.js
│   ├── evolution-cutover.js
│   ├── runtime-modules.js
│   ├── creativity-engine.js
│   ├── memory-store.js
│   ├── retention.js
│   ├── digest.js
│   └── mio-intelligence-mcp/index.js
└── package.json
```

`server/memory-store.js` is the single implementation of memory
query/record ranking (Latin token + CJK bigram scoring, project/global
scope layers, reuse-evidence weighting). Both the MCP server
(`mio.memory.query` / `mio.memory.record`) and the CLI
(`mio recall` / `mio remember`) go through it, so rankings are identical
across entry points. `server/digest.js` aggregates traces/memory/reuse
into actionable reports (also exposed as `mio.digest.generate`), and
`server/retention.js` powers `mio prune` (age/expiry trimming with
backups; `memory.jsonl` is never touched without explicit `--memory --yes`).

## Release verification

Before publishing the runtime packages, run:

```bash
npm run verify:pack-install --workspace mio-agent-runtime
```

For CI or reproducible release evidence through `npm run`, set deterministic
directories through environment variables:

```bash
MIO_PACK_ARTIFACT_DIR=./dist/mio-pack-artifacts \
MIO_PACK_INSTALL_DIR=./dist/mio-pack-install \
MIO_PACK_REPORT_PATH=./dist/mio-pack-report.json \
npm run verify:pack-install --workspace mio-agent-runtime
```

PowerShell:

```powershell
$env:MIO_PACK_ARTIFACT_DIR = './dist/mio-pack-artifacts'
$env:MIO_PACK_INSTALL_DIR = './dist/mio-pack-install'
$env:MIO_PACK_REPORT_PATH = './dist/mio-pack-report.json'
npm run verify:pack-install --workspace mio-agent-runtime
```

When invoking the script directly, command-line flags are also supported:

```bash
node packages/mio-cli/scripts/verify-packed-runtime.js \
  --artifact-dir ./dist/mio-pack-artifacts \
  --install-dir ./dist/mio-pack-install \
  --report-path ./dist/mio-pack-report.json
```
