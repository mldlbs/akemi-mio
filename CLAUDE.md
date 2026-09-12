<!-- MIO_INTELLIGENCE_BEGIN -->
## Mio Intelligence Layer

Mio MCP tools are available. Treat these as mandatory runtime rules for every workspace.

- Before designing or implementing a solution, or when unsure about prior decisions, call `mio-intelligence_mio.memory.query` first. Omit `project` unless a specific project is required; Mio derives it from the current Git repository.
- After a decision affecting architecture, deployment, dependencies, or long-term behavior, call `mio-intelligence_mio.memory.record` with `kind`: `decision`, `context`, `problem`, or `note`.
- When a tool call fails, retries, or returns an error, call `mio-intelligence_mio.observer.ingest` with a stable `trace_id`, relevant `event_type`, `payload`, and `outcome`.
- Before a high-risk operation such as deletion, migration, credential change, or production change, call `mio-intelligence_mio.policy.check` and follow its suggestion when available.
- At the end of every task, before producing the final answer, call `mio-intelligence_mio.observer.ingest` with `event_type` = `task_outcome`, a stable `trace_id`, `outcome` = `success` / `failure` / `aborted`, and a brief non-sensitive `payload`. If Mio is unavailable, do not block the final answer.
- When you reuse a prior decision or experience returned by `mio-intelligence_mio.memory.query` and it changes your approach or outcome, call `mio-intelligence_mio.experience.reuse` with `sourceAgent`, `targetAgent`, `experienceId`, `reuse`, `behaviorChanged`, and `outcomeImproved`.
- If Mio MCP is unavailable, do not block the task. Continue normally and note the missed memory or observation.
- Do not store secrets, credentials, or raw sensitive content in Mio memory.
<!-- MIO_INTELLIGENCE_END -->

<!-- MIO_CONTEXT_BEGIN -->
## Mio 最近上下文（自动注入）
- 2026/9/12 08:56:43 | digest(7d): 任务 209 条 成功率 93%, error 1
- 2026/9/12 07:38:32 | success | README 完成。实机冒烟：先看 status 新字段，再真实安装 mio install claude ：
- 2026/9/12 07:46:41 | success | 已提交。 Commit e0dc9207 — chore: tidy project root - relocate scratch scripts to sc
- 2026/9/12 07:37:07 | success | 好的，整理到此收尾。后续随时叫我。
- 2026/9/12 07:30:25 | success | 整理完成，按你这两轮的选择收尾： 第一轮（根目录散落文件） - 45 个临时/迁移脚本、日志、备份、杂项文件移入 scripts/_archive/ （ps1 
- 2026/9/12 07:25:37 | success | 根目录整理完成，零删除、可逆。 改动 ：45 个散落文件从根目录移入 scripts/_archive/ ，按类型分四子目录：
- scripts/_archi
<!-- MIO_CONTEXT_END -->
