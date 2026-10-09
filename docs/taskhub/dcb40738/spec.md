# 读侧 join 派生 adopted 计数（Task dcb40738）

## 文档信息

| 项 | 值 |
| --- | --- |
| 文档 | spec · creativity 读侧 adoption join |
| 任务 | dcb40738（run 3a0203de） |
| 来源 | 想法 b19bada4 · 设计讨论 1d2e22e4（D3 读侧）· 前置任务 d0f28f06（adopt 事件）+ 2261a5f4（memory 标签） |
| 日期 | 2026-10-09 |
| 状态 | approved |
| 关联 | plan：docs/taskhub/dcb40738/plan.md |

## 模块职责与边界

**做**：`CreativityEngine.status()` 新增 `adoption` 块（`adopted`/`claimed`/`evidenced` 三计数 + `metric:false` 标注 + routeAdoption 式 `sources`）；`list()` 每行新增 `adopted: boolean`；CLI 文本模式同步展示；MCP `mio.creativity.status` / `mio.creativity.list` 工具描述补证据链说明；README「创意引擎」新增证据链小节（两轴语义 + 读侧 join + 非指标声明）。

**不做**：adoption rate / 阈值 / 门禁（D3 明确不做）；不改 store（无 `adopted` 状态写入）；不改 generate/ferment/adopt 写路径；不做 project 过滤（status/list 本就无 project 参数，计数按数据根全量）；不新增工具或命令（工具数 52、README 命令数 57 不变）。

## 详细设计

- **join 语义（两轴）**：轴一 = `traces.jsonl` 中 `event_type === 'creativity.adopt'` 的事件，`payload.hypothesisId` 即**声称**（claim，任务 d0f28f06 写入）；轴二 = `memory.jsonl` 记录 `tags` 中 `hypothesis:<id>` 前缀标签，即**证据**（evidence，任务 2261a5f4 注入）。读侧函数 `readAdoptionEvidence(rootDir)` 返回两个 distinct id 集合。
- **数据根推导**：`rootDir = path.dirname(this.dataDir)`——引擎位于 `<dataRoot>/creativity` 的约定已由 `adoptHypothesis` 文档化（MCP：`path.join(dataDir,'creativity')`；CLI：`path.join(MIO_HOME,'creativity')`），两侧 dirname 均得到持有 memory.jsonl / traces.jsonl 的目录。缺失文件经 `readJsonl` 安全返回 `[]`。
- **status 形状**（新增字段，既有字段不变）：
  ```js
  adoption: {
    adopted: n,      // (claimed ∪ evidenced) ∩ 存储假设 id 的基数——inner join
    claimed: n,      // creativity.adopt 事件中的 distinct id（原始，可含已不存在的 id）
    evidenced: n,    // memory 标签中的 distinct id（原始，可含悬空 id）
    metric: false,   // 派生 join、信息性计数——不是 ADR-017 指标
    note: '...',     // 无 rate / 无阈值的原因
    sources: {       // routeAdoption 模式（evaluation-store.js:187）
      events: { file: 'traces.jsonl', durable: true },
      memory: { file: 'memory.jsonl', durable: true },
    },
  }
  ```
  原始计数与 join 计数并报：`claimed/evidenced` 能数出悬空 id，`adopted` 才是「存储中的假设被采用」——与 routeAdoption「0% 与 不可测要能区分」同一意图。
- **list 行**：`adopted: boolean`，`true` 当且仅当该行 id ∈ (claimed ∪ evidenced)；sort=novelty 路径同样附带；`listRow()` 保持纯存储行形状不变，装饰发生在 `engine.list()`。
- **CLI 文本**：`printCreativityStatus` 在计数行后输出 `adoption: N adopted (events=N, tags=N) — derived join, not a metric`；`printCreativityList` 行首在 `[status]` 后追加 ` [adopted]`（仅 true）。JSON 输出即引擎结果，自动包含新字段。
- **MCP 工具描述**：`mio.creativity.status` 追加 adoption join 与 sources 说明；`mio.creativity.list` 追加 `adopted` 标志说明。不改 inputSchema（status 空参数、list 参数不变）。
- **README**：「创意引擎」章节在说明列表后新增 `### 采用证据链（adopt / status / list）` 小节：两轴语义（事件=声称、标签=证据、store 状态=评审轴，三者分离）、读侧 join 公式、`sources` 与非指标声明、`AGENTS.md` 规范指针（memory.record 带 hypothesisId）；status 示例输出同步加 adoption 行。

## 测试

1. **CLI 级（creativity-command.test.js，每例独立 MIO_HOME，精确计数）**：种子 2 个存储假设 + 写入 1 条 adopt 事件（命中 h1）+ 1 条悬空事件（ghost）+ 1 条带标签 memory（命中 h2）+ 1 条悬空标签 → `adopted=2, claimed=2, evidenced=2`、`metric===false`、`sources` 文件与 durable 断言；list 行 `adopted` 标志逐一核对（事件命中/标签命中/无证据三态）；空存储（无 traces/memory 文件）→ 全零不崩 + 文本模式既有输出不回归。
2. **MCP 级（creativity.test.js，共享 dataDir，delta 断言）**：`callTool('mio.creativity.status')` 前后基线差值验证 adoption 块经工具面透出；`mio.creativity.list` 行含 `adopted` 布尔；TOOLS 中 status/list 描述含证据链关键词。
3. **文本模式**：status 文本含 `derived join, not a metric`；list 文本含 `[adopted]` 标记。

## 验收

- 全量门禁绿：mio-cli test、root vitest、typecheck、cli-docs、mcp-live、coverage、lint、format。
- 文档（本 spec + README + MCP 描述）含两轴/证据链说明；计数带 `sources` 标注。
