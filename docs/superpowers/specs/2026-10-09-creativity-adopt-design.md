# mio.creativity.adopt — Adoption 证据链 MVP（Task d0f28f06）

## 文档信息

| 项 | 值 |
| --- | --- |
| 文档 | spec · mio.creativity.adopt 设计 |
| 任务 | d0f28f06（attempt 2，run 5652a2a4） |
| 来源 | 想法 b19bada4（broken_down）· 设计讨论 1d2e22e4（D1-D4）· 用户 2026-10-09 批准 |
| 日期 | 2026-10-09 |
| 状态 | approved |
| 关联 | plan：docs/superpowers/plans/2026-10-09-creativity-adopt.md；同批任务 2261a5f4（memory 标签参数）、dcb40738（读侧计数） |

## 模块职责与边界

**做**：提供 `mio.creativity.adopt` 一个工具，把「某 agent 采用了某条已存储假设」固化为一条 `creativity.adopt` trace 事件，并在调用方给出 `memoryId` 时强制校验该记忆记录携带 `hypothesis:<id>` 标签——即 D4 的单一强制点。

**不做**：不写 Mio memory（adopt 只写 traces）；不改 CreativityStore 状态机（无 `adopted` 状态，D1）；不做 adoption 率指标 / outcome 关联 / 读侧 join 计数（任务 dcb40738）；`memory.record` 的 `hypothesisId` 参数归任务 2261a5f4。边界模糊点提前钉死：**generate/ferment 路径零改动，任何路径都不写 memory.jsonl**。

## 背景与问题

CreativityStore 状态机 `draft → active → validated`（ferment promote 门控 creativity-engine.js:499）只表达 LLM 评审成熟度。validated → 真实采用 → Memory 沉淀之间无可追踪记录：无 adopt 命令/状态/事件，CreativityStore 与 memory.jsonl 永久无法关联——与 route adoption「hit 无 reuse 不算 adoption」（evaluation-store.js:156）同构的证据链断裂。

## 设计决策（讨论 1d2e22e4）

- **D1** 采用 B+C 组合：observer 事件 `creativity.adopt` 作「声称」载体，memory 记录 `hypothesis:<id>` 标签作「证据」载体；**store 状态 `adopted` 否决作真值**（自报即真、单值丢上下文、与 validated 混轴），将来若需要只做 join 派生投影。
- **D2** 两轴分离：评审轴（store status）不动；证据轴在 store 外，唯一 join 键为 hypothesis UUID，事件/记忆单向引用 store。
- **D4** 强制点收敛到工具校验，不靠 agent 自觉。

## 详细设计

### 工具契约

```
mio.creativity.adopt(hypothesisId: string(required), {
  memoryId?: string,   // 关联的记忆记录 id；给定则强制校验标签
  taskId?:  string,    // 可选：采用该假设的任务
  note?:    string     // 可选：采用理由
})
```

### 执行时序（失败均发生在写事件之前，事件流不被失败调用污染）

1. `hypothesisId` 非空校验 → `mio.creativity.adopt requires hypothesisId: a stored hypothesis UUID`
2. store 存在性校验（creativity-hypotheses.jsonl 按 id 精确匹配）→ `no stored hypothesis with id "<id>"`
3. 若带 `memoryId`：读 `<dataRoot>/memory.jsonl`，记录必须存在且 `tags` 含 `hypothesis:<hypothesisId>` → 否则 `memory record <id> is missing tag hypothesis:<id>`
4. 经宿主 `ingestObservation` 写 trace：`event_type='creativity.adopt'`、`trace_id='creativity-adopt:<id>:<ts>'`、`outcome:'success'`、payload = `{ hypothesisId, memoryId?, taskId?, note? }`
5. 返回 `{ recorded: true, hypothesisId, event }`

### 共享函数与宿主接线

`adoptHypothesis(engine, args, ingest, dataRoot)` 导出自 `server/creativity-engine.js`（同一实现两处复用）：

- **MCP**（server/mio-intelligence-mcp/index.js）：case `mio.creativity.adopt` → `adoptHypothesis(creativityEngine, args, ingestObservation, dataDir)`；TOOLS 数组在 ferment 之后注册 schema。
- **CLI**（bin/mio.js）：`mio creativity adopt` → `adoptHypothesis(cliCreativityEngine(), args, cliTaskStore().ingestObservation, MIO_HOME)`。

dataRoot 约定：memory/traces 所在目录（MCP=MIO_DATA_DIR、CLI=MIO_HOME），engine 位于 `<dataRoot>/creativity`（bin/mio.js:408 既有注释）。

### CLI 入口与文档锚点（check:coverage 强制）

- scripts/check-mcp-cli-coverage.cjs `MCP_TO_CLI` 新增 `'mio.creativity.adopt': ['creativity', 'adopt']`
- `mio creativity adopt <hypothesisId> [--memory-id id] [--task-id id] [--note text] [--json]`；缺 id 走 usage 报错（exitCode 1，不含 "Unknown"，无 crash marker → cli-docs 探针安全）
- `creativityUsage()` 列出 adopt；README 命令块加 `mio creativity adopt` 行、正文提及工具名 `mio.creativity.adopt`（coverage 的 documented 检查）

### 涉及文件清单

| 文件 | 改动 |
| --- | --- |
| packages/mio-cli/server/creativity-engine.js | 导出 `adoptHypothesis`（校验 + 事件委托） |
| packages/mio-cli/server/mio-intelligence-mcp/index.js | TOOLS 注册 + case 分发 |
| packages/mio-cli/bin/mio.js | `creativity adopt` 子命令 + usage |
| scripts/check-mcp-cli-coverage.cjs | MCP_TO_CLI 映射 |
| packages/mio-cli/README.md | 命令块行 + 工具名提及 |
| packages/mio-cli/server/mio-intelligence-mcp/__tests__/creativity.test.js | 4+1 边界测试 |

## 测试

1. 缺 hypothesisId → rejects `/requires hypothesisId/`
2. 未登记 id → rejects `/no stored hypothesis/`
3. memoryId 指向不存在记录 → rejects `/no memory record/`；指向无标签记录 → rejects `/missing tag/`
4. 合法路径：seed 带标签 memory + seed hypothesis → `recorded=true`，traces.jsonl 恰新增 1 行 `creativity.adopt`，payload 含 hypothesisId
5. 边界钉死：generate（refused LLM harness）前后 memory.jsonl 字节数零变化

## 验收

- 边界测试全绿；mio-cli test 全量绿
- `check:coverage`：MCP tools **52** | with a CLI entry 52 | documented 52
- `check:mcp-live`：52 工具存活、crashed 0
- `check:cli-docs` 绿
- generate/ferment 不写 Memory 测试钉住

## 非目标（后置）

adoption 率指标、adopt→task_outcome 关联、store `adopted` 投影、`memory.record.hypothesisId`（2261a5f4）、读侧 join 计数与 README 证据链文档（dcb40738）。
