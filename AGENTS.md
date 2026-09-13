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
- 2026/9/13 09:50:36 | success | 52/52 通过。跑全量回归确认没破坏别的东西：
- 2026/9/13 09:46:17 | success | main 层测试用的是源码文本断言（因为 AppRuntime 依赖太重）。但对 Lifecycle 的形态逻辑，我可以做得更扎实——真正 import 并 m
- 2026/9/13 09:43:25 | success | App 恢复 16/16，新 hook 9 个全绿。跑全量确认。
- 2026/9/13 09:41:14 | success | Exactly my 5 files staged. Let me wait for verify:pack-install to finish before 
- 2026/9/13 09:40:45 | success | Let me confirm the gate passed ( "ok": true ):
- 2026/9/13 09:35:12 | success | zustand v5 的 subscribe((state) => ...) 签名正确。我给这个新 hook 补个测试——它用"订阅"替代"逐点调用"，值得验证
<!-- MIO_CONTEXT_END -->
