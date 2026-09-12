# 反 UserBehavior：Plan 主导架构假设反转分析

> 分析日期: 2026-07-17
> 状态: 初稿
> 目标: 列举 UserBehavior 与「Plan:雷达 Bot + 分析引擎综合优化」的当前关系假设，逐个反转并评估可行性

---

## 术语定义

| 术语 | 含义 | 对应代码 |
|------|------|----------|
| **UserBehavior (UB)** | 用户行为分析系统：追踪窗口/工具/话题模式，决策场景/模式/工具优先级 | `UserBehaviorAnalyzer` + `UserBehaviorService` + `UserBehaviorLayer` + `BehaviorCollector` |
| **Plan: 雷达 Bot** | 外部信息采集系统：从 HackerNews/微博/GitHub/哔哩哔哩等源采集情报 | `RadarTools` (radar_scan) + `RadarOptimizationCollector/Executor` |
| **Plan: 分析引擎** | 内部工具调用分析引擎：延迟百分位/成功率趋势/失败模式/优先级推荐 | `ToolAnalytics` + `ToolCallLogStore` + `ToolStatsTracker` + `FailurePatternAnalyzer` |
| **Plan: 综合优化** | 基于 Plan 分析结果驱动代码优化/行为调整 | `RadarOptimizationExecutor` + `BehaviorOptimizationExecutor` |

---

## 当前的 7 条关系假设

### 假设 1：数据流单向 — UB → Plan

**当前状态**：
- `UserBehaviorAnalyzer` 记录工具调用频率 → `BehaviorFeatureExtractor` 提取序列特征 → `BehaviorCollector` 生成 `Problem` → 进化管道消费
- `ToolAnalytics` (分析引擎) 仅读取 `ToolCallLogStore`(被动数据源)，不接收行为特征输入
- `RadarOptimizationCollector` 扫描静态代码，不访问行为数据

```
UserBehavior ──→ 工具调用记录 ──→ ToolCallLogStore
                                       ↓
                                ToolAnalytics (被动读取)
                                       ↓
                                优先级推荐 → ServerManager
```

**数据流方向**：UserBehavior 产生数据 → Plan 间接消费（通过共享的 ToolCallLogStore）。Plan 分析结果从不回传给 UserBehavior。

### 假设 2：热路径归属 UB — Plan 在冷路径

**当前状态**：
- `UserBehaviorAnalyzer.analyze()` 在 `ChatExecutor.refreshMemory()` 中每轮对话**之前**执行
- `UserBehaviorAnalyzer.analyzeScene()` 决定回复模式（简洁/详细/技术/温暖），结果注入 system prompt
- `radar_scan`/`radar_analyze` 仅当 Agent 在对话中**显式调用**时才执行
- 雷达工具是 MCP 工具包中的普通成员，无特殊优先级

```
[每轮对话]
  用户输入 → UserBehaviorAnalyzer.analyze() → 注入 prompt → Agent 处理 → 调用工具(可能含 radar)
                                                                                ↑
                                                                          Plan 仅在此被调用
```

### 假设 3：内部模式可信度 > 外部趋势可信度

**当前状态**：
- `UserBehaviorAnalyzer` 跟踪用户的历史工具使用和话题偏好 → 高可信度（来自用户自身行为）
- `radar_scan` 采集的外部数据 → 辅助信息，需用户判断后才能使用
- 场景判定 (`_classifyScene`) 仅依赖用户消息长度/工具占比/话题标签 — 从不参考外部趋势

```typescript
// UserBehaviorAnalyzer._classifyScene 的判定信号：
const signals = {
  avgUserMessageLength, // 用户消息长度
  toolUsageRatio,       // 工具使用占比
  dominantTopics,       // 用户消息中提取的话题
  topKeywords,          // 用户高频词
  // 没有 externalTrends, radarAnalysis, hotTopics
}
```

### 假设 4：UB 决策权重 > Plan 决策权重

