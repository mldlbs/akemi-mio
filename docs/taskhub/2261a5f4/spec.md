# memory.record 可选 hypothesisId（Task 2261a5f4）

## 文档信息

| 项 | 值 |
| --- | --- |
| 文档 | spec · memory.record.hypothesisId 标签注入 |
| 任务 | 2261a5f4（run f6d68bef） |
| 来源 | 想法 b19bada4 · 设计讨论 1d2e22e4（D3 证据轴）· 前置任务 d0f28f06（adopt 工具） |
| 日期 | 2026-10-09 |
| 状态 | approved |
| 关联 | plan：docs/taskhub/2261a5f4/plan.md |

## 模块职责与边界

**做**：`memory.record`（MCP 参数 / CLI `--hypothesis-id` flag）新增可选 `hypothesisId`；存在时自动并入 `tags` 为 `hypothesis:<uuid>`（幂等、不落成记录字段），与既有 tags AND 检索互通；AGENTS.md Mio Usage Rules 注入「采用假设做决策时 memory.record 必带 hypothesisId」规范。

**不做**：不校验 hypothesis 是否存在于 CreativityStore（写侧不做读侧查询，adopt 工具才是强制点，D4）；不改 memory.query / archive / merge / migrate；不传参数时行为与记录形状字节不变（回归钉住）。

## 详细设计

- `server/memory-store.js` `recordMemory`：`hypothesisId = String(args.hypothesisId||'').trim()`；非空则向 `normalizeTags(args.tags)` 结果 push `hypothesis:<id>`（已存在不重复）；record 构造不变、无新字段。
- MCP `index.js`：`mio.memory.record` inputSchema 增加 `hypothesisId`（string，optional；required 仍 `['content']`），case 不变（args 直通）。
- CLI `bin/mio.js` `rememberCommand`：`--hypothesis-id` flag 经 optionValue 读取，防吞后续 `--json`（以 `--` 开头的 token 视为缺省）；usage 行同步。
- `AGENTS.md` Mio Usage Rules 第 2 条后新增规范 bullet（含 CLI 等价写法）。
- 与 adopt 的闭环：record 注入的标签 = `mio.creativity.adopt`（任务 d0f28f06）强制回查的标签，`memory.query` tags AND 即证据读侧入口。

## 测试

1. memory-store 单测：注入 tags 顺序/幂等/不落字段/无参 legacy 形状 keys+tags 不变/AND 过滤命中与 miss。
2. CLI memory-command：`--hypothesis-id` 落盘标签 + 无 flag 记录 legacy 形状。
3. MCP memory-query：schema 暴露 + callTool 注入 + 无参零注入 + query tags AND 命中/miss。

## 验收

- 三文件测试绿；mio-cli 全量绿；coverage/mcp-live 52 不回退；cli-docs/lint/format 绿。
