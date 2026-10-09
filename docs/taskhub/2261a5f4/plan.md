# memory.record hypothesisId 实施计划（Task 2261a5f4）

## 文档信息

| 项 | 值 |
| --- | --- |
| 文档 | plan · memory.record.hypothesisId |
| 任务 | 2261a5f4（run f6d68bef） |
| 日期 | 2026-10-09 |
| 状态 | approved |
| 关联 | spec：docs/taskhub/2261a5f4/spec.md |

## 模块职责与边界

按 spec 实现并门禁验证；不扩大范围（不加写侧存在性校验、不动 query/archive/merge/migrate）。

## 详细设计（执行步骤）

1. `server/memory-store.js` `recordMemory`：hypothesisId → `hypothesis:<id>` tag 注入（幂等、无新字段、无参路径字节不变）。
2. MCP `index.js`：`mio.memory.record` inputSchema 加 `hypothesisId`（required 不变）。
3. `bin/mio.js` `rememberCommand`：`--hypothesis-id`（`--` 开头 token 视为缺省）+ usage 行。
4. `AGENTS.md` Mio Usage Rules 注入规范 bullet（CLI 等价写法 `mio remember ... --hypothesis-id`）。
5. 测试：`__tests__/memory-store.test.js` 单测、`__tests__/memory-command.test.js` CLI 回归、`server/mio-intelligence-mcp/__tests__/memory-query.test.js` schema+注入+AND 检索。
6. 门禁：mio-cli `npm test` + `npm run check`；`check:coverage` / `check:mcp-live`（52 不回退）；`check:cli-docs`；`lint:scripts` / `format:check`。
7. 提交（无 BOM commit message，排除 AGENTS/CLAUDE 注入脏区）→ taskhub_submit_result。

## 验收

- 新增 3 测试文件内用例全绿 + mio-cli 全量绿 + 五门禁绿。