**当前状态**：
- `UserBehaviorAnalyzer.analyze()` 返回的 `suggestedToolHints` 直接注入 system prompt，影响 Agent 行为
- `ToolAnalytics` 生成的 `priorityDelta` 仅影响 `ServerManager` 的**工具调度优先级**，不直接影响 Agent 的决策
- `DualModeController` 中 user-behavior 模式是**默认模式**，plan-typescript 是**特殊覆盖**
- 即使 `PlanExperiment42Plugin` 的 Phase 3 也不是替换 UB，而是评估是否可以替换

```
决策影响力层级：
  UserBehavior.analyze() → system prompt 注入 → 直接影响 Agent 行为
       ↓
  ToolAnalytics.priorityDelta → ServerManager 调度调整 → 间接影响工具选择
       ↓
  RadarOptimization → 代码质量优化 → 间接影响工具执行效率
```

### 假设 5：时序 — UB 先决策，Plan 后执行

**当前状态**：
- `UserBehaviorAnalyzer.analyze()` 在 ChatExecutor 中每轮对话前执行（预处理）
- 雷达工具在 Agent 已经根据 UB 结果设置好上下文后才被调用（按需）
- `BehaviorCollector`/`RadarOptimizationCollector` 都在 2h 进化周期中执行，但 Behavior 数据采集自 UB 运行时数据

```
时序轴：
  [t0] UserBehaviorAnalyzer.analyze()      ← 预处理
  [t1] Agent 处理用户请求                     ← 在 UB 设置的上下文中
  [t2] radar_scan / radar_analyze (按需)    ← 由 Agent 决定是否调用
  [t3] BehaviorCollector (2h)              ← 后处理
  [t4] RadarOptimizationCollector (2h)     ← 后处理
```

### 假设 6：反馈回路 — UB 紧耦合 vs Plan 松耦合

**当前状态**：
- UB 有**紧反馈回路**：每轮对话 observe → analyze → inject → observe（毫秒级）
- Plan 有**松反馈回路**：radar_scan → output → 用户反馈 → Memory → 影响下次 scan（分钟-小时级）
- Plan (分析引擎) 有中等反馈：ToolAnalytics → priorityDelta → ServerManager → 下次工具调度

```
UB 反馈回路 (毫秒级)：
  recordToolCall → analyze → inject prompt → recordToolCall → analyze → ...

Plan 雷达反馈回路 (分钟级)：
  radar_scan → radar_analyze → 用户反馈 → RadarFeedbackService → Memory → 下次 scan

Plan 分析引擎反馈回路 (秒级)：
  toolCall → ToolCallLogStore → ToolAnalytics → priorityDelta → ServerManager → 下次调度
```

### 假设 7：粒度 — UB 微 (per-turn) vs Plan 宏 (2h 周期)

**当前状态**：
- UserBehaviorAnalyzer 每轮对话都分析（微粒度）
- UserBehaviorService 每 2s 检查空闲状态（中粒度）
- BehaviorCollector 每 2h 运行（匹配进化周期）
- RadarOptimizationCollector 每 2h 运行（匹配进化周期）
- ToolAnalytics 可按需运行（可细可粗）

```
粒度轴：
  毫秒:   UserBehaviorAnalyzer.recordToolCall()
  秒:     UserBehaviorService idle checker (2s)
  分钟:   无
  小时:   BehaviorCollector (2h), RadarOptimizationCollector (2h), ToolAnalytics (按需)
```

---

## 假设反转与可行性评估

### 反转 1：数据流双向 — Plan → UB 反馈回路

**反转描述**：Plan（雷达+分析引擎）的分析结果主动反馈回 UserBehaviorAnalyzer，影响其话题检测、场景判定和工具优先级推荐。

**可行性评估**：✅ **高 — 可做**

**理由**：
- 技术债务低：只需在 UserBehaviorAnalyzer 添加一个 `injectExternalTrends()` 方法
- 集成点明确：可在 UserBehaviorLayer 的预处理钩子中注入
- 风险可控：通过 feature flag (`plan_to_behavior_feedback`) 控制开关
- 已有前置工作：`PlanExperiment42Plugin` 已实现类似旁路观察模式

