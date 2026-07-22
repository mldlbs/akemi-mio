# UserBehavior 模块子模块拆分与 Industrial Ode 模式适配分析

> 分析日期: 2026-07-10
> 目标: 将 UserBehavior 功能按独立程度拆分为子模块，按 Industrial Ode 模式（feature flag + hook 架构）进行模块化改造

## 架构参照: Industrial Ode (工业颂歌) 模式

`src/main/gongye-songge/` 采用的模块化模式:
1. **Layer 装饰器** — `IndustrialOdeLayer` 包裹 `AgentService`，不侵入核心逻辑
2. **Feature Flag 控制** — 通过 `GONGYE_SONGE_FEATURES` 环境变量控制特性开关
3. **Pre/Post 处理钩子** — 可独立注册的钩子函数，按顺序执行
4. **独立格式化器** — `formatters/WechatFormatter.ts` 纯函数式，无副作用
5. **类型分离** — `types.ts` 承载所有类型定义

UserBehaviorLayer (`src/main/user-behavior/`) 已部分采用此模式，但核心 `UserBehaviorService` (`src/main/behavior/`) 仍为单体类。

---

## 子模块清单与独立性评估

### A. `src/main/behavior/` — 核心行为追踪

| # | 子模块 | 当前文件 | 行数 | 独立性 | 可被 IO 模式替代 | 优先替换 |
|---|--------|---------|------|--------|-----------------|---------|
| A1 | **App Window Polling** (前台窗口轮询) | `UserBehaviorService.ts` | ~65行 | ⭐⭐⭐⭐⭐ | ❌ 领域不同 | **1st** |
| A2 | **Idle Detection** (空闲检测) | `UserBehaviorService.ts` | ~40行 | ⭐⭐⭐⭐ | ❌ 领域不同 | 2nd |
| A3 | **Window Event Tracking** (窗口事件监听) | `UserBehaviorService.ts` | ~35行 | ⭐⭐⭐ | ❌ 领域不同 | 3rd |
| A4 | **State Management & Publishing** (状态管理与发布) | `UserBehaviorService.ts` | ~60行 | ⭐⭐ | ❌ 领域不同 | 4th |
| A5 | **Activity Context Detection** (活动情境检测) | `UserBehaviorService.ts` | ~35行 | ⭐⭐⭐⭐ | ❌ 领域不同 | 可选 |
| A6 | **App Category Detection** (应用类别检测) | `UserBehaviorService.ts` | ~20行 | ⭐⭐⭐⭐⭐ | ❌ 领域不同 | **1st** |
| A7 | **Dual Mode Evaluation & Plan Events** (双模切换评估) | `UserBehaviorService.ts` | ~50行 | ⭐⭐ | ❌ 领域不同 | 后期 |
| A8 | **BehaviorStateMachine** (行为状态机) | `BehaviorStateMachine.ts` | ~495行 | 独立文件 | ❌ 领域不同 | ✅ 已独立 |
| A9 | **DualModeController** (双模控制器) | `DualModeController.ts` | ~554行 | 独立文件 | ❌ 领域不同 | ✅ 已独立 |
| A10 | **UserBehaviorTtsContract** (TTS 合同) | `UserBehaviorTtsContract.ts` | ~461行 | 独立文件 | ❌ 领域不同 | ✅ 已独立 |
| A11 | **ToolFeedbackLoop** (工具反馈回路) | `ToolFeedbackLoop.ts` | ~678行 | 独立文件 | ❌ 领域不同 | ✅ 已独立 |
| A12 | **AgentBehaviorSchema** (事件合同) | `AgentBehaviorSchema.ts` | ~304行 | 独立文件 | ❌ 领域不同 | ✅ 已独立 |

### B. `src/main/agent/` — Agent 层行为分析

| # | 子模块 | 当前文件 | 行数 | 独立性 | 可被 IO 模式替代 | 优先替换 |
|---|--------|---------|------|--------|-----------------|---------|
| B1 | **Tool Frequency Analysis** (工具频率分析) | `UserBehaviorAnalyzer.ts` | ~100行 | ⭐⭐⭐⭐ | ⚠️ 部分: 分析结果可通过 hook 注入 | 中期 |
| B2 | **Topic Extraction** (话题提取) | `UserBehaviorAnalyzer.ts` | ~70行 | ⭐⭐⭐⭐ | ❌ 领域不同 | 中期 |
| B3 | **Scene Classification** (场景分类) | `UserBehaviorAnalyzer.ts` | ~120行 | ⭐⭐⭐ | ❌ 领域不同 | 后期 |
| B4 | **Repeat Detection** (重复提问检测) | `UserBehaviorAnalyzer.ts` | ~80行 | ⭐⭐⭐⭐ | ❌ 领域不同 | 可选 |
| B5 | **User Feedback** (用户反馈调节) | `UserBehaviorAnalyzer.ts` | ~60行 | ⭐⭐⭐⭐ | ⚠️ 部分: 反馈调整可通过 hook 注入 | 中期 |
| B6 | **Text Similarity** (文本相似度) | `UserBehaviorAnalyzer.ts` | ~30行 | ⭐⭐⭐⭐⭐ | ❌ 纯工具函数 | **1st** |
| B7 | **BehaviorPattern & SceneAnalysis 类型** | `UserBehaviorAnalyzer.ts` | ~50行 | ⭐⭐⭐⭐⭐ | ❌ 类型定义 | **1st** |

