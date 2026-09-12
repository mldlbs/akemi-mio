# 创意点子发酵引擎 + 来源总线 设计

- 日期: 2026-08-12
- 状态: 待评审
- 范围: `src/main/creativity`、`src/main/evolution/automation`、`src/main/db`、`src/main/bootstrap`、`src/main/tool`

## 1. 背景与问题

mio 的创意系统存在两个结构性缺口：

1. **点子没有发酵过程**：创意 hypothesis 生成后以 `draft` 入库，`CreativityCollector` 每 30 分钟直接按分数挑出前 3 条交给 `CreativityExecutor` 实现代码，状态流是 `draft → experimenting`。点子从"出生"到"被实现"之间没有任何沉淀、再评估、交叉、淘汰的环节。
2. **产生来源单一**：正常 cycle 实际使用的动态输入只有 observer trends/insights、evolution 结果、交互次数；其余来源是静态能力描述串；`SourceBuilder`、`GitHubInspiration`、insight 等多样性机制"写了但没接上"。

## 2. 目标与非目标

目标：
- 形成闭环：**多元来源 → 产生 → 发酵 → 筛选 → 实现**。
- 未成熟点子不再可能被直接实现。
- 让已存在但未接入的多样性来源真正进入产生端，且产生端与发酵端共用同一份新信号。

非目标（v1 不做）：
- 不新增独立 UI/管理页；沿用现有工具与日志。
- 不做复杂的分数模型；分数由 LLM 评估 + 简单加权。
- 不引入新的外部数据源 API（除已存在的 GitHubInspiration）。

## 3. 现状分析（证据）

- `CreativityService.cycle()`（`src/main/creativity/CreativityService.ts`）实际来源 = `this.getSources()`（AppRuntime `buildCreativitySources`，`src/main/bootstrap/AppRuntime.ts`）+ `evolutionOutcome` + observer trends/insights（仅作 ExternalSignal）。
- `buildCreativitySources` 中 `Memory` 是空壳（`entryCount = 0`、`recentTopics = []`）；MCP/ASR/TTS/Wallpaper/PiperTTS 为静态介绍串；动态的只有 `UserBehavior` 交互次数与一个 Plan。
- `SourceBuilder`（`src/main/creativity/SourceBuilder.ts`）在 `CreativityService` 中只构造、从不调用（`sourceBuilder.build` 无调用点）。
- `GitHubInspiration.getSources()`（`src/main/inspiration/GitHubInspiration.ts`）接口已实现并注释"注入到创造力引擎"，但 `AppRuntime` 只调了 `refresh()`，结果未接入。
- `insightStore.getUnreported()` 只在 `dreamCycle()` 使用，正常 cycle 不含洞察。
- `CreativityCollector`（`src/main/evolution/automation/CreativityCollector.ts`）过滤条件为 `draft || active`，是"直接实现"的闸门。
- 数据库 `hypotheses` 表（`src/main/db/migration.ts` v1 区域）无发酵相关字段；最新迁移版本为 43。

## 4. 方案总览

```
来源总线 SourceAggregator（模块/行为/观察/外部/失败/反馈 六域）
        │
        ▼
产生（CreativityService.cycle / dreamCycle，复用现有生成器）
        │  新点子 status=draft（= 发酵中）
        ▼
发酵（IdeaFermentationEngine，每 6h，注入来源总线新信号）
        │  promote → status=active（≥2 轮且 ≥24h，每轮上限 3）
        │  keep    → 留在 draft，更新分数
        │  reject  → status=rejected（理由进入失败域反哺产生）
        │  merge   → 合并为新 draft，原两条标 rejected+merged_into
        ▼
筛选（CreativityCollector 只采集 status=active）
        ▼
实现（CreativityExecutor，不变）
```

## 5. 设计 A：创意点子发酵引擎

### 5.1 状态语义（不加新 status）

- `draft` = 正在发酵、未成熟（新点子默认进入）。
- `active` = 发酵合格，唯一允许被采集实现的状态。
- `experimenting / validated / rejected` 不变。

理由：`hypotheses.status` 有 `CHECK(status IN (...))` 约束，SQLite 修改 CHECK 需重建表；复用 `draft` 语义只需 `ALTER TABLE ADD COLUMN`，且存量数据兼容（存量 `draft` 会被下一轮发酵接管）。

### 5.2 数据模型变更（迁移 v44）