**预期影响**：
- 用户询问技术话题时，如果 radar_scan 检测到相关趋势，UB 可主动提升相关工具优先级
- 话题检测可融合外部热点信号，提高场景判定的上下文感知能力

### 反转 2：Plan 拥有热路径 — radar 预分析每轮对话

**反转描述**：每轮对话前，自动运行轻量雷达扫描（限时 500ms）获取当前外部趋势，与 UB 行为分析共同决定 Agent 上下文。

**可行性评估**：⚠️ **中 — 需谨慎设计**

**理由**：
- 性能风险：网络请求延迟不可控，500ms 限时内可能超时
- 缓存方案可行：可每 5 分钟全量扫描一次，每轮对话仅读取缓存
- 语义匹配难点：外部趋势需要与用户当前问题语义匹配（需 NLP）
- 可行性：可作为可选特性，默认关闭

**预期影响**：
- Agent 在对话开始时自动感知当前热点，可主动提供相关上下文
- 延迟增加 50-200ms（缓存命中）或 2-5s（缓存未命中）

### 反转 3：外部趋势可信度 ≥ 内部模式可信度

**反转描述**：当 radar 检测到某个话题是当前全局热点时，即使 UB 分析认为用户不关注该话题，也提升其权重。

**可行性评估**：❌ **低 — 不推荐**

**理由**：
- 领域直觉违背：用户的个人行为模式比外部趋势更能预测用户的下一步动作
- 误判风险高：用户可能在处理完全不相关的任务
- 维护成本高：需要复杂的加权策略和阈值调优
- 除非在特定场景（如用户明确询问"最近有什么热点"），否则不应信任外部 > 内部

### 反转 4：Plan 决策权重 > UB 决策权重

**反转描述**：ToolAnalytics 的优先级推荐和 RadarOptimization 的分析结果，权重高于 UserBehaviorAnalyzer 的行为模式推测。

**可行性评估**：❌ **低 — 领域不匹配**

**理由**：
- ToolAnalytics 主要关注工具的稳定性/性能，而非用户的意图
- radar_scan 的热点与用户的当前任务可能完全不相关
- UB 的场景判定（scene）和回复模式决策（response mode）需要实时交互特征，Plan 无法提供
- 但在工具优先级决策上，Plan 可以补充 UB：UB 决定"用户可能需要什么工具"，Plan 决定"哪些工具运行良好"

### 反转 5：Plan 先执行预处理，UB 后执行记录

**反转描述**：每轮对话前先运行轻量 radar_scan + analyzer，再运行 UserBehaviorAnalyzer，将外部趋势作为 UB 分析的输入信号。

**可行性评估**：⚠️ **中 — 可部分实现**

**理由**：
- 与反转 2 类似，但更温和：不要求 Plan 替代 UB，仅改变执行顺序
- UB 增加 `externalContext` 参数，Plan 分析结果作为输入
- 缓存支持可缓解性能问题
- 本质上是反转 1 的具体时序实现

### 反转 6：Plan 拥有紧反馈回路，UB 转为松耦合

**反转描述**：ToolAnalytics 的分析结果以每轮对话级别反馈（每次工具调用后立即更新推荐），而 UB 的行为模式分析降级为 2h 周期的批量处理。

**可行性评估**：⚠️ **中 — 分析引擎已部分实现**

**理由**：
- `ToolAnalytics` 已经有 `getPriorityRecommendations()` 和延迟百分位计算
- 但将 UB 降级为批量处理会丢失关键的热路径能力：
  - 重复模式检测 (`detectRepeatedPattern`) 需要实时性
  - 场景自适应 (`analyzeScene`) 需要在每轮对话中注入 prompt
- 可行方案：分析引擎紧反馈 + UB 按需轻量分析

### 反转 7：Plan 微粒度 (per-turn) + UB 宏粒度 (2h)

**反转描述**：颠倒粒度：ToolAnalytics 在每次工具调用后立即产生影响，UserBehaviorAnalyzer 仅做 2h 周期的批量分析。

