# mio-agent-runtime

Mio Agent Runtime 的可发布 CLI 包。

安装一次，所有 Agent 自动接入 Mio。

## Install

```bash
npm install -g mio-agent-runtime
```

> 新机器 / 升级：请安装 `>=0.5.23`（5 host 被动观察 + trace 查询 + digest 价值管线；
> 0.5.23 修复了 digest 写回污染其它项目 workspace 的问题）。
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
mio memory analyze          Report duplicates, low-quality records and the kind histogram (--project/--limit)
mio memory archive --ids a,b    Archive records, hiding them from recall/analyze (--yes required; reversible)
mio memory restore --ids a,b    Un-archive previously archived records
mio memory merge --ids a,b  Merge duplicate records into one survivor (--keep/--allow-divergent; --yes required)
mio memory migrate --ids a,b --scope global|project   Move records between the project and global layers
mio --json status           Machine-readable status
mio --json agents           Machine-readable agents
mio --json evolution status Machine-readable evolution module health
```

## MCP Tools

MCP server exposes 47 tools across 5 domains:

### Memory (10)
`mio.memory.query` · `mio.memory.record` · `mio.memory.archive` · `mio.memory.merge` · `mio.memory.migrate` · `mio.memory.analyze` · `mio.experience.list` · `mio.experience.confirm` · `mio.experience.reuse` · `mio.policy.check`

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

`mio-agent-runtime` depends on 14 packages that are published to npm under the
`@akemi-mio` scope. All 14 carry version `0.1.0` and are released only when
their source changes, so a normal CLI release does not republish them.

| Package | Description |
|---|---|
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
| `@akemi-mio/observer` | ObserverService — multi-source data collection, trend analysis, deep research, world model, fermentation, DAG state machine, self-evolution engine (zero npm deps) |
| `@akemi-mio/insight` | InsightService — LLM-based insight generation, conflict/drift/repetition/stalled-goal/friction detectors, presence service, insight scoring (zero npm deps) |
| `mio-agent-runtime` | This package — CLI + MCP server |

### Host-coupled packages (not published)

`@akemi-mio/core` and `@akemi-mio/creativity` are consumed inside this
monorepo through `workspace:*` links, so they are built from source and are
**not** on npm. `packages/cli/` no longer exists. Do not add these to a
downstream `package.json` — the install will fail.

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

### Context 块的写入范围（`MIO_CONTEXT`）

`<workspace>/AGENTS.md`（或 `CLAUDE.md`）里的 `MIO_CONTEXT` 块最多保留
6 条（`CONTEXT_MAX`），按时间倒序。三条规则保证真实历史不被挤掉：

- **同一条内容只占一个位置**。重复写入只把它移到最前。旧版本会把同一行
  反复插入，占满全部 6 个位置，把真实任务摘要整体挤出（存量
  `observe-state.json` 里的重复条目会在下次写入时自动清理）。
- **同一项目只对应一个桶**。Context 键取自各 host 转录里的 `cwd` 字段，
  而不同 Agent 的拼写不一致（`D:\work\code\x`、`d:\work\code\x`、
  `D:/work/code/x`）。这些写法现在会被归一到统一形式（盘符大写 + 反斜杠），
  等价桶在读取和写入时自动合并——否则同一个项目会被拆成多个桶，各自
  只保留 6 条，互相看不到对方的历史。存量分裂键无需迁移脚本，
  `loadState` 会在下次加载时合并。
- **`mio digest --write-back` 只写回有数据的项目**。写回的是一行项目维度
  摘要（`digest(7d): <项目> N 任务 M% 成功`），不是全局统计；`observe-state`
  里没有对应 digest 数据的 workspace 会被直接跳过，不会被写入。旧版本把
  同一条全局 headline 广播给所有历史项目，导致无关仓库（如 ComfyUI）被污染。

桶合并后若超过 `CONTEXT_MAX`，按条目内嵌的时间戳（`YYYY/M/D HH:MM:SS`）
截断，保留最新的，而不是按存储位置丢弃。

需要强制指定目标时用 `--cwd <path>` 或 `--project <name>`；`--cwd` 优先。

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
across entry points. The same module also implements the hygiene
operations — `analyze` / `archive` / `merge` / `migrate` — so
`mio.memory.analyze` and `mio memory analyze` can never drift apart.
`server/digest.js`
aggregates traces/memory/reuse into actionable reports (also exposed as
`mio.digest.generate`), and `server/retention.js` powers `mio prune`
(age/expiry trimming with backups; `memory.jsonl` is never touched
without explicit `--memory --yes`).

## Memory hygiene

`mio.memory.analyze` can diagnose duplicates and low-quality records, but
until now the only way to act on that was through the MCP server. The
`mio memory` subcommands close that gap:

```bash
mio memory analyze                       # what needs attention?
mio memory archive --ids mem_a,mem_b     # preview (no --yes = no write)
mio memory archive --ids mem_a,mem_b --yes   # apply
mio memory restore --ids mem_a           # undo
mio memory merge --ids mem_a,mem_b --yes # collapse duplicates into one survivor
mio memory migrate --ids mem_a --scope global   # promote to the global layer
```

Notes:

- **Archive is reversible**, not a delete. Archived records stay in
  `memory.jsonl` with `archived: true` and drop out of `recall` and
  `analyze`. `mio prune --memory` is still the only operation that
  permanently removes records, and it still requires `--yes`.
- **`archive` previews by default.** Without `--yes` it prints what would
  change and exits `1`; this applies in `--json` mode too, so a script
  cannot archive by accident. The ids are shown in the preview, which is
  where a typo gets caught.
- **Ids are accepted as `--ids a,b` or as bare positionals**
  (`mio memory archive mem_a mem_b`). Ids never contain commas.
- **Nothing changed exits non-zero.** If every id is unknown, already
  archived, or belongs to another project, the command reports
  `not found` / `already archived` and exits `1` rather than pretending
  success.
- **Duplicates use Jaccard similarity over Latin tokens and CJK bigrams**
  with a `0.75` threshold, union-find grouped so `A~B, B~C` collapses
  into one group. Above 1500 active records the scan is skipped and
  `duplicatesSkipped` is reported instead of hanging on O(n²) work.

### Merging duplicates

`analyze` reports duplicate groups but cannot resolve them — archiving
each member by hand leaves the survivor without any record of what it
absorbed. `mio memory merge` fixes that:

```bash
mio memory merge --ids mem_a,mem_b --yes                    # newest wins
mio memory merge --ids mem_a,mem_b --keep mem_a --yes       # choose the survivor
```

**Merge only combines byte-identical content by default.** This is a
deliberate safety stance, not an oversight: measured against a real
860-record store, 19 of 22 duplicate groups were byte-identical and 3
were not. Concatenating divergent bodies corrupts them — one real case
produced a record carrying both `Token 来源` and `凭证来源` for the same
field, plus a duplicated header. So when a group's members disagree,
merge **refuses and prints the candidates** instead of guessing:

```bash
mio memory merge --ids mem_a,mem_b --yes
# No merge applied: content differs across records; refusing to concatenate
#   - mem_a (1167 chars, 2026-09-09T14:25:56.735Z)
#   - mem_b (1174 chars, 2026-09-09T14:31:00.898Z)
```

To resolve such a group you must name the body that survives, which is
what `--keep` is for; `--allow-divergent` acknowledges that the others
are being dropped rather than combined:

```bash
mio memory merge --ids mem_a,mem_b --keep mem_b --allow-divergent --yes
```

What a merge writes:

- The **survivor** keeps its own body verbatim and gains
  `supersedes: [<archived ids>]`, `mergedAt`, `mergedCount`, and a
  unioned tag list so no retrieval keyword is lost.
- The **other members** are archived with
  `archiveReason: "merged-into:<survivor>"` and a `mergedInto` pointer.
- It is **reversible**: `mio memory restore --ids <archived ids>` brings
  the group back. The audit fields stay on the record, so the merge
  history survives an undo.
- A re-run that has nothing left to merge exits `1` and reports
  `nothing left to merge` — it does not print an undo command for
  records it did not archive.

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
