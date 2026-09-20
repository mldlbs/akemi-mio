# mio-agent-runtime

Mio Agent Runtime 的可发布 CLI 包。

安装一次，所有 Agent 自动接入 Mio。

## 安装

```bash
npm install -g mio-agent-runtime
```

> 新机器 / 升级：请安装 `>=0.5.23`（5 host 被动观察 + trace 查询 + digest 价值管线；
> 0.5.23 修复了 digest 写回污染其它项目 workspace 的问题）。
> 旧版本只有主动 MCP 规则注入，没有「无感存/取」。安装后执行一次
> `mio init && mio install <host>`。

## 命令

```text
mio init                    Initialize MIO_HOME
mio config show             Show effective settings and where each value comes from
mio config llm --url U --model M [--key K]   Store LLM endpoint/key/model in config.json
mio config llm --clear      Remove the stored LLM config (env vars still apply)
mio config path             Print the config.json path
mio mcp                     Start Mio MCP server (stdio)
mio install <host>          Install Mio into a host (codex|opencode|workbuddy|hermes|claude)
mio status                  Show runtime and adapter status
mio agents                  List installed host adapters
mio agents list             List observed agents (from agents.jsonl, --project X)
mio agents report           Report per-agent task/memory/reuse telemetry (--agent X, --project Y)
mio agents register --agent-id X   Register an observed agent (--yes to apply; previews by default)
mio agents evaluation       ADR-017 evaluation metrics: route adoption, behaviour change, recall quality, data hygiene (--project X, --since ISO)
mio evolution status        Show composed evolution module health
mio evolution report        Cross-agent evolution report: ecosystem, agents, memory health, suggestions (--period 24h|7d|30d|all)
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
mio memory forget --ids a,b     PERMANENTLY delete records (--yes required; writes an audit entry; not undoable)
mio memory merge --ids a,b  Merge duplicate records into one survivor (--keep/--allow-divergent; --yes required)
mio memory migrate --ids a,b --scope global|project   Move records between the project and global layers
mio policy check "<action>" Check the historical risk of an action before running it (--project; reads global MIO_HOME)
mio creativity status        Show creativity hypothesis counts and recent top ideas (reads global MIO_HOME)
mio creativity list          List creativity hypotheses (--status active|validated|rejected|draft, --limit N)
mio creativity generate      Generate hypotheses from 2+ --source "name|content" (calls an LLM)
mio creativity ferment       Review and refine active hypotheses (calls an LLM)
mio insight status           Insight counts: total, reported, unreported, high-value (needs @akemi-mio/insight)
mio insight list             List insights (--unreported, --min-score N, --detector X, --limit N)
mio insight generate         Generate insights from context (--memory "kind|content"/--summary "text"; calls an LLM)
mio insight mark-reported    Mark insights as reported (--ids a,b)
mio observer <view>          Observer research pipeline views (research pipeline, not the observe daemon):
                             status|world-model|trends|research|insights|essays|dag (--base-dir DIR)
mio observer collect         Fetch from the configured sources (--sources a,b/--keywords k1,k2/--limit N)
mio observer ferment         Run the fermentation engine (--session morning|afternoon|night)
mio observer ingest --trace-id T --event-type E   Record a trace event (--payload JSON/--outcome)
mio observer subscribe --event-types a,b          Subscribe to events (--yes to apply; previews by default)
mio observer digest                               New events since the last digest (advances the cursor)
mio phase0 report            Show the Phase 0 validation report (--project X, --format markdown)
mio host capabilities        Show what each host supports and whether it is installed (--json)
mio task route "<task>"      Which verified experiences apply to this task (--project/--scope/--limit)
mio task record-outcome --outcome success   Record a task outcome (--yes to apply; previews by default)
mio --json status           Machine-readable status
mio --json agents           Machine-readable agents
mio --json evolution status Machine-readable evolution module health
mio --version                Print the version and exit (-V)
```

## MCP 工具

MCP 服务端在 5 大域共暴露 49 个工具：

### 记忆（11）
`mio.memory.query` · `mio.memory.record` · `mio.memory.archive` · `mio.memory.merge` · `mio.memory.migrate` · `mio.memory.analyze` · `mio.memory.forget` · `mio.experience.list` · `mio.experience.confirm` · `mio.experience.reuse` · `mio.policy.check`

### 观察管线（14）
`mio.observer.world_model` · `mio.observer.trends` · `mio.observer.research` · `mio.observer.insights` · `mio.observer.status` · `mio.observer.collect` · `mio.observer.ferment` · `mio.observer.essays` · `mio.observer.dag` · `mio.observer.ingest` · `mio.observer.subscribe` · `mio.observer.digest`
`mio.trace.query` — 按类型/结果/agent/项目/时间窗口查询 trace 日志（任务结果、工具错误）；CLI 上也可通过 `mio traces` 调用
`mio.digest.generate` — 把近期数据聚合成可执行的 digest（agent 成功率、项目活跃度、错误热点、复用证据、建议）；CLI 上也可通过 `mio digest` 调用