### C. `src/main/user-behavior/` — Evolution 增强层

| # | 子模块 | 当前文件 | 独立性 | 可被 IO 模式替代 | 优先替换 |
|---|--------|---------|--------|-----------------|---------|
| C1 | **UserBehaviorLayer** (装饰器) | `UserBehaviorLayer.ts` | ✅ 已符合 IO 模式 | N/A (自身是 IO 模式实现) | ✅ 已完成 |
| C2 | **BehaviorFeatureExtractor** (特征提取) | `BehaviorFeatureExtractor.ts` | ✅ 独立文件 | ❌ 领域不同 | ✅ 已独立 |
| C3 | **BehaviorHeatmapService** (热力图) | `BehaviorHeatmapService.ts` | ✅ 独立文件 | ❌ 领域不同 | ✅ 已独立 |
| C4 | **MCPFeedbackLoopService** (反馈回路) | `feedback-loop/` | ✅ 独立目录 | ❌ 领域不同 | ✅ 已独立 |

---

## 子模块依赖性拓扑

```
UserBehaviorService (协调器)
├── AppWindowPolling     ← 完全独立, 仅回调 updateState
├── IdleDetector         ← 依赖 behaviorStateMachine 阈值
├── WindowEventTracker   ← 依赖 mainWindow, EventBus
├── StatePublisher       ← 依赖 mainWindow IPC, EventBus
├── DualModeEvaluator    ← 依赖 dualModeController, EventBus, planTypeScriptExecutor
└── AppCategoryDetector  ← 纯函数, 无依赖
```

推荐提取顺序: **A1→A6→A2→A3→A4→A7** (从最独立到最耦合)

---

---

## Plan:推理链替换适配性分析

> 分析日期: 2026-07-22
> 目标: 对 UserBehavior 各子模块评估其是否适合被「Plan:推理链」能力替换，采用已验证的 Phase 1 (passive_monitor) → Phase 2 (suggestion_source) → Phase 3 (core_replacement) 渐进模式。

### Plan:推理链模式说明

**Plan:推理链** 是项目已建立的「LLM 驱动替代启发式算法」模式。其核心思想：

1. **观察**（Phase 1）：用 Plan subagent 旁路观察现有启发式决策，记录「如果使用 Plan 推理会怎么做」，与实际决策对比但不影响产出
2. **建议**（Phase 2）：Plan 推理结果作为建议源注入部分决策，与实际结果并行运行，评估一致性
3. **替换**（Phase 3）：验证可靠后，用 Plan subagent 的 LLM 推理替换原启发式代码

**对比 Industrial Ode 模式**：
| 维度 | Industrial Ode 重构 | Plan:推理链替换 |
|------|-------------------|----------------|
| 目标 | 解耦、独立、可维护 | 用 LLM 推理替代硬编码启发式规则 |
| 改造方式 | 提取函数为独立模块 | 用 Plan subagent + prompt 替代 |
| 风险 | 接口兼容 | 新旧混合期兼容 + 推理不确定 |
| 收益 | 降低耦合 | 更智能的决策、更低维护成本 |
| 适用场景 | 功能逻辑（如轮询、状态管理） | 评估/分类/优化建议（如模块优先级、质量降级、特征提取） |

### 子模块 Plan:推理链替换评估

#### A. `src/main/behavior/` — 核心行为追踪