`src/main/db/migration.ts` 追加：

```sql
ALTER TABLE hypotheses ADD COLUMN ferment_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hypotheses ADD COLUMN last_fermented_at INTEGER;
ALTER TABLE hypotheses ADD COLUMN ferment_log TEXT;
ALTER TABLE hypotheses ADD COLUMN merged_into TEXT;
```

`Hypothesis` 类型（`src/main/creativity/types.ts`）新增可选字段：

```ts
fermentCount?: number            // 已发酵轮数
lastFermentedAt?: number         // 最近发酵时间戳
fermentLog?: Array<{ at: number; verdict: string; reason: string; score?: { novelty: number; feasibility: number; impact: number } }>
mergedInto?: string              // merge 后的新 hypothesis id
```

### 5.3 IdeaFermentationEngine（新文件 `src/main/creativity/IdeaFermentationEngine.ts`）

输入：
- 候选：`status = 'draft'` 的 hypothesis，按 `novelty + feasibility + impact` 排序取前 20。
- 新信号：来源总线本轮输出（见设计 B），作为发酵上下文。

LLM 发酵 prompt（`chatJsonWithCode || chatJson`，temperature ~0.5）：
- 对每条候选逐条评估：是否有新证据支持/削弱？能否强化？是否成熟到可落地？
- 输出 JSON：`{ results: [{ id, verdict: 'promote'|'keep'|'reject'|'merge', reason, novelty, feasibility, impact, enrichedIdea?, mergeWithId? }] }`

状态流转规则：
- `promote`：要求 `fermentCount >= 2` 且 `createdAt` 距今 ≥ 24h；每轮最多 promote 3 条（防管道洪峰），超出者按分数顺延。
- `keep`：留在 `draft`；分数按 `新*0.6 + 旧*0.4` 混合后 clamp 到 [10,100]；`fermentCount += 1`；`enrichedIdea` 非空则更新 `idea`。
- `reject`：`status = 'rejected'`，理由写入 `fermentLog`，后续作为 `getFailedHypotheses` 输入反哺产生端。
- `merge`：LLM 输出合并后的新 hypothesis（标题/内容/评分），以 `draft` 入库；被合并两条标 `rejected` 并写 `mergedInto = 新 id`。
- 淘汰：`fermentCount >= 6` 仍未升级 → 自动 `rejected`（"放馊了"）。

### 5.4 采集器门禁

`CreativityCollector.collect()` 过滤条件从 `draft || active` 改为**仅 `status === 'active'`**。这是核心闸门：未发酵点子在采集阶段被拦截。

### 5.5 调度与触发

- `CreativityService.start()` 在 TaskRunner 注册 `creativity.ferment`，间隔 `FERMENT_INTERVAL_MS = 6h`（与 dream cycle 对齐，保证信号新鲜）；无 TaskRunner 时走 setInterval fallback，`stop()` 同步清理。
- 新增 `forceFerment()` 公开方法。
- `src/main/tool/definitions/CreativityTools.ts` 新增 `trigger_idea_ferment` 工具（复用 `trigger_ferment` 模式，只读 false）。

### 5.6 失败兜底

- LLM 不可用/超时/JSON 解析失败 → 本轮跳过、保留全部 draft、记日志，不阻塞主流程，不影响其他轮次。
- 单条结果缺失字段 → 该条视为 `keep`，只累计 `fermentCount` 不更新分数。

## 6. 设计 B：来源总线（Source Bus）

### 6.1 来源分域

`CreativitySource.type` 扩展为分域标识（保留原 type 语义兼容）：

| 域 | type | 内容示例 | 接入方式 |
| --- | --- | --- | --- |
| 模块域 | knowledge | 真实运行时指标（ASR 延迟/错误率、TTS 队列、Agent 工具成功率） | 修复 `buildCreativitySources` 静态壳 |
| 行为域 | behavior | 交互记录、活跃话题、高峰时段 | `InteractionTracker.getRecent`、行为模式 |
| 观察域 | insight / provocation | observer trends/insights、用户反馈 | `WorldTrendProvider`、`ObserverStore.readRecentFeedback` |
| 外部域 | knowledge / provocation | GitHub 优秀项目灵感 | `GitHubInspiration.getSources()`（接入） |
| 失败域 | failure | 被拒点子、失败假设、evolution 失败结果 | `getFailedHypotheses`、`evolutionOutcome` |
| 反馈域 | feedback（新增） | 用户显式反馈信号、已实现点子结果 | observer feedback、pipeline 结果 |