### 洞察自省（4）
`mio.insight.status` · `mio.insight.list` · `mio.insight.mark_reported` · `mio.insight.generate`

### 创意引擎（4）
`mio.creativity.generate` · `mio.creativity.ferment` · `mio.creativity.list` · `mio.creativity.status`

### 任务、Agent 与演化（16）
`mio.task.route` · `mio.task.record_outcome` · `mio.agent.register` · `mio.agent.list` · `mio.agent.report` · `mio.agent.evaluation` · `mio.host.capabilities` · `mio.evolution.status` · `mio.evolution.report` · `mio.evolution.shadow.record` · `mio.evolution.dual_write.record` · `mio.evolution.cutover.readiness` · `mio.evolution.cutover.apply` · `mio.evolution.migration.plan` · `mio.evolution.authority.plan` · `mio.phase0.report`

## 包

`mio-agent-runtime` 依赖发布在 `@akemi-mio` scope 下的 **9** 个包（声明于 `package.json`，均为 `0.1.0`）。它们仅在源码变更时才发布，所以普通的 CLI 发布不会重新发布这些包。

| 依赖 | 说明 |
|---|---|
| `@akemi-mio/runtime-contracts` | 共享类型定义 |
| `@akemi-mio/runtime-foundation` | 日志、EventBus、记忆 schema |
| `@akemi-mio/experience-memory` | 经验记录与检索 |
| `@akemi-mio/evolution-learning` | 演化学习引擎 |
| `@akemi-mio/evolution-strategy` | 演化策略引擎 |
| `@akemi-mio/evolution-safety` | 安全护栏 |
| `@akemi-mio/evolution-scheduler` | 演化调度器 |
| `@akemi-mio/observer` | ObserverService —— 多源数据采集、趋势分析、深度研究、世界模型、发酵、DAG 状态机、自演化引擎（零 npm 依赖） |
| `@akemi-mio/insight` | InsightService —— 基于 LLM 的洞察生成、冲突/漂移/重复/停滞目标/摩擦检测器、在场服务、洞察打分（零 npm 依赖） |

以下 `@akemi-mio` 包同样位于本 monorepo 中并独立发布，但**不是**本 CLI 的依赖——其源码从不 import 它们，因此未声明在 `package.json` 里：

- `@akemi-mio/analysis` — ModuleScanner，对包源码树做静态分析（零依赖）
- `@akemi-mio/messaging` — ExternalMessageGateway，入站消息路由 + 通知分发（零依赖）
- `@akemi-mio/reasoning` — 纯函数打分规划器，用于推理指令
- `@akemi-mio/resource-control` — 资源预算、后台任务运行器
- `@akemi-mio/agent-persona` — 人格漂移控制、内容分类

它们可直接被其它 Node 项目消费。`mio-agent-runtime` 自身是 CLI + MCP server 包。

### 与宿主耦合的包（不发布）

`@akemi-mio/core` 与 `@akemi-mio/creativity` 通过 `workspace:*` 链接在本 monorepo 内部消费，因此从源码构建，**不**发布到 npm。`packages/cli/` 已不存在。不要把这两个包加进下游 `package.json`——安装会失败。

## 宿主说明

- OpenCode 通过 `~/.config/opencode/opencode.json` 做 MCP 注册，通过 `~/.config/opencode/AGENTS.md` 做全局指令。`mio install opencode` 会写入这两个文件，并向 `AGENTS.md` 注入 Mio 使用规则，使 OpenCode 自动调用 Mio 的记忆/观察/策略。若 OpenCode 已在运行，重启一次以重新加载这两个文件。`mio observe` 还会被动跟踪 OpenCode 会话数据库（`opencode db`），无需模型主动调用 Mio 工具。
- Hermes 使用 `hermes mcp add mio-intelligence --command node --args <server>` 来注册 Mio MCP server。Hermes 有原生记忆并读取 AGENTS.md Context Files，因此无需注入 Mio 规则也能检索。
- Claude Code：`mio install claude` 在用户级 `~/.claude.json`（`mcpServers`）注册 Mio MCP server——不像项目级 `.mcp.json` 需要交互式审批——并向 `~/.claude/CLAUDE.md`（自动加载的用户记忆）与 `<workspace>/CLAUDE.md`（项目记忆）注入 Mio 使用规则。重启运行中的 Claude Code 会话以重新加载两者。`mio observe` 被动跟踪 `<config-dir>/projects/<munged-cwd>/*.jsonl` 会话记录：跳过 sidechain（子 agent）行，每个用户 prompt 结束上一轮，`tool_result.is_error` 行记为错误 trace，成功轮次的摘要写回 workspace 的 `CLAUDE.md` 的 `MIO_CONTEXT` 块，供下一会话被动取用。可用 `CLAUDE_CONFIG_DIR` 覆盖配置目录。
- WorkBuddy 使用 `~/.workbuddy/mcp.json`，并要求每个自定义 MCP server 在 `~/.workbuddy/mcp-approvals.json` 中审批通过。`mio install workbuddy` 会写入这两个文件，并向 `~/.workbuddy/CODEBUDDY.md`（用户级记忆规则，由 WorkBuddy 自动加载进每次会话；CLI 硬编码了 CodeBuddy 产品名，所以文件名是 CODEBUDDY.md 而非 WORKBUDDY.md）以及 `<workspace>/AGENTS.md`（项目级）注入 Mio 使用规则。若 WorkBuddy 已在运行，重启一次以重新加载审批与记忆规则文件。

