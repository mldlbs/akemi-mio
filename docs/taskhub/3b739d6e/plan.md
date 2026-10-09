# 实现计划：Observation 结构化字段（3b739d6e）

## 文档信息

| 项 | 值 |
| --- | --- |
| 文档 | plan · P2 实现步骤 |
| 任务 | 3b739d6e（run 625c7b51，分支 task-3b739d6e ← task-b564e432 @8bf46a7） |
| 关联 | spec：docs/taskhub/3b739d6e/spec.md |
| 状态 | approved |

## 步骤

1. `packages/observer/src/types.ts`：Observation 加 `url?` / `metadata?`（中文注释）。
2. `HackerNewsCollector.ts`：push 增 `url`（L51 已有 url 变量）。
3. `RSSCollector.ts`：push 增 `url: item.link || undefined`。
4. `GitHubTrendingCollector.ts`：两路径增 `metadata: { description: <完整清洗描述> }`（API 路径 map 内先算 title/description 局部变量复用）。
5. 新增 `tests/main/observer/__tests__/ObservationStructuredFields.test.ts`（5 组用例，见 spec）。
6. 镜像同步：
   - types.ts：node 整文件复制（原=镜像同基线）；
   - GH collector：node 复制 + L2 logger 替换（复用 sync-mirror 模式）；
   - HN/RSS collector：**各自本地编辑**（镜像有类型断言风格差异，不可整文件覆盖）。
7. 门禁：定向 vitest → `npm test` → `npm run typecheck` → `npm run format:check` → `npm run coverage`（棘轮 lines 22/functions 22/branches 17/statements 21）。
8. 交付：spec/plan approved + doc_paths + ReadEvidence → commit（不含 CLAUDE.md/issue6.md）→ gitref → submit → memory/observer 落档。

## 风险

- 镜像覆盖事故：HN/RSS 镜像与原文件有真实风格差异，必须逐文件本地编辑，覆盖会引入无关 diff——步骤 6 强制区分两类同步方式。
- `url: undefined` 泄漏：RSS 无 link 时用 `|| undefined`，序列化后不落键；测试断言 `'url' in obs === false`。
- 可选字段对下游透明性：ObserverStore JSON 往返、TrendEngine 只读 content/source——typecheck 兜底。
- HN mock 时序：Promise.all 批量 item 请求需按 URL mockImplementation 而非简单 mockResolvedValueOnce 链。
