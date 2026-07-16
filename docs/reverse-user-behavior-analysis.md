# 反 UserBehavior 分析报告

## 当前关系的假设前提

分析 `UserBehaviorLayer` 与「Plan:雷达 Bot + 分析引擎综合优化」在代码库中的实际关系，提取出以下前提假设：

### 前提 A：层级关系（a 是主、b 是从）

| # | 假设 | UserBehavior (a) | Plan:雷达 Bot + 分析引擎 (b) | 代码证据 |
|---|------|-------------------|------------------------------|---------|
| A1 | **装饰器模式** | UserBehaviorLayer 以装饰器模式包裹 `SelfEvolutionService`，控制其输入输出 | 雷达采集器/执行器作为自动化管道的 `SignalCollector`/`FixExecutor`，在管道内部运行 | `UserBehaviorLayer.ts:41-43` wraps inner, `SelfEvolutionService.ts:568-574` calls pipeline.runOnce() |
| A2 | **Feature Flag 控制** | UserBehavior 通过 `USER_BEHAVIOR_FEATURES` 环境变量静态决定开启哪些增强特性 | 雷达 Bot 和优化执行器由 PipelineOrchestrator 统一调度，但不受 UserBehavior feature flags 直接影响 | `types.ts:173-202` parseFeaturesFromEnv, `SelfEvolutionService.ts:498-506` preProcess 条件执行 |
| A3 | **决策影响力** | UserBehavior 的 heatmap/cold_module 分析可影响 Evolution 是否执行（冷模块跳过） | 雷达采集器仅在管道内收集问题，不参与调度决策 | `SelfEvolutionService.ts:438-452` 冷模块跳过逻辑 |
| A4 | **反馈回路方向** | UserBehavior 的 MCPFeedbackLoop 可调整管道参数（maxFixesPerCycle 等） | RadarFeedbackService 仅记录用户反馈，不调整管道参数 | `UserBehaviorLayer.ts:298-322` 动态调参后置钩子 |

### 前提 B：执行顺序（a 先执行、b 后执行）

| # | 假设 | 详情 | 代码证据 |
|---|------|------|---------|
| B1 | **preProcess → Radar 采集** | UserBehavior 的预处理钩子在管道运行前执行，注入行为特征/热力图数据 | `SelfEvolutionService.ts:498-538` preProcess → `569-574` pipeline.runOnce() |
| B2 | **Radar 执行 → postProcess** | 管道执行完成后，UserBehavior 的后处理钩子附加增强报告 | `SelfEvolutionService.ts:629-642` postProcess 在 pipeline.runOnce() 之后 |
| B3 | **冷模块降频先判定** | UserBehavior 生成的热力图在 scheduler tick 中先被检查，决定是否跳过本次周期 | `SelfEvolutionService.ts:438-452` cold module check before runAnalysisCycle() |
| B4 | **指标缓存更新在后** | 管道的指标更新通过事件订阅发生在 UserBehavior 的 postProcess 之前 | `SelfEvolutionService.ts:160-168` pipeline.completed 事件更新指标 |

### 前提 C：职责分工（a 决策、b 执行）

| # | 假设 | 详情 | 代码证据 |
|---|------|------|---------|
| C1 | **UserBehavior 决策优先级** | UserBehavior 的 heatmap 决定哪些模块是进化重点，冷模块可被跳过 | `UserBehaviorLayer.ts:370-394` heatmapPreHook → `SelfEvolutionService.ts:438-452` |
| C2 | **雷达执行采集优化** | RadarOptimizationCollector/Executor 负责采集器代码的自动优化，不参与行为分析决策 | `RadarOptimizationCollector.ts` 只做扫描不决策 |
| C3 | **UserBehavior 驱动行为优化** | BehaviorCollector 读取 BehaviorFeatureExtractor 的数据生成优化问题，BehaviorOptimizationExecutor 执行它 | `BehaviorCollector.ts:19-20` imports behaviorFeatureExtractor |
| C4 | **Radar 反馈仅影响自己** | RadarFeedbackService 的反馈只影响雷达源的跳过/保留，不影响 UserBehavior 决策 | `RadarFeedbackService.ts:154-156` shouldSkipSource 仅作用于雷达采集源 |