## 被动观察器（`mio observe`）

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

## 包结构

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
│   ├── experience-store.js
│   ├── policy-store.js
│   ├── retention.js
│   ├── digest.js
│   └── mio-intelligence-mcp/index.js
└── package.json
```

`server/memory-store.js` 是记忆查询/记录排序（Latin token + CJK bigram 打分、project/global 作用域分层、复用证据加权）的唯一实现。MCP 服务端（`mio.memory.query` / `mio.memory.record`）与 CLI（`mio recall` / `mio remember`）都经过它，因此各入口的排序结果完全一致。同一个模块还实现了卫生操作——`analyze` / `archive` / `merge` / `migrate`——所以 `mio.memory.analyze` 与 `mio memory analyze` 不可能各自漂移。`server/experience-store.js` 与 `server/policy-store.js` 对 `mio.experience.*` 与 `mio.policy.check` 遵循同样的模式；策略存储复用了记忆存储的分词器，因此策略风险证据与相关记忆排序在构造上就与 `mio.memory.query` 一致。`server/creativity-engine.js` 是 `mio.creativity.*` 背后的共享实现——CLI 的 `mio creativity status`/`list` 与 MCP 工具调用的是同一个 `CreativityEngine`，因此假设计数在入口间不会漂移。`server/agent-store.js` 是 `mio.agent.list` / `register` / `report` 背后的共享实现；CLI 的 `mio agents list`/`report` 与 MCP 工具读取的是同一个存储，因此被观察 agent 的遥测数据在任何地方都相同。`server/llm-client.js` 是 `chatJson` 的唯一实现，MCP 服务端（创意引擎 + insight）与 CLI（`mio creativity generate`/`ferment`）共用，因此两边调用的是同一个模型与同一份配置（环境变量 > `MIO_HOME/config.json` 的 `llm` 块 > 内置默认，见「LLM 配置」）。`server/query-log.js` 是 `queries.jsonl` 的唯一读写实现——记忆存储在 `queryMemory` 时记录查询，任务存储在 auto-claim 时消费它把 `task_outcome` 归因到先前的查询；两者**不能互相引用**（会成环），所以日志自成一模块、由调用方把同一个实例交给两个 store。`server/digest.js` 把 traces/memory/reuse 聚合成可执行报告（同样以 `mio.digest.generate` 暴露），`server/retention.js` 驱动 `mio prune`（按年龄/过期裁剪并备份；没有显式的 `--memory --yes` 绝不触碰 `memory.jsonl`）。

## 记忆卫生

`mio.memory.analyze` 能诊断重复项与低质量记录，但此前唯一的处置途径是通过 MCP 服务端。`mio memory` 子命令补上了这个缺口：

```bash
mio memory analyze                       # 需要关注什么？
mio memory archive --ids mem_a,mem_b     # 预览（不加 --yes = 不写入）
mio memory archive --ids mem_a,mem_b --yes   # 执行
mio memory restore --ids mem_a           # 撤销
mio memory merge --ids mem_a,mem_b --yes # 把重复项合并为一个幸存者
mio memory migrate --ids mem_a --scope global   # 提升到 global 层
```

说明：

- **归档可逆，不是删除**。被归档的记录仍以 `archived: true` 留在 `memory.jsonl` 中，并从 `recall` 与 `analyze` 中消失。`mio prune --memory` 仍是唯一会永久删除记录的操作，且仍需要 `--yes`。
- **`archive` 默认先预览**。不加 `--yes` 时打印将要发生的变更并以退出码 `1` 结束；`--json` 模式同样如此，脚本无法意外归档。预览中会展示 id，拼写错误在此被捕获。
- **id 既可写作 `--ids a,b`，也可作裸位置参数**（`mio memory archive mem_a mem_b`）。id 中绝不含逗号。
- **无变更时以非零退出**。若每个 id 都未知、已归档或属于其它项目，命令会报告 `not found` / `already archived` 并以退出码 `1` 结束，而非假装成功。
- **重复项使用 Latin token 与 CJK bigram 的 Jaccard 相似度**，阈值 `0.75`，用并查集聚类，使 `A~B, B~C` 坍缩为一组。活跃记录超过 1500 条时跳过扫描，改为报告 `duplicatesSkipped`，避免在 O(n²) 工作上卡死。

### 彻底遗忘（`mio memory forget`）

上面所有操作都是**可逆**的：archive 只是打上 `archived: true`，merge 基于 archive，
migrate 只改作用域。`forget` 是**唯一不可逆**的操作——它把记录真正删除。

```bash
mio memory forget --ids mem_secret --project demo            # 预览
mio memory forget --ids mem_secret --project demo --yes      # 真正删除
```

```text
Forget preview: 1 id(s) (project=demo)
  mem_secret  secret token abc123