**可行性评估**：❌ **低 — 会丢失核心能力**

**理由**：
- UB 的重复模式检测、场景分类、话题跟踪都是热路径功能
- 将这些延迟到 2h 周期会极大降低 Agent 的上下文感知能力
- Plan 的雷达扫描即使变为 per-turn 也无法解决外部数据延迟问题
- 粒度应该由功能需求决定，不应为反转而反转

---

## 综合评估与推荐排序

| 反转 | 可行性 | 影响 | 风险 | 推荐 |
|------|--------|------|------|------|
| **R1: Plan → UB 数据反馈** | ✅ 高 | 中 | 低 | **🥇 优先级最高** |
| R5: Plan 先执行 | ⚠️ 中 | 中 | 中 | 🥈 可作为 R1 的时序变体 |
| R6: Plan 紧反馈 | ⚠️ 中 | 中 | 低 | 🥉 分析引擎已部分实现 |
| R2: Plan 拥有热路径 | ⚠️ 中 | 大 | 高 | 可选实验 |
| R7: 粒度颠倒 | ❌ 低 | 小 | 大 | 不推荐 |
| R4: Plan 决策权重 > UB | ❌ 低 | 大 | 大 | 不推荐 |
| R3: 外部趋势 ≥ 内部模式 | ❌ 低 | 中 | 大 | 不推荐 |

---

## 原型验证设计

### 选择的反转：R1 — Plan → UB 数据反馈（数据流双向化）

**核心思路**：创建一个 `AnalysisBehaviorBridge`，将 ToolAnalytics 的分析结果和 Radar 采集的外部趋势反馈回 UserBehaviorAnalyzer，使 UB 的场景/话题/工具决策能够感知 Plan 的分析结论。

**具体设计**：

```
Plan (雷达 + 分析引擎)                         UserBehavior
│                                              │
├─ ToolAnalytics ──→ analysisContext ──→┐      │
│                                        │      │
├─ RadarFeedbackService ──→ trendingTopics ─→ AnalysisBehaviorBridge ──→ UserBehaviorAnalyzer
│                                        │                              │
└─ RadarOptimization ──→ optimizationHints ┘                              ↓
                                                                  [增强的行为分析]
                                                                  (含 Plan 上下文)
```

**集成点**：
1. `UserBehaviorAnalyzer.injectExternalContext(context: ExternalBehaviorContext)` — 新方法
2. `AnalysisBehaviorBridge` — 新类，订阅 EventBus 事件 + 读取 ToolAnalytics
3. `UserBehaviorLayer` 的新 feature flag `plan_to_behavior_feedback`

**开启条件**：`USER_BEHAVIOR_FEATURES=plan_to_behavior_feedback`

**成功标准**：
- 当 ToolAnalytics 检测到某工具错误率上升时，UB 能降低该工具的优先级推荐
- 当雷达反馈分析显示某话题是趋势时，UB 的话题检测能包含该信号
- 添加后不增加 ChatExecutor 热路径的主要延迟

---

## 附录：现有代码中的 Plan 主导痕迹

以下代码已有 Plan 主导倾向（即使名义上 UB 是主）：

1. **DualModeController** (`src/main/behavior/DualModeController.ts`): 已在 user-behavior 和 plan-typescript 之间切换，说明架构已预见到了 Plan 主导的可能性。

2. **PlanExperiment42Plugin** (`src/main/user-behavior/plan-experiment-42/PlanExperiment42Plugin.ts`): Phase 3 的目标是 `core_replacement` — 替换 UB 核心模块。这说明 Plan 主导是有意识的架构方向。

3. **ToolAnalytics.getPriorityRecommendations()** (`src/main/tool/ToolAnalytics.ts`): 已经能生成工具优先级调整建议，只是目前仅影响 ServerManager 的调度权重，未影响 UB 的话题/场景决策。

4. **MCPFeedbackLoopService** (`src/main/user-behavior/feedback-loop/`): 已经实现了基于工具调用质量（Plan 分析数据）调整参数的反馈回路，这是 Plan → UB 反馈的雏形。
