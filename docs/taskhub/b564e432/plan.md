# 实现计划：GH Trending 采集清洗（b564e432）

## 文档信息

| 项 | 值 |
| --- | --- |
| 文档 | plan · P1 清洗实现步骤 |
| 任务 | b564e432（run c44370aa，分支 task-b564e432 基于 master 6ac16f3） |
| 关联 | spec：docs/taskhub/b564e432/spec.md |
| 状态 | approved |

## 步骤

1. 改 `packages/observer/src/collectors/GitHubTrendingCollector.ts`：
   - 新增并导出 `truncateAtWord(text, max=100)`、`validRepoPath(raw)`；
   - API 路径：title/desc 过 stripHtml、空标题丢弃、desc 词边界截断；
   - fallback：href 全局扫描 + validRepoPath 校验，非法 article 跳过；desc 词边界。
2. 新增 `tests/main/observer/__tests__/GitHubTrendingCollector.test.ts`（helper 直测 + 两条路径 mock 行为测试）。
3. 镜像同步：node UTF-8 脚本把实现写入 `packages/intelligence-observer/src/collectors/GitHubTrendingCollector.ts`（保留其 `../logger` 导入差异），diff 核对仅 logger 行不同。
4. 门禁：`npx vitest run tests/main/observer`（定向）→ 全量 `npm test` → `npm run typecheck` → `npm run format:check`（新文件跑 prettier 修正）。
5. 文档/交付：spec/plan approved + doc_paths + ReadEvidence → commit（不含 CLAUDE.md/issue6.md）→ gitref → submit_result → memory + observer 落档。

## 风险

- 覆盖率棘轮（lines 22 / branches 17 等）：新代码 + 新测试净效应需保持不退——测试须覆盖两路径与 helper 全分支。
- vite alias 前缀解析：mock 模块 id 用 `@akemi-mio/observer/http` 与 collector 内 `../http` 必须落到同一文件，否则 mock 不生效。
- 镜像差异仅 logger import：同步脚本须用 Node 读写 UTF-8，禁用 PS Get-Content（会弄坏中文）。
- word 边界回退阈值 `max*0.5`：防无空格长串退化，测试覆盖。