WARNING: this permanently deletes the record(s) and cannot be undone.
An audit entry (excerpt only) is written to memory-forget-audit.jsonl.
Reversible alternative: mio memory archive --ids mem_secret --yes
Re-run with --yes to delete permanently.
```

几条硬性保证（均有测试覆盖）：

- **预览显示"将要消失的是什么"**，而不只是 id——这是唯一删了就没了的操作。
- **审计先行**：先把条目写进 `<MIO_HOME>/memory-forget-audit.jsonl` 再删除，
  所以任何一次删除事后都能回答"删掉了什么"。
- **审计只存摘要，不存全文**（`excerpt` 取前 120 字符 + `contentLength` + `kind`），
  不会在你要求删除之后又悄悄把全文留下来。
- **跨项目绝不误删**：id 属于其它项目时按 `not found` 处理，原记录保留。
- **全部未命中以退出码 `1` 结束**，避免一次 typo 被当成成功。
- 预览与 `--json` 里都会给出**可逆替代方案**（`mio memory archive`）。

> 除非记录必须真的消失（例如误存了凭据），否则请优先用 `archive`。

### 合并重复项

`analyze` 会报告重复组但无法消解——逐个手动归档会让幸存者丢失它吸收的那些内容。`mio memory merge` 解决了这个问题：

```bash
mio memory merge --ids mem_a,mem_b --yes                    # 最新者胜出
mio memory merge --ids mem_a,mem_b --keep mem_a --yes       # 指定幸存者
```

**默认只合并字节完全一致的内容。** 这是刻意为之的安全立场，而非疏漏：在真实 860 条记录的存储上实测，22 个重复组中有 19 个字节完全一致，3 个不一致。拼接分歧内容会破坏它们——一个真实案例产生了一条同时携带 `Token 来源` 和 `凭证来源` 同一字段、还多了重复表头的记录。因此当组内成员不一致时，merge **会拒绝并打印候选**，而不是猜测：

```bash
mio memory merge --ids mem_a,mem_b --yes
# No merge applied: content differs across records; refusing to concatenate
#   - mem_a (1167 chars, 2026-09-09T14:25:56.735Z)
#   - mem_b (1174 chars, 2026-09-09T14:31:00.898Z)
```

要消解这样的组，必须指定保留哪份内容，这正是 `--keep` 的用途；`--allow-divergent` 表示承认其它成员是被丢弃而非合并：

```bash
mio memory merge --ids mem_a,mem_b --keep mem_b --allow-divergent --yes
```

合并会写入的内容：

- **幸存者**原样保留自己的正文，并获得 `supersedes: [<archived ids>]`、`mergedAt`、`mergedCount`，以及合并后的标签列表，不丢失任何检索关键词。
- **其它成员**以 `archiveReason: "merged-into:<survivor>"` 归档，并带上 `mergedInto` 指针。
- 它**可逆**：`mio memory restore --ids <archived ids>` 能把整组恢复。审计字段保留在记录上，因此合并历史在撤销后依然存在。
- 没有可合并内容时的重跑会以退出码 `1` 报告 `nothing left to merge`——不会为它没归档的记录打印撤销命令。

## 策略检查

`mio.policy.check` 一直能从 trace 日志回答「这个动作历史上是否有风险？」，但此前只通过 MCP 提供。`mio policy check` 把它带到了终端：

```bash
mio policy check "npm publish"
mio policy check "git reset --hard" --project akemi-mio
mio policy check "npm publish" --json
```

```text
Policy check: "npm publish" (project=akemi-mio)
risk: HIGH (0.5)
evidence: 2 matching trace(s), 1 failure(s)
outcomes: failure=1 success=1

Recent failures:
  - E403 token lacks bypass_2fa

Related memory:
  - mem_pub  npm publish requires a granular token with bypass_2fa enabled

