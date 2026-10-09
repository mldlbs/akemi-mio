# AGENTS.md

This workspace integrates Mio Intelligence MCP. Mio is an enhancement layer, not a replacement for normal coding workflow.

## Mio Usage Rules

- Before designing or implementing a solution, call `mio.memory.query` to recall related project context, prior decisions, and known problems. Default `project` is `akemi-mio`.
- After making a decision that affects architecture, deployment, dependencies, or long-term behavior, call `mio.memory.record`. Prefer `kind` values: `decision`, `context`, `problem`, or `note`.
- When a decision adopts or builds on a stored creativity hypothesis, `mio.memory.record` must carry `hypothesisId` (the hypothesis UUID): it injects the tag `hypothesis:<uuid>` that joins the record to the hypothesis, matches `memory.query` tags (AND), and satisfies the `mio.creativity.adopt` evidence check. CLI equivalent: `mio remember ... --hypothesis-id <uuid>`.
- When a tool call fails, retries, or returns an error, call `mio.observer.ingest` with a stable `trace_id`, the relevant `event_type`, `payload`, and `outcome`.
- At the end of every task, before producing the final answer, call `mio.observer.ingest` with `event_type` = `task_outcome`, a stable `trace_id` (for example `codex:<project>:<short-task-title>:<timestamp>`), `outcome` = `success` / `failure` / `aborted`, and a brief non-sensitive `payload` such as `{"summary":"...","verification":"..."}`. If Mio is unavailable, do not block the final answer.
- Before a high-risk operation such as deletion, migration, credential change, or production change, call `mio.policy.check` with the action and follow its suggestion when available.
- When you reuse a prior decision or experience returned by `mio.memory.query` and it changes your approach or outcome, call `mio.experience.reuse` with `sourceAgent`, `targetAgent`, `experienceId`, `reuse`, `behaviorChanged`, and `outcomeImproved`.
- When `mio.observer.ingest` returns `autoClaims` for a reuse that genuinely changed your behavior, confirm it with `mio.experience.confirm` using the auto-claim `id`.
- Keep the `project` field consistent (`akemi-mio`) so memory and traces do not fragment.
- If Mio MCP is unavailable, do not block the task. Proceed normally and note the missed memory or observation.

## Scope

- Do not replace normal coding practices with Mio checks.
- Do not store secrets, credentials, or raw sensitive content in Mio memory.
- These rules apply to the code in this branch/worktree.

<!-- MIO_CONTEXT_BEGIN -->
## Mio 最近上下文（自动注入）
- 2026/10/9 05:56:27 | digest(7d): akemi-mio 10 任务 100% 成功
- 2026/9/29 23:09:55 | success | mio-cli 这轮的开发目标定为 补齐第 5 个 host：Claude Code （你日常在用但此前完全没支持），已完成并提交 747dd384 ，版本 b
- 2026/9/18 07:27:36 | success | collect 需要 联网抓取外部源 （bilibili/hackernews/github/douyin/rss）且依赖 @akemi-mio/observe
- 2026/9/18 07:21:18 | success | renderer 39 文件 / 427 用例 通过。等主进程全量的同时准备提交信息：
- 2026/9/18 07:13:40 | success | 185/185（180 + 新 5），MCP 92/92。检查是否留下过时的"重复"注释：
- 2026/9/18 07:09:57 | success | 三个变异全部按预期变红，且都逐字节还原。跑最终验证：
<!-- MIO_CONTEXT_END -->