---

## 逐个反转 (Reversal) 及可行性评估

### 反转 A1：Plan:雷达 Bot + 分析引擎 充当装饰器模式的主控方

**反转内容**：不是 UserBehaviorLayer 包裹 SelfEvolutionService，而是「雷达主导的协调器」包裹 Evolution 管道。

**可行性**：⭐⭐⭐ （可行，需创建新协调器）
- 可创建 `RadarLedEvolutionOrchestrator` 替代 `UserBehaviorLayer` 的角色
- 雷达分析引擎在该协调器中做预处理（分析当前系统状态 → 决定进化方向）
- UserBehavior 降级为数据提供者（被动提供行为特征）
- **风险**：与现有装饰器模式冲突，需两套协调逻辑并存

### 反转 A2：雷达分析引擎动态决定 UserBehavior feature flags

**反转内容**：不是静态 env vars 决定 UserBehavior 特性，而是雷达分析引擎根据系统状态实时推荐 feature toggles。

**可行性**：⭐⭐⭐⭐⭐ （高可行，低侵入）
- UserBehaviorLayer 已有 `hasFeature()` / `getActiveFeatures()` 接口
- 增加 `setActiveFeatures()` 动态更新能力
- Radar 分析引擎（`radar_analyze` 工具或 `RadarMetricsMonitor`）产出特性推荐
- 特征与环境变量结合：雷达推荐 + 环境白名单 = 最终生效集
- **风险**低：与现有系统完全兼容，feature flags 只是多了一个来源

### 反转 A3：雷达指标决定 Evolution 执行调度

**反转内容**：不是 UserBehavior 的 heatmap/cold_module 决定是否跳过进化周期，而是雷达的采集成功率和系统健康指标决定调度。

**可行性**：⭐⭐⭐⭐ （可行，但需调优）
- `RadarMetricsMonitor` 已有采集器成功率指标
- 将 `schedulerTick()` 中的 `coldModule` 判定改为 `radarMetricsMonitor.collectMetrics()` 的判定
- 如果雷达采集成功率低 → 进化降频（系统不稳定）；成功率高 → 进化加频
- **风险**中等：改变了调度决策的核心逻辑，可能影响进化频率的稳定性

### 反转 A4：雷达反馈驱动管道参数调整

**反转内容**：不是 UserBehavior 的 MCPFeedbackLoop 调整管道参数，而是 RadarFeedbackService 的分析结果驱动参数调整。

**可行性**：⭐⭐⭐ （可行，但参数映射需要设计）
- `RadarFeedbackService` 已有每个采集源的负面反馈占比
- 如果某源反馈差 → 降低对应模块的进化优先级（而非跳过该源）
- 需要建立 源→模块 的映射关系
- **风险**中等：反馈到管道参数的映射需要谨慎，可能产生振荡

### 反转 B1：雷达采集先于 UserBehavior 预处理执行

**反转内容**：不是 preProcess → pipeline.runOnce()，而是 radar_scan → pipeline.runOnce() → UserBehavior 分析。

**可行性**：⭐⭐⭐ （部分可行）
- 将雷达采集提前到 preProcess 阶段执行
- 采集结果作为 preProcess 数据传给 UserBehavior
- 分离"雷达扫描"和"雷达优化执行"：扫描先做，执行留在管道内
- **风险**低：只是执行顺序调整，不改变模块职责

### 反转 B2：UserBehavior 增强报告先于管道执行

**反转内容**：不是 postProcess 补充管道报告，而是 UserBehavior 先在 preProcess 生成"预期报告"，管道执行后对比实际 vs 预期。

