# 实现计划 — mio.creativity.adopt（Task d0f28f06）

## 文档信息

| 项 | 值 |
| --- | --- |
| 文档 | plan · adopt 工具实现计划 |
| 任务 | d0f28f06（run 5652a2a4） |
| spec | docs/superpowers/specs/2026-10-09-creativity-adopt-design.md（质量 100） |
| 日期 | 2026-10-09 |
| 分支 | task-d0f28f06（已建，基于 master d0b4fe6） |

## 目标

按 spec 实现 `mio.creativity.adopt`（MCP + CLI 双宿主、同一共享函数），4+1 边界测试绿，coverage/mcp-live/cli-docs 三门禁到 52。

## 步骤

1. **共享函数**（server/creativity-engine.js）：导出 `adoptHypothesis(engine, args, ingest, dataRoot)`——非空校验 → store 存在性 → 可选 memory.jsonl 标签回查 → 委托 `ingest({trace_id:'creativity-adopt:<id>:<ts>', event_type:'creativity.adopt', outcome:'success', payload})` → 返回 `{recorded:true, hypothesisId, event}`。失败均发生在事件写入前。
2. **MCP 接线**（server/mio-intelligence-mcp/index.js）：ferment 之后注册 TOOLS schema（required: hypothesisId）；case `mio.creativity.adopt` → `adoptHypothesis(creativityEngine, args, ingestObservation, dataDir)`。
3. **CLI 接线**（bin/mio.js）：`creativityCommand` 加 `adopt` 分发 → `creativityAdoptCommand`（positional id + `--memory-id/--task-id/--note/--json`，缺 id 打 usage、exitCode 1）；`creativityUsage()` 加行。
4. **门禁锚点**：check-mcp-cli-coverage.cjs `MCP_TO_CLI` 加映射；README 命令块加 `mio creativity adopt` 行 + 正文提及 `mio.creativity.adopt`。
5. **测试**（__tests__/creativity.test.js）：spec「测试」节 4+1（含 generate 前后 memory.jsonl 字节数不变）。
6. **验证**：`npm test`（mio-cli，node --test 两目录）、`npm run check`、`node scripts/check-mcp-cli-coverage.cjs`、`node scripts/check-cli-docs.cjs`、`node scripts/check-mcp-tools-live.cjs`、`node scripts/check-syntax.cjs` 已含于 check；lint:scripts（若动 scripts/）与 format:check。
7. **收尾**：心跳 → commit（无 BOM，UTF-8 no BOM）→ doc status（spec/plan approved）→ taskhub_submit_result。

## 验证清单（完成标准）

- [ ] 新测试 4+1 绿且旧用例不回归（mio-cli test 全量）
- [ ] check:coverage 输出 `MCP tools: 52 | with a CLI entry: 52 | documented: 52`
- [ ] check:mcp-live 52 存活 / crashed 0
- [ ] check:cli-docs 全部 README 命令 resolve
- [ ] `mio creativity adopt`（无参）打印 usage 且 exit 1；带未知 id 报 `no stored hypothesis`
- [ ] git status 干净提交于 task-d0f28f06

## 风险与回退

- 心跳超时（attempt 1 已踩）：每个工具批至少一次 taskhub_heartbeat。
- cli-docs 探针 crash marker：adopt 无参必须走 usage 分支，不许裸抛未捕获异常（creativityCommand 内 catch error.message）。
- memory.jsonl 缺文件：读侧 `fs.existsSync` 判空 → 记录不存在错误路径。