Historically risky: ... 
```

说明：

- **它读取全局 `MIO_HOME`，而非每项目目录。** MCP 服务端把数据目录解析为 `MIO_DATA_DIR || cwd/.mio-intelligence`，因此从任意目录发起的 MCP 调用看到的是空存储；CLI 刻意指向累积的全局日志。用 `--project` 把 trace 集合限定到某个项目。
- **风险即失败占比**，`>= 0.4` 为高，`>= 0.2` 为中。`retry` 与 `aborted` 与 `failure`、`error` 一并计为失败。无匹配历史报告 `UNKNOWN`，与 `LOW`（干净记录）不同。
- **匹配可能被通用 token 带偏。** 匹配是对动作 token 的宽松 OR，所以像 `task` 这样的动作几乎匹配每条 trace，因为关键词 `task` 几乎出现在所有 payload 中。当动作中*每个* token 都至少出现在半数候选 trace 里时，CLI 会打印警告，而不是让等级自说自话：

  ```text
  WARNING: low-signal match. Every token in this action (task) appears in
  most traces regardless of subject, so the level above is not meaningful.
  Try a more specific action, e.g. mio policy check "npm publish".
  ```

  这把弱点暴露在了 CLI 层；MCP 的匹配行为不变，且 `diagnostics` 是新增字段，既有消费者继续可用。
- **小样本会标注。** 匹配 trace 少于 5 条时打印 `NOTE: only N matching trace(s); treat the level above as a weak signal.`
- **属于动作的 flag 会被保留。** 只有 `--project` 与 `--json` 作为选项被消费，因此 `git reset --hard` 会原样透传，而非被截断成 `git reset`。

## 创意引擎

`mio.creativity.status` 与 `mio.creativity.list` 自引擎落地起就在 MCP 面上，但此前没有终端入口。`mio creativity` 把只读一侧带到了 CLI：

```bash
mio creativity status
mio creativity list --status rejected --limit 10
mio creativity list --json
```

```text
Creativity engine:
  hypotheses: 5  combos: 3  experiments: 1
  active: 2  validated: 1  rejected: 1

Recent top ideas:
- Plugin architecture  (novelty=80 feasibility=70 impact=90 score=240)
    idea_1787936687555_0
```

说明：

- **它委托给与 MCP 服务端相同的 `CreativityEngine`**，因此终端的 `mio creativity list` 看到的是与 `mio.creativity.list` 工具完全一致的假设。存储位于 `<MIO_HOME>/creativity/creativity-hypotheses.jsonl`；CLI 指向全局 `MIO_HOME`，与 `mio policy check` 一致。
- **空存储是正常状态。** 引擎运行之前，`status` 报告全零计数，`list` 显示 "No hypotheses match." 两者都是有效输出，不是错误。

### 生成与发酵（`generate` / `ferment`）

这两个子命令会调用 LLM，`mio creativity` 同样支持它们——用的是**共享的 LLM 客户端**
（`server/llm-client.js`），与 MCP 服务端完全同一实现：

```bash
mio creativity generate --source "auth|token rotation" --source "cache|write-through"
mio creativity ferment --limit 3
```

- `--source "名称|内容"` **至少两个**：引擎是把概念两两配对来产生新假设的，
  一个来源在构造上就不可能产出组合（此时**不会**调用 LLM，直接返回
  `need at least 2 sources`）。
- `ferment` 会复核 `active` 假设并更新分数；`verdict=promote` 且总分 > 200 时
  升为 `validated`，`verdict=reject` 则标记为 `rejected`。

#### LLM 配置

只有 4 条命令会调用大模型：`mio creativity generate` / `ferment`、
`mio insight generate`、`mio observer ferment`。它们共用
`server/llm-client.js` 这一份实现，配置也共用同一套解析顺序：

```
环境变量  >  MIO_HOME/config.json 的 llm 块  >  内置默认值
```

**写入配置文件**（换机器/换终端不必重设）：

```bash
mio config llm --url http://localhost:11434/v1/chat/completions \
               --model qwen2.5:14b
# 需要鉴权时再加 --key <token>；清空用 --clear
```

**查看当前生效值及其来源**：

```bash
mio config show
```

`show` 会逐字段标注该值来自环境变量、`config.json` 还是内置默认，
并在环境变量遮挡了文件配置时明确警告——只报值不报来源，正是
「改了 `config.json` 却毫无变化」的常见成因。

**也可以用环境变量**（优先级更高，便于单次覆盖）：

| 变量 | 说明 |
|---|---|
| `LLM_API_URL` | OpenAI 兼容端点（默认 opencode zen） |
| `LLM_KEY` | Bearer token；留空表示无需鉴权（本地 Ollama 常见） |
| `LLM_CHAT_MODEL` | 模型 id，回退到 `LLM_MODEL` |

```bash
LLM_API_URL=http://localhost:11434/v1/chat/completions mio creativity ferment
```

未配置任何 LLM 时，命令会**先提示**它将要调用默认端点，再继续——
不会静默地把请求发到你没配的地方。

## 洞察自省与观察管线

`mio.insight.*` 与 `mio.observer.*` 此前都只有 MCP 入口：agent 会话里能读到，终端里看不到。`mio insight` 与 `mio observer` 补上了这两块的终端入口。

```bash
# 洞察自省（需要可选包 @akemi-mio/insight）
mio insight status
mio insight list --unreported --min-score 0.7
mio insight mark-reported --ids ins_1,ins_2
mio insight generate --memory "decision|把记忆解析抽到共享 store" --summary "刚发了 0.7.0"