**可行性**：⭐⭐⭐⭐ （有分析价值）
- preProcess 阶段生成行为预期（预期修复数、预期关注模块）
- pipeline 执行后对比实际指标
- postProcess 输出 预期 vs 实际 偏差分析
- **收益**：可量化 UserBehavior 的推荐质量
- **风险**低：纯新增能力，不修改现有逻辑

### 反转 B3：雷达健康指标先判定调度

**反转内容**：不是 UserBehavior 热力图决定是否跳过周期，而是雷达健康指标先判定。

**可行性**：⭐⭐⭐⭐ （同 A3，已评估）

### 反转 C1：雷达分析决定进化重点模块

**反转内容**：不是 UserBehavior 的 heatmap 决定优先级，而是雷达扫描到的外部趋势和用户反馈热点决定进化方向。

**可行性**：⭐⭐⭐⭐⭐ （高价值，高可行）
- Radar 扫描外部趋势（HackerNews, GitHub Trending 等）可发现用户可能关心的新技术/库
- 结合 RadarFeedbackService 的用户反馈，决定"用户关心的模块"
- 这些外部信号比内部 heatmap 更能反映"应该进化什么"
- **收益**：进化方向从"内部使用最多的"变为"外部最重要的"
- **风险**低：heatmap 和雷达信号可以加权结合

### 反转 C2：UserBehavior 行为分析执行代码优化

**反转内容**：不是 RadarOptimizationExecutor 做确定性代码转换，而是 UserBehavior 的行为数据驱动 LLM 生成优化代码。

**可行性**：⭐⭐⭐ （已部分实现）
- BehaviorOptimizationExecutor 已在使用 LLM 生成优化代码
- 但它是消费 BehaviorCollector 的问题，不关注雷达采集器代码
- 如果扩展到雷达采集器：behavior 驱动雷达代码优化
- **风险**中等：LLM 生成代码质量不可控，已有 tsc 编译验证保护

### 反转 C3：雷达采集结果作为行为分析的输入

**反转内容**：不是 UserBehavior 的行为数据驱动优化决策，而是雷达采集的外部情报驱动行为分析方向。

**可行性**：⭐⭐⭐⭐⭐ （高价值）
- 雷达扫描外部趋势 → 发现用户可能关心的技术主题
- 基于这些主题，UserBehavior 有方向地分析相关模块的使用模式
- 形成"外部情报 → 定向行为分析 → 精准优化"链路
- **风险**低：只是增加了行为分析的输入维度

---

## 推荐反转方向（选做原型验证）

### 第一优先级：反转 A2 — 雷达驱动的动态 Feature Flag 选择

**实现方案**：`RadarLedFeatureController`
- Radar 分析引擎产出特性推荐（基于系统状态 + 雷达指标）
- 动态更新 UserBehaviorLayer 的活跃 feature 集合
- 与环境变量形成两级控制：env var 是"白名单"，雷达推荐是"动态子集"

**文件**：`src/main/user-behavior/RadarLedFeatureController.ts`

### 第二优先级：反转 C3 — 雷达情报驱动的行为分析方向

**实现方案**：在 UserBehavior 的 preProcess 阶段注入雷达分析结果作为方向指引
- preProcess 前先进行 radar_scan + radar_analyze
- 分析结果中提取"外部热点方向"
- 这些方向引导 UserBehavior 的 heatmap 和行为分析重点

**可在同一原型中实现，作为串联流程**

### 原型范围

本次实现：
1. ✅ 反转 A2：`RadarLedFeatureController` — 雷达驱动的动态 Feature 选择
2. ✅ 反转 C3 辅助：在 `RadarLedFeatureController` 中集成雷达数据分析，作为行为分析输入
3. ✅ 不修改现有 `UserBehaviorLayer` 或 `SelfEvolutionService` 的核心逻辑
