# Program Execution — Phase 2 (M3)

> 当前迭代状态。长期治理规则见 `project-status.md`。

## Phase 2 任务序列

| 步骤 | 内容 | 产出 | 状态 |
|------|------|------|------|
| 0 | ADR-003 冻结 | `docs/adr-003-unified-progress-observer.md` | ✅ 完成 |
| 1 | 新建 `progress.ts` — ProgressSnapshot + ProgressAnalyzer + ProgressConsumer | `src/main/core/evaluation/progress.ts` | ✅ 完成 |
| 2 | GuardrailTypes.ts 删除重复定义，引用 progress.ts | 无行为变化 | ✅ 完成 |
| 2.5 | Producer Contract 冻结（Pure Replay、幂等、不可变、Monotonicity） | ADR-003 §Producer Lifecycle Contract | ✅ 完成 |
| **3** | **新建 ProgressObserver（EventBus 订阅模式）** | **`ProgressObserver.ts`** | **⏳ 工程实现** |
| 4 | GuardrailPipeline 改为 ProgressConsumer 实现 | 架构迁移 | ⏳ |
| 5 | 打开 Chat Runtime 事件路径 | Coverage Domain 扩展 | ⏳ |

### Step 3 验收标准

| 验收项 | 要求 |
|--------|------|
| Replay Consistency | Runtime Observer 与离线 `compute()` 输出一致 |
| Producer Purity | Observer 不包含 Progress 计算逻辑，仅调用 `compute()` |
| Consumer Independence | Guardrail 仅通过 `consume()` 获取 Snapshot，不回写 Progress |
| Zero Behavior Regression | Guardrail 行为与 Phase 1 保持一致，仅改变数据流 |
| **调用点收敛** | `ProgressAnalyzer.compute()` 调用点收敛为唯一（Observer） |

## 当前禁止事项

- ❌ 不修改 GuardrailPolicy 阈值
- ❌ 不修改 ProgressAnalyzer 算法
- ❌ 不修改 GuardrailPipeline 流程
- ❌ 不修改 Event Schema / Metrics
- ❌ 不新增任何 Runtime 能力
- ❌ 不扩展 Coverage Domain（直到步骤 5）
- ❌ 不实现任何 Consumer（Guardrail 外的 Fitness/Reflection/Evolution）直到 ProgressObserver 稳定
- ❌ 不引入新的 Shared Abstraction（M3 工作纪律）

## Active Observations

| Observation | 状态 | Principal Finding |
|-------------|------|-------------------|
| v1.2 | ✅ 完成 | Guardrail MVP 在 Tool Runtime 有效；Chat Runtime 不在检测域内 |
| v1.3-post-fix | 🔄 待开始 | Guardrail 修复（reset 跨 Trace 残留 bug）部署后的 Baseline 验证 |

## Decision Gates（待触发）

- [ ] Runtime Hook 成为 ChatExecutor 性能瓶颈
- [ ] Adaptive Policy 需要历史重放且 Runtime Hook 无法满足
- [ ] 新 Runtime 无法复用现有 Guardrail

## Analysis Assets

`docs/analysis-manifest.md` — 6 个可复用脚本。

## 下一阶段预览

| 方向 | 依赖条件 |
|------|----------|
| Step 5: Chat Runtime 覆盖 | ProgressObserver 稳定 |
| Adaptive Policy | Observation 基线充足 + Architecture Pattern 迁移完成 |
| Cost Guardrail | Phase 3（独立信号） |
