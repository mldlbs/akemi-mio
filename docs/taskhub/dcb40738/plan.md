# 实现计划：读侧 adoption join（dcb40738）

## 文档信息

| 项 | 值 |
| --- | --- |
| 文档 | plan · 读侧 join + 文档 + 全量门禁 |
| 任务 | dcb40738（run 3a0203de，分支 task-dcb40738 = e0990c8 + bf06c7c） |
| 关联 | spec：docs/taskhub/dcb40738/spec.md |
| 日期 | 2026-10-09 |
| 状态 | approved |

## 步骤

1. **engine（server/creativity-engine.js）**
   - 引入 `readJsonl`（memory-store 导出，无循环依赖）；新增 `ADOPTION_TAG_PREFIX`、`ADOPTION_SOURCES`（冻结）、`readAdoptionEvidence(rootDir)`。
   - 构造器保存 `this.dataDir`；新增 `_adoption()`：root = dirname(dataDir) → 两集合 → 与 `store.getHypotheses()` 全量 id 求交得 adoptedIds。
   - `status()` 增 `adoption` 块（三计数 + metric:false + note + sources），其余字段顺序/形状不变。
   - `list()` 两条路径（novelty 排序与默认）统一给行加 `adopted: boolean`；`listRow()` 不动。
2. **MCP（server/mio-intelligence-mcp/index.js）**
   - `mio.creativity.status` / `mio.creativity.list` description 追加证据链与 adopted 标志说明；case、schema 不动。工具数不变（52）。
3. **CLI（bin/mio.js）**
   - `printCreativityStatus` 加 adoption 行；`printCreativityList` 加 ` [adopted]` 标记；status 的两处 help 文案同步。
4. **README（packages/mio-cli/README.md，edit 工具）**
   - 「创意引擎」说明列表后插入 `### 采用证据链（adopt / status / list）` 小节；status 示例输出加 adoption 行。不新增命令行 → cli-docs 57 不变。
5. **测试**
   - `__tests__/creativity-command.test.js`：精确计数用例 + list 三态标志 + 空存储零值。
   - `server/mio-intelligence-mcp/__tests__/creativity.test.js`：delta 断言（共享 dataDir 受既有 adopt 用例影响）+ 描述关键词。
6. **门禁（全量）**：`test:mio-cli`、root `vitest run`、`typecheck`、`check:cli-docs`、`check:mcp-live`、`check:coverage`、`lint:scripts`、`format:check`。
7. **交付**：commit 到 task-dcb40738（含本 spec/plan）→ gitref → ReadEvidence → submit_result → memory + observer 落档。

## 风险

- 共享 dataDir 的 MCP 测试既有 adopt 用例会写 traces.jsonl → 本层测试必须用 delta 断言或唯一 id，不能断绝对值。
- status/list 新增键不改既有字段，避免既有 deepEqual 断言回归；text 模式新增行需与 `/No hypotheses yet/` 断言共存（adoption 行置于 early-return 之前或之后都需实测确认不破坏正则）。
- dataDir 父目录推导依赖 `<root>/creativity` 约定——两侧宿主与测试构造均满足，spec 已记录。