### 6.2 SourceAggregator（新文件 `src/main/creativity/SourceAggregator.ts`）

- 统一入口 `build(): CreativitySource[]`，替代 `getSources()` 单点。
- 内部由 provider 列表组成：`{ domain, provider: () => CreativitySource[] }`。
- 多样性采样规则：
  - 每轮至少覆盖 3 个域；不足则允许 2 个域并记日志。
  - 每域最多取 K=4 条（按 weight 降序）。
  - 同域内去重（name 前缀去重）。
- 对空壳/静态内容降权：provider 拿不到真实数据时返回 `weight <= 0.3` 的占位或直接不返回，禁止用静态介绍串冒充动态信号。

### 6.3 接入存量但断开的来源

1. `GitHubInspiration.getSources()` → 注册为外部域 provider（`AppRuntime` 的 inspiration lazyInit 里持有实例并传入）。
2. `insightStore.getUnreported()` → 从仅 dream cycle 提升为正常 cycle 也参与（观察域）。
3. 真·记忆内容 → `MemoryService` 的 `interactionTracker.getRecent()` 与 `summary.getRecent()` 注入行为域/模块域，替换空壳。
4. observer 用户反馈 → `ObserverStore.readRecentFeedback(7)` 注入反馈域。
5. evolution/pipeline 结果 → 反馈域（含现有 `evolutionOutcome`）。

### 6.4 与发酵的关系

发酵引擎每轮读取的"新信号"直接复用 `SourceAggregator.build()` 的输出。这样产生端与发酵端看到的是同一份信号快照，且来源多元化后，发酵判断"是否有新证据"才成立。

## 7. 实现清单

| 文件 | 改动 |
| --- | --- |
| `src/main/creativity/types.ts` | Hypothesis 新字段、`FERMENT_INTERVAL_MS`、反馈域 type、`IdeaStoreLike` 新方法 |
| `src/main/db/migration.ts` | 迁移 v44（4 个 ADD COLUMN） |
| `src/main/creativity/IdeaStore.ts` | `getFermentableHypotheses`、`updateHypothesisFermentation`（JSON 实现，测试用） |
| `src/main/creativity/DrizzleIdeaStore.ts` | 解析/更新新列，`updateHypothesisFermentation` |
| `src/main/creativity/IdeaFermentationEngine.ts` | 新增：发酵引擎 |
| `src/main/creativity/SourceAggregator.ts` | 新增：来源总线 |
| `src/main/creativity/CreativityService.ts` | 注册 `creativity.ferment`、`forceFerment()`、接入 SourceAggregator |
| `src/main/evolution/automation/CreativityCollector.ts` | 只采集 `active` |
| `src/main/tool/definitions/CreativityTools.ts` | 新增 `trigger_idea_ferment` |
| `src/main/bootstrap/AppRuntime.ts` | 修复 `buildCreativitySources`、接入 GitHubInspiration/feedback/真实记忆 |

## 8. 测试计划

- `IdeaFermentationEngine.test.ts`：2 轮才 promote；低分 keep；满 6 轮淘汰；merge 生成新 draft 并标记原条目；LLM 失败跳过不阻塞；每轮 promote 上限 3。
- `SourceAggregator.test.ts`：≥3 域采样；每域限流 K；同域去重；空 provider 降权/跳过。
- `CreativityService.test.ts` 增量：`creativity.ferment` 注册；`forceFerment()` 调用引擎。
- `CreativityCollector` 测试：只返回 `active` 假设。
- 迁移验证：v44 在空库与存量库均可执行（迁移框架自带验证）。

## 9. 风险与决策记录

- **决策**：不加 `fermenting` status，复用 `draft`，规避 CHECK 约束表重建。
- **决策**：发酵间隔 6h；如 LLM 成本敏感可调大（常量可配）。
- **决策**：merge 进 v1，但仅做"LLM 产出合并版 + 原条目标记"，不做自动去重索引。
- **风险**：存量 `draft` 数据在 v1 上线后需至少 2 轮发酵才能被实现，属预期行为；如需加速可在迁移时把高分存量 draft 直接标 `active`（v1 不做，避免绕过发酵）。
- **风险**：来源总线接入过多外部源会抬高每轮 LLM 输入 token；靠每域 K=4 限流控制。
