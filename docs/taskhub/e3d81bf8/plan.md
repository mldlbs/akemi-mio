# 实现计划：store 跨日去重（e3d81bf8）

## 文档信息

| 项 | 值 |
| --- | --- |
| 文档 | plan · P3 实现步骤 |
| 任务 | e3d81bf8（run b84a141c，分支 task-e3d81bf8 ← task-3b739d6e @5221a29） |
| 关联 | spec：docs/taskhub/e3d81bf8/spec.md |
| 状态 | approved |

## 步骤

1. `packages/observer/src/ObserverStore.ts`：
   - 模块级导出 `normalizeForDedup(content)`；`fingerprint()` 改用它；
   - `store()` 收集近 7 日窗口指纹（循环 `loadDaily`，日期回退用日期算术）+ 批内递增去重；
   - `skipped>0` 时 `log('INFO','store_dedup',{skipped,stored,windowDays:7})`。
2. 新增 `tests/main/observer/__tests__/StoreDedup.test.ts`（7 组，mkdtemp + 手工昨日文件 + mock logger）。
3. 镜像同步：node 脚本整文件复制 + 替换 `import { log } from './logger'` → `import { log } from '@akemi-mio/core/logger/Logger'`（实测镜像仅该行差异）；diff 复核 = 1 行。
4. 门禁：定向 vitest → `npm test` → `npm run typecheck` → `npm run format:check` → `npm run coverage`（≥22/22/17/21）。
5. 交付：spec/plan approved + doc_paths + ReadEvidence → commit（不含 CLAUDE.md/issue6.md）→ gitref → submit → memory/observer 落档。

## 风险

- **语义变化面**：指纹从精确改规范化后，历史「空白恰不同」的合法条目会被判重——风险极低（同 source 同文本仅差空白/标签者本即同一条目），且正是 issue 要求。
- 7 日窗口每 store 读 7 文件：缺文件 existsSync 短路；测试用 mkdtemp 隔离，不污染 `.local/observer`。
- 日期回退跨月/跨年：沿用 `loadDaily(YYYY-MM-DD)` 字符串，用 `d.setDate(d.getDate()-1)` 递减（与 readRecent 同款写法），无格式化坑。
- 老 store 测试若存在对精确指纹的隐式依赖：全量 vitest 兜底暴露。