| # | 子模块 | 当前实现 | 独立性 | Plan 可替换性 | 分析 |
|---|--------|---------|--------|--------------|------|
| A1 | **App Window Polling** (前台窗口轮询) | PowerShell 轮询 | ⭐⭐⭐⭐⭐ | ❌ **不可替换** | OS 级操作，需原生代码。Plan subagent 无法获取前台窗口句柄 |
| A2 | **Idle Detection** (空闲检测) | 定时器 + 阈值比较 | ⭐⭐⭐⭐ | ❌ **不可替换** | 延迟敏感，需要毫秒级响应。LLM 推理延迟不可接受 |
| A3 | **Window Event Tracking** (窗口事件监听) | Electron 窗口事件 | ⭐⭐⭐ | ❌ **不可替换** | 事件驱动，需原生集成 |
| A4 | **State Management & Publishing** (状态管理与发布) | IPC + EventBus | ⭐⭐ | ❌ **不可替换** | 纯数据管道，不涉及决策逻辑 |
| A5 | **Activity Context Detection** (活动情境检测) | 类别+ 状态机 | ⭐⭐⭐⭐ | ✅ **可替换 Phase 2** | 规则简单，但 Plan 可理解更丰富的用户上下文。当前规则足够了，Phase 2 建议即可 |
| A6 | **App Category Detection** (应用类别检测) | 关键词正则匹配 | ⭐⭐⭐⭐⭐ | ✅ **可替换 Phase 3** | 纯分类任务，Plan 推理准确率远超关键词匹配，且延迟不敏感（每 5s 轮询）。最适合首批替换 |
| A7 | **BehaviorStateMachine** | ~495 行状态机 | ✅ 已独立 | ❌ **不可替换** | 需要确定性状态转换，LLM 的不确定性会破坏状态一致性 |
| A8 | **DualModeController** | ~554 行控制器 | ✅ 已独立 | ❌ **不可替换** | 需要确定性条件评估以保障模式切换正确 |
| A9 | **BehaviorProfile** (行为画像) | 统计分析 | 内联 | ✅ **可替换 Phase 2→3** | 行为画像本质是模式识别，Plan 推理能发现更细粒度的用户习惯 |

#### B. `src/main/agent/` — Agent 层行为分析

| # | 子模块 | 独立性 | Plan 可替换性 | 分析 |
|---|--------|--------|--------------|------|
| B1 | **Tool Frequency Analysis** (工具频率分析) | ⭐⭐⭐⭐ | ⚠️ **部分可替换** | n-gram 频率分析适合确定性算法；但「优化建议生成」适合 Plan 推理 |
| B2 | **Topic Extraction** (话题提取) | ⭐⭐⭐⭐ | ✅ **可替换 Phase 3** | 话题提取是典型的 LLM 擅长的 NLP 任务，当前启发式提取效果有限 |
| B3 | **Scene Classification** (场景分类) | ⭐⭐⭐ | ✅ **可替换 Phase 3** | 场景分类本质是 LLM 的推理优势领域 |
| B4 | **Repeat Detection** (重复提问检测) | ⭐⭐⭐⭐ | ❌ **不可替换** | 需要低延迟文本相似度计算，LLM 推理太慢 |
| B5 | **User Feedback Analysis** (用户反馈分析) | ⭐⭐⭐⭐ | ✅ **可替换 Phase 2** | Plan 推理可理解用户反馈意图，当前关键词匹配过于粗糙 |
| B6 | **Text Similarity** (文本相似度) | ⭐⭐⭐⭐⭐ | ❌ **不可替换** | 纯工具函数，LLM 推理不必要且太慢 |

#### C. `src/main/user-behavior/` — Evolution 增强层

| # | 子模块 | 独立性 | Plan 可替换性 | 分析 |
|---|--------|--------|--------------|------|
| C1 | **UserBehaviorLayer** (装饰器) | ✅ 已独立 | ❌ **不可替换** | 编排层，不涉及决策逻辑 |
| C2 | **BehaviorFeatureExtractor** (特征提取) | ✅ 已独立 | ⚠️ **部分可替换** | n-gram 序列分析适合算法；但「优化建议生成」([`generateSuggestions`]) 适合 Plan 推理替代。可拆分为 算法部分 + Plan 建议部分 |
| C3 | **BehaviorHeatmapService** (热力图) | ✅ 已独立 | ✅ **可替换 Phase 2→3** | 热力图的「优先级分类」([`classifyPriority`]) 和「趋势判断」([`computeTrend`]) 使用固定阈值，Plan 推理可根据系统状态更智能地判断优先级 |
| C4 | **QualityMetricsTracker** (质量指标追踪) | ✅ 已独立 | ✅ **可替换 Phase 2→3** | 降级检测 ([`detectDegradation`]) 和优化建议映射 ([`mapMetricToOptimization`]) 使用固定规则，Plan 推理可理解复杂降级模式并给出更精准的优化建议 |
| C5 | **MCPFeedbackLoopService** (反馈回路) | ✅ 独立目录 | ❌ **不可替换** | 需要确定性参数调整（阻尼、收敛检测）。LLM 不确定性会导致参数震荡 |
| C6 | **ASR Behavior Adapter** | ✅ 独立目录 | ⚠️ **可替换 Phase 2** | 数据适配逻辑保留；但「行为上下文推断」适合 Plan 推理 |