# 观察研究管线（纯文件读取，不依赖可选包）
mio observer status
mio observer trends --limit 5
mio observer trends --date 2026-09-12
mio observer dag --days 14
mio observer essays --type published
mio observer world-model
mio observer research --json
mio observer trends --base-dir /path/to/.local/observer
```

说明：

- **两者都委托给与 MCP 服务端完全相同的共享实现** —— `server/insight-store.js` 与 `server/observer-store.js`。这是 `memory-store.js` / `experience-store.js` / `policy-store.js` / `creativity-engine.js` / `agent-store.js` 一路沿用的同一个模式：一份实现、两个入口，因此不可能各自漂移。
- **只有 `insight generate` 仍是 MCP 专有**（`mio.insight.generate`）：它要调 LLM，CLI 把它当作未知子命令拒绝。`observer collect` / `observer ferment` 此前也被一起挡在 CLI 之外，理由是「它们属于 daemon」——这个理由不成立：`observe/observer.js` 那条 daemon 只 tail WorkBuddy 的 transcript，从不调用这两者。现在它们有了终端入口，默认走全部已配置源：

  ```bash
  mio observer collect                                  # 全部已配置源
  mio observer collect --sources rss,github --limit 20  # 指定源
  mio observer collect --sources rss --keywords mcp,cli # 关键词 OR 过滤
  mio observer ferment --session morning                # morning|afternoon|night
  ```

  两者都依赖可选包 `@akemi-mio/observer`（未安装时提示 `not installed`，不是空结果）。`collect` 会**联网**抓取，`ferment` 需要 LLM；它们**不做预览**，因为预览意味着把数据抓两遍。单个源失败不会中断整次运行——该源会以 `errors: ...` 出现在输出里，其余源照常统计。
- **`mio observer ingest` 记录任意 trace 事件**（`tool_call` / `error` / `retry` / `task_outcome`）：

  ```bash
  mio observer ingest --trace-id t1 --event-type tool_call --payload '{"tool":"Bash"}' --project demo
  ```

  它是**追加**而非修改，所以像 `mio remember` 一样直接写入、**不做预览**；但缺 `--trace-id` / `--event-type`，或 `--payload` 不是合法 JSON 对象时，会在写入任何东西之前拒绝。
  只想记录任务结果时用 `mio task record-outcome` 更合适——它更专用，还会一并更新该 agent 的 `taskCount` / `successCount` / `failureCount`。

### 订阅与摘要（`subscribe` / `digest`）

```bash
mio observer subscribe --event-types tool_call,error --project demo        # 预览
mio observer subscribe --event-types tool_call,error --project demo --yes  # 订阅
mio observer ingest --trace-id t1 --event-type tool_call --project demo
mio observer digest --project demo
```

```text
Observer digest: 1 event(s) (project=demo, agent=cli)
  subscriptions: 1 active, 1 matched
- tool_call trace=t1
Note: this advances the cursor; the next digest returns only newer events.
```

- `subscribe` 是写操作，**默认只预览**（exit 1、不落盘），`--yes` 才写。相同的
  agent+project+事件类型+主题视为**同一条订阅**，重复执行是**续期**而非新增一行。
- **`digest` 是基于游标的**：只返回上次投递之后的**新事件**，并推进游标。
  所以「第二次跑返回 0 条」是**正确行为**，不是坏了——输出里也明确写了这一点，
  免得让人误以为订阅失效了。
- 因此 digest **无法预览**（不跑就不知道有什么），但它会写游标这件事在输出与
  `mio observer help` 里都写明了。
- 订阅、traces、游标都在 `<MIO_HOME>` 下（与研究管线的 `.local/observer` 不同），
  所以这组能力放在 `server/subscription-store.js`，与 `observer-store.js` 分开。

- **数据位置不同，这是有意的。** 洞察存储在 `<MIO_HOME>/insights/insights.json`，与 `mio recall` / `mio policy check` 同处全局 `MIO_HOME`；观察研究管线则是按项目的，默认 `<cwd>/.local/observer`（与 MCP 服务端的默认值一致），可用 `--base-dir` 覆盖。
- **`@akemi-mio/insight` 是可选依赖。** 未安装时 `mio insight status` 会失败并提示 `@akemi-mio/insight not installed`，而不是报告一个「看起来没有洞察」的全零结果——全零会掩盖「引擎根本没装」这件事。
- **观察管线的空目录是正常状态。** 管线没跑过时，`observer status` 各阶段计数为 0 并提示 "No pipeline data yet."，其余视图显示 "No ... found."，都是有效输出而非错误。

## Agent

本仓库里有两种不同的「agent」概念，CLI 把它们分开以免混淆：

- **已安装的宿主适配器**（`mio agents`，无子命令）来自 `config.json`——哪些宿主（codex/opencode/workbuddy/hermes/claude）已通过 `mio install` 接好。这是配置状态。
- **被观察的 agent**（`mio agents list` / `mio agents report`）来自 `agents.jsonl`，并交叉引用 `traces.jsonl`、`memory.jsonl` 与 `experience_reuse.jsonl`。这是运行时遥测：每个 agent 跑了多少任务、成功多少、产生了多少记忆与已验证复用。

```bash
mio agents                      # 已安装的宿主适配器
mio agents list                # 被观察的 agent（--project 限定范围）
mio agents report              # 每 agent 的任务/记忆/复用遥测
mio agents report --agent codex
```

```text
Agent report (project=akemi-mio): 2 agent(s)
codex (mcp)  idle
   tasks: 5 total, 5 success, 0 failure (100% success)
   memories: 88  experience reuses: 54 (verified 6)
   last seen: 2026-09-06 00:57:03 | sessions=2
