# insight 输入按来源配额抽样（Task 4f0efeb8 · issue #6 P4）

## 文档信息

| 项 | 值 |
| --- | --- |
| 文档 | spec · 来源配额抽样 |
| 任务 | 4f0efeb8（run a543e6ea）· issue #6 问题4 |
| 日期 | 2026-10-09 |
| 状态 | approved |
| 关联 | plan：docs/taskhub/4f0efeb8/plan.md |
| 基线 | 分支 task-4f0efeb8（← task-e3d81bf8 @1b022fe，含 P1-P3）；依赖任务 b564e432/3b739d6e 已完成 |

## 模块职责与边界

`sourceQuota.ts` 职责：给定近 3 天观察列表与窗口上限，产出「每活跃来源保底、余量按池占比」的确定性抽样结果，只做纯计算不做 IO、不改任何落库数据。不做：采集调度、去重、TrendEngine/TensionField 的输入筛选、DeepResearchEngine 的 prompt/阶段逻辑；不改 `Observation.source` 的存储语义（RSS feedUrl 仍原样落库，折叠只发生在抽样分组键）。`ObserverService` 只负责把抽样结果接入唯一组装点并记一条观测日志。

## 根因（已对码）

- 唯一组装点：`ObserverService.ts:159` `readRecent(3)`（按时间近 3 天**全量**，新日在前）直接 `.map` 成字符串传入 `DeepResearchEngine.research`，其 `L29 slice(0, 30)` 只取数组前 30 条。
- 后果：输入序 = [今日(追加序), 昨日, 前日]，高频源（bilibili/douyin 30m-1h 一采）+ RSS **17 个 feedUrl 各自为独立 source** 刷满前 30，GH/HN 挤不进 → 4 条洞察 3 条错配。
- `research.research()` 全仓唯一调用点即此（已 grep，packages/mio-cli 的 `store.research` 是记忆检索，无关）。

## 详细设计

新增纯函数模块 `packages/observer/src/sourceQuota.ts`（仅 `import type { Observation }`，无 IO）：

- `sourceFamily(source: string): string`：`/^https?:\/\//` 匹配 → `'rss'`（折叠 17 个 feedUrl 为一个家族），否则原样返回。所有 collector 的 source 均为 collector name（已核实 Bilibili/Douyin/Weibo `this.name`，RSS 为 feedUrl）。
- `sampleBySourceQuota(observations, limit = 30, minPerSource = 5): Observation[]` 算法（全程确定性、无随机）：
  1. `obs.length <= limit` → 原序全量返回（快路径，行为与旧版等价）。
  2. 按输入序分组 `Map<family, {idx, obs}[]>`（家族首现序即优先序）。
  3. 自适应配额：`quota = minPerSource`；若 `家族数 × quota > limit` 则 `quota = floor(limit / 家族数)`（≥1）——家族过多时保底均分，防 Phase A 爆窗。
  4. Phase A（保底）：每家族取其组前 `min(quota, 组长)` 条 → GH/HN 只要有 ≥1 条必进（验收核心）。
  5. Phase B（余量按池占比）：`remaining = limit - 已选`；各家族余池 `pool_i = 组长 - 已取_i`；按 `floor(remaining × pool_i / totalPool)` 比例分配，最大余数法补齐且不超 `pool_i`（`remaining < totalPool` 恒成立，+1 不会越界）——余量分布 ≈ 输入（当天采集）分布。
  6. 选中集合按**原始输入下标**排序返回（保持时间序）。
- `ObserverService.ts:159` 改为：
  ```ts
  const sampled = sampleBySourceQuota(this.store.readRecent(3), 30, 5)
  const obs = sampled.map((o) => `[${o.source}] ${o.content}`)
  log('INFO', 'research_obs_sampled', { total: ..., sampled: sampled.length, families: <去重家族列表> })
  ```
- **`DeepResearchEngine` L29 `slice(0,30)` 保留**为防御性上限（入参已是 ≤30 的抽样结果，不会截断），不改引擎（唯一调用方已由组装层保障，改动面最小）。

**涉及文件清单**：`packages/observer/src/sourceQuota.ts`（新）、`packages/observer/src/ObserverService.ts`（改 L159）、`tests/main/observer/__tests__/SourceQuotaSampling.test.ts`（新）、镜像包同名三文件（见镜像同步）。

## 不做

- `TrendEngine`/`TensionFieldEngine` 各自的读取路径（它们按关键词打分，非纯时间窗问题）；`readRecent(3)` 天数；引擎 prompt/阶段逻辑；collector 采集频率。

## 镜像同步

- `sourceQuota.ts`：纯函数仅 `import type './types'`（镜像 types 逐字节同）→ 整文件复制即可，预期 diff = 0。
- `ObserverService.ts`：镜像与原文件存在注释措辞差异（153 行 diff 实测，起点 L1/L58/L179）但 L159 组装行**逐字节相同** → 对两文件用相同 oldString 各自局部编辑，禁整文件覆盖。

## 测试

新增 `tests/main/observer/__tests__/SourceQuotaSampling.test.ts`（直测纯函数）：

1. **刷屏对抗**：100 条（bilibili 45 + douyin 30 + rss 20 + gh 3 + hn 2）→ 输出恰 30，gh/hn 全进（≥1），bilibili+douyin 占比 < 100%（不再纯娱乐源窗口）。
2. **单源等价**：单一 source 100 条 → 输出与 `slice(0,30)` 逐条相等（回归：无多样化需求时行为不变）。
3. **RSS 折叠**：17 个 feedUrl + gh/hn/bili/douyin → 家族仅 5 个，rss 不吃光配额（每家族保底 5 且总数 30）。
4. **自适应配额**：8 家族 × 5 > 30 → `floor(30/8)=3` 生效，输出 ≤30 且每家族（有量者）≥min(3, 组长)。
5. **时间序保持**：输出下标为输入下标的递增子序列。
6. **小输入全量**：`length < limit` → 原序全量、无重复无丢失。
7. `sourceFamily` 直测：http/https/无协议 URL → 'rss'，普通名原样。
8. 空输入 → `[]`。

## 验收

- 窗口来源分布 ≈ 当天采集分布（Phase B 按池占比）；GH/HN 有量则占比 >0；无纯 bilibili+douyin 窗口。
- 新单测 + 根 vitest + typecheck + format 绿；覆盖率棘轮不退；镜像同步 diff 核对（sourceQuota=0、ObserverService 保持既有差异模式）。
