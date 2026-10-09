# Observation 结构化字段：url/metadata + HN story.url 落库（Task 3b739d6e · issue #6 P2）

## 文档信息

| 项 | 值 |
| --- | --- |
| 文档 | spec · Observation 结构化字段 |
| 任务 | 3b739d6e（run 625c7b51）· issue #6 问题2 |
| 日期 | 2026-10-09 |
| 状态 | approved |
| 关联 | plan：docs/taskhub/3b739d6e/plan.md |
| 基线 | 分支 task-3b739d6e（基于 P1 分支 task-b564e432 @8bf46a7） |

## 模块职责与边界

**做**：
1. `packages/observer/src/types.ts`：`Observation` 增加可选 `url?: string`（原文/详情链接）与 `metadata?: Record<string, unknown>`（结构化附加信息），带中文 doc 注释；全部向后兼容（可选字段，老数据无此字段仍合法）。
2. `HackerNewsCollector`：`story.url || item?id 兜底链接` 写入 `url`（现仅用于 seenUrls 即丢）；产出条目 100% 带 url。
3. `RSSCollector`：`item.link` 写入 `url`（无 link 时省略字段，`url: undefined` 序列化即消失；去重键仍用原 `item.link || item.title` 逻辑不变）。
4. `GitHubTrendingCollector`：完整（未截断）清洗后描述写入 `metadata.description`（API 与 fallback 两路径），content 截断仍 100 词边界——兑现 P1 spec 留给 P2 的「保留完整描述到结构化字段」。

**不做**：content 文案结构变更；collector 去重逻辑（P3 的 store 层范围）；insight 抽样（P4）；已有消费者（ObserverStore/ObserverService/TrendEngine/TensionFieldEngine）读写逻辑——它们只用既有四字段，可选字段对其透明，已核实无 zod/shape 校验。

## 详细设计

- 字段命名与语义：`url` 一律为 HTTP(S) 原文链接（HN 兜底 item 页亦算）；`metadata` 仅放单源扩展信息，不放 id/timestamp 等基础字段。
- 兼容性三重保证：(a) TypeScript 可选字段——老对象字面量仍类型合法；(b) 运行时——JSON.parse 老数据得到无新字段对象，下游不读新字段不受影响；(c) 序列化——`url: undefined` 被 JSON.stringify 自然丢弃，不产 `"url":undefined` 垃圾。
- **镜像双写**：`types.ts` 镜像与原文件逐字节相同 → 直接复制；三个 collector 镜像与原文件存在**非平凡差异**（L2 logger 导入 + TS 类型断言写法：镜像用 `const ids: number[] = await ...`、`for (const story of stories)`，原文件用 `as number[]`、`raw as any`）→ **各自本地上下文分别编辑**，禁盲目整文件覆盖；GH collector 在 P1 后镜像仅 L2 差异 → 用 Node UTF-8 脚本整文件复制 + logger 导入替换。

## 测试

新增 `tests/main/observer/__tests__/ObservationStructuredFields.test.ts`（root vitest，`vi.mock` http/logger，alias `@akemi-mio/observer/*`）：

1. HN：mock topstories + item 详情（一条带 `url`、一条无 `url`）→ 两条产出 `url` 均非空（后者为 `item?id=` 兜底），携带率 100%。
2. HN 去重不受影响：同 url 二次采集仍被 seenUrls 过滤。
3. RSS：`new RSSCollector([feed])` mock rss2json（item 带/不带 link）→ 带 link 者 `url===link`，不带者无 `url` 键（`'url' in obs === false`）。
4. GH：API 路径长描述 → `metadata.description` 为完整清洗文本，`content` 为词边界截断版。
5. 老数据兼容：4 字段 JSON.parse 结果直接作为 `Observation` 使用不抛错、新字段为 undefined。

## 验收

- HN 条目携带 url 比例 = 100%；Observation 新字段可选、老数据反序列化不报错。
- 新单测 + 根 vitest + typecheck（node+web）+ format:check 绿；覆盖率棘轮不退。
- 镜像按上文「镜像双写」策略同步，diff 核对：types 逐字节同、collector 仅既有风格差异。