```

两个子命令都委托给 `server/agent-store.js`——与 `mio.agent.list` / `mio.agent.report` / `mio.agent.register` MCP 工具相同的存储，因此终端与 MCP 服务端报告一致的遥测，不可能漂移。`list` 读取 `agents.jsonl`；`report` 叠加 trace/memory/reuse 的交叉引用。

### 评估期指标（`mio agents evaluation`）

ADR-017 用四项指标决定控制平面是继续扩展还是回滚。实现见
`server/evaluation-store.js`，MCP 侧为 `mio.agent.evaluation`。

| 指标 | 口径 | 数据来源 |
|---|---|---|
| 路由采纳率 | 命中且被采纳 / 命中 | `queries.jsonl` ⚠️ |
| 行为改变率 | confirmed 且 behaviorChanged / 全部 reuse | `experience_reuse.jsonl` |
| 召回质量 | 结果导向 reuse 的查询 / 有结果的查询 | `queries.jsonl` ⚠️ |
| 数据卫生 | 未确认 auto-claim / 全部 reuse | `experience_reuse.jsonl` |

**无样本时输出 `no data`，而不是 `0%`**：`0%` 的意思是「测过了、很差」，
`no data` 才是「没测」。`--json` 下对应 `null`，客户端必须区分这两种情况。

⚠️ **前两项指标读的是一个设计上就会变空的缓冲区**。`queries.jsonl` 不是评估日志，
而是 auto-claim 的关联缓冲（见 `server/query-log.js`）：最多 200 条，超过
`expiresAt`（默认 1 小时）就被清理，`retention.js` 也把它列在 `EXPIRY_BASED_FILES`。
所以这两项在实际使用中**几乎总是 `no data`**——不是因为路由没人用，而是因为它的证据
被有意设计成不长期保留。报告里会打印一句说明，避免读者把「缓冲区为空」误读成
「功能没被使用」。

### 注册（`mio agents register`）

`register` 是这一组里唯一的**写操作**，因此沿用与 `mio memory archive` 相同的约定：
**默认只预览，加 `--yes` 才落盘**，`--json` 模式同样受限。

```bash
mio agents register --agent-id my-agent --project demo --capabilities code,test
mio agents register --agent-id my-agent --project demo --yes    # 真正写入
```

```text
Register preview: my-agent (project=demo, host=mcp)
  will create a new agent record
  capabilities: code, test
Re-run with --yes to apply.
```

- **预览时不会创建 `agents.jsonl`**——这点有测试钉住（预览跑完文件不存在）。
- 已存在时预览会显示 `will update existing agent (sessionCount 4 -> 5)`，
  而不是含糊地说"将注册"。
- `--yes` 首次创建（`sessionCount: 1`），再次执行则更新
  `lastSeenAt` + `sessionCount`，**不会产生重复行**。
- 更新时若省略 `--capabilities`，原有能力**保留**（只有显式传入非空列表才覆盖）。

### 与 `mio host capabilities` 的区别

第三个与 host 相关的命令是 `mio host capabilities`，它回答的是**另两个问题**：
每个宿主支持什么能力（静态表），以及**此刻是否真的装上了**（实时探测各 adapter）。

```text
Host capabilities: 5 host(s)
  codex      not installed
             mcp-tools, memory, observer-ingest, policy-check, experience-reuse, runtime-status
  opencode   installed
             mcp-tools, memory, observer-ingest, policy-check, experience-reuse, runtime-status
