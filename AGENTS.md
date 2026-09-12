# AGENTS.md

This workspace integrates Mio Intelligence MCP. Mio is an enhancement layer, not a replacement for normal coding workflow.

## Mio Usage Rules

- Before designing or implementing a solution, call `mio.memory.query` to recall related project context, prior decisions, and known problems. Default `project` is `akemi-mio`.
- After making a decision that affects architecture, deployment, dependencies, or long-term behavior, call `mio.memory.record`. Prefer `kind` values: `decision`, `context`, `problem`, or `note`.
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
- 2026/9/12 14:51:57 | success | 两份 README 已更新并提交（ 96dea00b ）。 packages/mio-cli/README.md - 升级提示： >=0.3.6 → >=0.5
- 2026/9/12 14:19:41 | success | 发布完成，6 个包全部上线 npm 并回查验证通过。 | 包 | 版本 | 状态 |
| | | |
| mio-agent-runtime | 0.5.17 
- 2026/9/12 14:11:57 | success | 这轮推进的是 发版前验证 ——「可复用」验证到 pack 出来能装、装上能跑才算数。两路验证全绿。 ① mio-cli verify:pack-install 
- 2026/9/12 14:10:01 | success | 沙箱里 node spawnSync 找不到 cmd.exe 。改用 npm.cmd 直调（与 verify 脚本的 npmInvocation 同思路）：
- 2026/9/12 10:01:51 | success | 复用改造收官（提交 a4ebab04 ）。 analysis + messaging 通用层 npm 面就绪 ，零代码改动、纯构建配置。 本批成果 - mess
- 2026/9/12 09:48:53 | success | 第二批解耦收尾，但有个重要发现改变了判断。 完成：agent-persona 解耦（ fdf1a6c2 ） - 同模式 runtime.ts（ AGENT_PE
<!-- MIO_CONTEXT_END -->