### 替换优先级矩阵

```
优先级 | 子模块            | 当前行数 | 替换收益 | 替换风险 | 推荐策略
───────┼───────────────────┼─────────┼──────────┼──────────┼─────────
 P0   | AppCategoryDetect  | ~20行   | 中       | 低       | Phase 2→3 直接替换
 P1   | QualityMetrics     | ~500行  | 高       | 中       | Phase 1→2→3 完整周期
 P2   | BehaviorHeatmap    | ~450行  | 中       | 低       | Phase 1→2
 P3   | FeatureExtractor   | ~480行  | 中       | 中       | 仅替换建议生成部分
 P4   | SceneClassify      | ~120行  | 高       | 低       | Phase 2→3 直接替换
 P5   | TopicExtraction    | ~70行   | 高       | 低       | Phase 2→3
 P6   | BehaviorProfile    | ~150行  | 低       | 中       | 观察期后决定
 P7   | UserFeedback       | ~60行   | 低       | 低       | Phase 2 建议即可
```

### 渐进替换计划: 8 阶段

每阶段替换一个子模块，运行一个月观察稳定性。

#### 基础设施先行

在开始替换前，先完善 Plan 替换的基础设施：

1. **Feature Flags**：添加 `plan_behavior_replacement_passive/suggestion/replacement` 到类型和 `parseFeaturesFromEnv()`
2. **对比报告**：复用 PlanExperiment42 的对比报告框架（`planOverrideRate`），扩展支持多子模块对比
3. **注册表**：创建 `PlanBehaviorReplacementRegistry`，集中管理各子模块的替换阶段状态

```typescript
// plan-replacement-registry.ts (新文件)
export interface PlanReplacementEntry {
  moduleId: string
  name: string
  phase: 'passive_monitor' | 'suggestion_source' | 'core_replacement' | 'done'
  planOverrideRate: number
  observations: number
  startedAt: number
}

export class PlanBehaviorReplacementRegistry {
  private entries = new Map<string, PlanReplacementEntry>()
  
  register(moduleId: string, name: string, phase?: string): void { ... }
  getPhase(moduleId: string): string { ... }
  recordObservation(moduleId: string, planWouldDiffer: boolean): void { ... }
  generateReport(): string { ... }
}
```

#### Phase 1 (Month 1): App Category Detection

**目标**: 用 Plan subagent 替代 `detectAppCategory()` 的关键词正则匹配

**Phase 1 实现** (passive_monitor):
- 在现有 `detectAppCategory()` 旁添加 Plan 推理分支，输出分类结果但**不使用**
- 对比 Plan 分类 vs 正则分类，统计准确率差异
- 日志输出对比结果

**Phase 2 实现** (suggestion_source):
- 当 Plan 置信度高于阈值时，优先使用 Plan 分类结果
- 当正则匹配结果与 Plan 推理冲突时，打日志标记

**Phase 3 实现** (core_replacement):
- 移除正则匹配逻辑，完全使用 Plan subagent
- 添加缓存：同一窗口标题 30s 内复用上次推理结果（降低 LLM 调用频率）

**风险**: 低。`detectAppCategory` 是纯分类、无副作用、单点功能。
**回滚**: 恢复 feature flag 到上一阶段即可。

#### Phase 2 (Month 2): Quality Metrics Degradation Detection

**目标**: 用 Plan 推理替代 `QualityMetricsTracker.detectDegradation()` 的固定阈值降级检测

**Phase 1 实现** (passive_monitor):
- 在 `detectDegradation()` 执行后，用 Plan subagent 对同一批指标做降级分析
- 比较 Plan 发现的降级 vs 算法发现的降级
- 统计 false positive / false negative

**Phase 2 实现** (suggestion_source):
- 在生成的 `DegradationSignal` 列表中添加 Plan 新增的降级（作为补充）
- 标记 Plan 支持的降级为 `confidence: 'plan_augmented'`

**Phase 3 实现** (core_replacement):
- Plan 推理成为降级检测的主要方法
- 算法降级作为兜底（Plan 不可用时 fallback）

**风险**: 中。降级检测影响 Evolution 的优化目标选择，误报可能导致无效优化。

#### Phase 3 (Month 3): BehaviorHeatmap Priority Classification

**目标**: 用 Plan 推理替代 `BehaviorHeatmapService.classifyPriority()` 的固定阈值分类