```

它与 `mio agents` **不是一回事**，两者不一致时本身就是有用的诊断信号：

| 命令 | 数据来源 | 含义 |
|---|---|---|
| `mio agents` | `config.json` | 记录"曾经安装过"（含安装时间） |
| `mio host capabilities` | 实时探测 adapter | 本机**现在**是否真的装上了 |

例如配置文件还在、但宿主目录已被删掉时，`mio agents` 仍会列出它，而
`host capabilities` 显示 `not installed`。

## 任务路由（`mio task route`）

回答的是"这类任务历史上谁做成过、按哪条已验证经验走"：把**已验证的复用经验**
（`confirmed` + `reuse` + `behaviorChanged` + `outcomeImproved` 四项全真）与任务描述
做相关性匹配，再叠加 digest 快照里的 agent 健康信号。

```bash
mio task route "publish npm package"
mio task route "mio.experience.confirm 复用证据" --project akemi-mio --limit 3
mio task route "deploy service" --json
```

```text
Task route: "mio.experience.confirm 复用证据" (project=akemi-mio, scope=project)
verified routes: 5

Routes (apply the top match first):
1. [score 23.5] mem_1786932717070_22577ed0f57a — reused 2x (confirmed)
   新增 mio.experience.confirm（worktree ...）：把 source=auto_claim 的复用证据升级为已确认...
   codex -> opencode
```

### 与 MCP 唯一的行为差异：不写查询日志

`mio.task.route` 会把这次查询写进 `queries.jsonl`——这是 Phase 0 **自动认领**
（auto-claim）机制的输入：之后的 `task_outcome` 才能把"路由命中→任务成功"
关联成复用证据。这个写入是**承重的**，不能去掉。

但终端里的 `mio task route` 是一次**查看**，每跑一次就往查询日志塞一条是不对的。
所以 store 提供了 `persistQuery` 开关：

| 调用方 | `persistQuery` | 是否写 `queries.jsonl` |
|---|---|---|
| MCP `mio.task.route` | 默认 `true` | ✅ 写（保持原行为） |
| CLI `mio task route` | `false` | ❌ 不写 |

测试里两条都钉住了：CLI 跑完 `queries.jsonl` **不存在**；同一 store 传
`persistQuery: true` 则**确实写入**——证明差异来自开关，而不是代码路径坏了。

### 记录结果（`mio task record-outcome`）

把任务结果写回证据库，与上面的路由形成**闭环**：
路由 → 执行 → 记录结果 → 变成新的复用证据。

```bash
mio task record-outcome --outcome success --task "deploy service" --summary "all green"
mio task record-outcome --outcome failure --task "deploy service" --yes    # 真正写入
```

它做三件事：写一条 `task_outcome` trace → 触发 auto-claim（把此前匹配的查询
关联成复用证据）→ 更新该 agent 的 `taskCount` / `successCount` / `failureCount`。

```text
Record outcome preview: success (project=demo, agent=cli)
  task: deploy it
  agent not registered: trace only, agent registry untouched
  register it with: mio agents register --agent-id cli --yes
Re-run with --yes to apply.
```

同样是**写操作**，因此同样默认只预览：

- 预览**不会创建 `traces.jsonl`**（有测试钉住）。
- `--outcome` 非法时**在写入任何东西之前**就拒绝——不会出现"写了一半"。
- 预览会告诉你 agent **是否已注册**：未注册时明确说"只写 trace、不更新注册表"
  并给出注册命令，而不是默默少做一件事。
- 已注册时预览显示 `will update agent (taskCount 4 -> 5, successCount 3 -> 4)`。

## 发布验证

发布运行时包之前，先运行：

```bash
npm run verify:pack-install --workspace mio-agent-runtime
```

对于 CI 或可通过 `npm run` 复现的发布证据，用环境变量设定确定性目录：

```bash
MIO_PACK_ARTIFACT_DIR=./dist/mio-pack-artifacts \
MIO_PACK_INSTALL_DIR=./dist/mio-pack-install \
MIO_PACK_REPORT_PATH=./dist/mio-pack-report.json \
npm run verify:pack-install --workspace mio-agent-runtime
```

PowerShell：

```powershell
$env:MIO_PACK_ARTIFACT_DIR = './dist/mio-pack-artifacts'
$env:MIO_PACK_INSTALL_DIR = './dist/mio-pack-install'
$env:MIO_PACK_REPORT_PATH = './dist/mio-pack-report.json'
npm run verify:pack-install --workspace mio-agent-runtime
```

直接调用脚本时也支持命令行 flag：

```bash
node packages/mio-cli/scripts/verify-packed-runtime.js \
  --artifact-dir ./dist/mio-pack-artifacts \
  --install-dir ./dist/mio-pack-install \
  --report-path ./dist/mio-pack-report.json
```
