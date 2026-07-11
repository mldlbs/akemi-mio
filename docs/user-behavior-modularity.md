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
