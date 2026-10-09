# ObserverStore 入库去重（Task e3d81bf8 · issue #6 P3）

## 文档信息

| 项 | 值 |
| --- | --- |
| 文档 | spec · store 跨日去重 |
| 任务 | e3d81bf8（run b84a141c）· issue #6 问题3 |
| 日期 | 2026-10-09 |
| 状态 | approved |
| 关联 | plan：docs/taskhub/e3d81bf8/plan.md |
| 基线 | 分支 task-e3d81bf8（← task-3b739d6e @5221a29，含 P1+P2） |

## 根因精化（对照代码后修正 issue 表述）

`ObserverStore.store()` **已有同日去重**（L81-97：`fingerprint = source::content` 精确匹配、仅查**今天**的 daily 文件）。真实缺口有三：

1. **跨日窗口缺失**：dedup 只查今日文件。GH 每 4h 重采，跨零点后（或隔天重采）同内容落入新日期文件 → 24h 窗口（跨 2 个日文件）及 issue 观察到的 7 天窗口内重复入库。
2. **批内重复未防**：单次 `store(observations)` 数组内部若含同指纹条目，`filter` 只对已存在集合查，不过滤批内互撞。
3. **指纹不规范化**：老数据 content 带 HTML/多空白（P1 前产物），与 P1 后同条目的清洗版 content 精确不等 → 规范化后才可互相命中（issue 要求 stripHtml+去空白归一）。

## 详细设计

- `normalizeForDedup(content): string`（模块级导出纯函数）：`content.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()`。
- `fingerprint(obs)`：`` `${obs.source}::${normalizeForDedup(obs.content)}` ``。
- `store()` 算法：
  1. 空数组早退；`ensureDir`；`date = today()`；`loadDaily(date)`。
  2. 建窗口指纹集合 `fps`：`d = new Date()`，循环 7 次——`loadDaily(fmt(d)).observations` 逐条 `fps.add(fingerprint(o))`，`d.setDate(d.getDate()-1)`（缺文件 `loadDaily` 返回空，`existsSync` 短路）。
  3. 批内过滤：`newOnes = observations.filter(o => { const f = fingerprint(o); if (fps.has(f)) { skipped++; return false } fps.add(f); return true })`——先到先留，同时防批内互撞与对窗口的重复。
  4. `newOnes.length === 0` 且 `skipped>0` → 记日志后早退；否则 push + 写盘；`skipped>0` 时 `log('INFO','store_dedup',{skipped,stored,windowDays:7})`。
- 涉及文件清单：`packages/observer/src/ObserverStore.ts`（改）、`tests/main/observer/__tests__/StoreDedup.test.ts`（新）、`packages/intelligence-observer/src/ObserverStore.ts`（镜像同步）。

## 模块职责与边界

**做**（全部在 `packages/observer/src/ObserverStore.ts`）：
1. `fingerprint()` 规范化：`source::normalize(content)`，`normalize = 去 <[^>]*> 标签 + \s+→单空格 + trim`（模块级导出纯函数 `normalizeForDedup`，供单测直测）。
2. `store()` 指纹集合改为**近 7 日窗口**（今日 + 前 6 日，缺文件按空），逐日收集指纹，保持现有「全重复则不写盘」语义。
3. **批内去重**：过滤时用已收录指纹同步去重批内互撞（先到先留）。
4. **可观测**：当有条目被去重跳过时 `log('INFO', 'store_dedup', { skipped, stored, windowDays: 7 })`；无跳过不加新日志（避免噪音）。返回值保持 `void`。

**不做**：collector 层 seenUrls（保留作快路径，issue 明示 store 兜底即可）；readRecent/下游消费逻辑；日文件格式；P4 抽样。

**性能边界**：store 每调用读 ≤7 个小 JSON 文件（缺文件 existsSync 短路），数百条量级毫秒级，不做缓存（YAGNI）。

## 测试

新增 `tests/main/observer/__tests__/StoreDedup.test.ts`（`vi.mock` logger；`mkdtemp` 独立 baseDir）：

1. 同日同指纹两次 store → 第二次 0 落盘，readDaily=1 条（守住既有行为）。
2. **跨日**：手工写昨日 `observations/<yesterday>.json` 含条目 X → 今日 store X → 今日文件不产生（或 0 新增）。
3. 批内重复：`store([a, a'])`（a' 仅空白/HTML 差异）→ 落盘 1 条。
4. 规范化互认：老式 `【GitHub】<b>x</b>` vs 新式 `【GitHub】x` 同 source → 后者被跳过。
5. 同 content 不同 source → 均落盘（指纹含 source）。
6. 可观测：触发跳过时 logger 收到 `store_dedup` 且 `skipped≥1`；无重复时不发该事件。
7. `normalizeForDedup` 直测：标签剥离、空白折叠、trim。

## 验收

- 24h 内同 `(source, 规范化 content)` 重复条目 = 0（跨日文件覆盖）；去重命中有日志计数。
- 新单测 + 根 vitest + typecheck + format:check 绿；覆盖率棘轮不退。
- 镜像同步：镜像与原文件仅 L3 logger 导入差异（已实测 1 行）→ Node UTF-8 整文件复制 + `./logger` 导入替换。