#### Phase 4 (Month 4): BehaviorFeatureExtractor Suggestion Generation

**目标**: 仅替换 `generateSuggestions()` 方法（n-gram 分析保留算法实现）

#### Phase 5 (Month 5): Scene Classification

**目标**: 用 Plan 推理替代 `UserBehaviorAnalyzer` 的场景分类规则

#### Phase 6 (Month 6): Topic Extraction

**目标**: 用 Plan 推理替代话题提取启发式规则

#### Phase 7 (Month 7): BehaviorProfile Generation

**目标**: 用 Plan 推理增强用户行为画像生成

#### Phase 8 (Month 8): User Feedback Analysis

**目标**: 用 Plan 推理理解用户反馈意图，替代关键词匹配

### 混合期兼容策略

**新旧混合期**（每个 Phase 2）需要维护以下兼容性：

1. **API 不变**：即使内部使用 Plan 推理，所有公开 API 签名保持不变
2. **Feature Flag 控制**：每个子模块的替换阶段由独立的 feature flag 控制
3. **降级策略**：Plan 推理失败时回退到算法实现（fail-open）
4. **数据一致性**：Plan 推理结果缓存到内存，确保同一推理结果在窗口期内一致
5. **可观测性**：每个替换点都输出 Plan-vs-Algorithm 对比日志

兼容性监控指标：
- plan_override_rate: Plan 推理与实际算法决策不一致的比例
- plan_latency_ms: Plan 推理的平均耗时（超过 5s 标记为告警）
- algorithm_usage_rate: 回退到算法实现的比例（超过 20% 标记为告警）

## 实施计划: 6 阶段

### Phase 1 (本期): A1 + A6 — App Window Polling + App Category Detection
- 创建 `src/main/behavior/app-window-polling.ts`
- 将 `detectAppCategory()`, `startAppPolling()`, `pollForegroundWindow()`, `getForegroundWindowTitle()` 提取
- `UserBehaviorService` 注入 `AppWindowPolling` 实例
- 测试: 已有功能不中断

### Phase 2: A2 — Idle Detection
- 创建 `src/main/behavior/idle-detector.ts`  
- 提取 idle 检测逻辑
- 通过事件回调通知状态变更

### Phase 3: A3 — Window Event Tracking
- 创建 `src/main/behavior/window-event-tracker.ts`
- 提取窗口事件监听

### Phase 4: A4 — State Management & Publishing
- 创建 `src/main/behavior/state-publisher.ts`
- 提取状态管理与 IPC 发布

### Phase 5: A7 — Dual Mode Evaluation
- 创建 `src/main/behavior/dual-mode-evaluator.ts`
- 提取双模切换与计划事件订阅

### Phase 6: B 系列 — UserBehaviorAnalyzer 拆分
- 提取 `computeBigramJaccard` 到工具模块
- 提取类型定义
- 后续按功能拆分

---

## 风险与兼容性策略

### 新旧混合期接口兼容
1. `UserBehaviorService` 保持所有公开 API 签名不变 (`getState()`, `getEnrichedState()`, `markActive()` 等)
2. 提取的子模块作为 `UserBehaviorService` 的**内部依赖**注入
3. 所有索引文件 (`behavior/index.ts`) 的导出不变
4. 外部消费者无需任何改动

### 稳定性保障
1. 每提取一个子模块, 运行 `tsc --noEmit` 验证
2. 每提取一个子模块, 运行现有单元测试
3. 先提取最独立的子模块 (A1), 运行观察期
4. 观察期后评估接口稳定性, 再决定下一步

---

## 第一期: AppWindowPolling 提取方案

### 新文件: `src/main/behavior/app-window-polling.ts`

```typescript
export interface AppWindowPollingOptions {
  pollIntervalMs?: number  // 默认 5000
  enabled?: boolean        // 仅在 Windows 上启用
}

export class AppWindowPolling {
  constructor(options?: AppWindowPollingOptions)
  
  start(onUpdate: (title: string) => void): void
  stop(): void
  getWindowTitle(): string
  
  // 纯函数导出
  static detectAppCategory(title: string): AppCategory
  static getForegroundWindowTitle(): Promise<string>
}
```

### 修改: `UserBehaviorService.ts`
- 删除 `startAppPolling`, `pollForegroundWindow`, `getForegroundWindowTitle`
- 修改 `start()`: `this.appPolling.start((title) => this.onWindowTitleUpdate(title))`
- 新增 `onWindowTitleUpdate(title: string)`: 调用 `detectAppCategory` + `updateState`
- 删除 `detectAppCategory` (移到新文件)
- 修改 `stop()`: `this.appPolling.stop()`
