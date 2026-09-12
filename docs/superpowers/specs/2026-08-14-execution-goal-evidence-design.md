# Execution Goal + Evidence Pipeline Design

Date: 2026-08-14
Status: 已实现（M6.0 / M6.1 / M6.2 核心 + Superpowers 最小桥接）

## 背景与结论

Mio 此前是"会回答的 AI"：IntentRouter 决定用不用工具，toolLoop 反复调工具直到模型自己决定停下，缺少"完成标准"与"完成判定"。

结论：不重构 AgentRuntime。最小改造路径是在现有 `IntentRouter → ToolLoop → Response` 之间补一层 **Goal + Evidence**，把 ToolLoop 从"执行工具"升级为"完成目标"。

```
用户意图
    ↓
IntentRouter（语义路由）
    ↓
ExecutionGoal（objective + successCriteria）
    ↓
ToolLoop（工具执行）
    ↓
EvidenceCollector（结构化证据）
    ↓
GoalEvaluator（完成判定）
    ↓
completed / blocked / continue
```

## 执行级 Goal（与 mission 级 Goal 分离）

现有 `cognitive.GoalEngine`（`goals` 表）是使命级目标：只有 title/progress，不参与单次任务执行。新增**执行级目标** `task_goals` 表（migration v45），两者语义隔离。

```ts
interface ExecutionGoal {
  id: string
  sessionId: string | null
  objective: string              // 用户真正想达成什么
  successCriteria: string[]      // 什么算完成
  status: 'planning' | 'executing' | 'blocked' | 'completed' | 'abandoned'
  planId: string | null          // 可选：复用 evolution DevPlan 作为任务步骤
  currentStep: number
  evidence: Evidence[]           // append-only 结构化证据
  completedAt: number | null
}
```

## 数据流

### 路由与建 Goal（ChatExecutor.run）

1. `IntentRouter` 语义分类（一次 LLM 调用），输出 `chat_only / observe_first / tool_first / tool_required`；
2. M6.2 起同一调用还输出可选 `successCriteria`（仅 tool_first/tool_required；≤4 项，JSON 校验后使用）；
3. `tool_first / tool_required` → 创建 `ExecutionGoal`，status=executing，绑定 sessionId 与活跃 plan；
   - `successCriteria` 优先用 LLM 抽取值，缺失/失败时回退 `deriveSuccessCriteria(text)` 确定性推导；
   - 创建失败仅降级（currentGoalId=null），不影响对话。

### 证据收集（toolLoop 每轮）

`ToolScheduler.executeAll()` 返回后：

1. `EvidenceCollector.collectEvidence(toolCalls, toolResults, step)` 按确定性规则分类：
   - `run_command` 输出含测试标记 → `test_result(passed/failed)`；
   - 含产物标记（created/saved/generated…）→ `artifact_created`；
   - 其余命令按成败 → `command_success / command_failure`；
   - `write/edit/move/copy/delete_file` → `file_changed`；
   - `generate_image / card_generator / social_publish` 等 → `artifact_created`；
   - 只读观察工具（list_files/read_file/grep/analyze_codebase）不产生证据。
2. `GoalPipeline.recordRound()`：追加证据 → 重新加载 Goal → `GoalEvaluator.evaluateGoal()`。
3. 判定结果：
   - 无 successCriteria → continue（无法判定，留给后续层）；
   - 测试门失败（test_result=failed）→ blocked；
   - 全部 criteria 命中 → completed；
   - 其余 → continue。
4. completed/blocked 时更新 Goal 状态、发 EventBus 事件，并向 toolLoop 注入收敛提示（不强制中断，模型自行收敛）。

## 完成率统计（Evolution 分析用）

- `ExecutionGoalStore.getStats(since?)` → `{ total, active, blocked, completed, abandoned, completionRate }`；`getMethodologyStats(since?)` 按 methodology 分组；
- `completionRate = completed / (completed + blocked + abandoned)`（已终结目标）；
- 全局共享实例 `executionGoalStore`（`src/main/goals/index.ts`），供 Evolution / 仪表盘查询；
- EventBus 事件：`execution_goal.created / completed / blocked / verified`，带 sessionId / criteria / evidenceCount / verdict。
- IPC 暴露：`evolution:goalStats` → `executionGoalStore.getStats(since)`，供 renderer / dashboard 查询；
- IPC 暴露：`evolution:goalMethodologyStats` → `executionGoalStore.getMethodologyStats(since)`；
- EvolutionAnalyzer 注入：`buildExecutionGoalContext()` 将 goal/methodology 统计追加到 analysis prompt（DB 未初始化时降级为空）；
- LLM 完成复核：`GoalPipeline.verifyCompletion()` 对 deterministic completed 做异步确认，追加 `verification` 证据并发出 `execution_goal.verified`；不改变终态；LLM 不可用时降级跳过。

## 文件地图

| 文件 | 职责 |
| --- | --- |
| `src/main/db/migration.ts` (v45/v46) | `task_goals` 表 + 索引 + methodology 列 |
| `src/main/db/schema/task_goals.ts` | drizzle schema + methodology |
| `src/main/goals/types.ts` | ExecutionGoal / Evidence / Stats |
| `src/main/goals/ExecutionGoalStore.ts` | 持久化 + 生命周期 + getStats/getMethodologyStats |
| `src/main/goals/EvidenceCollector.ts` | 确定性证据分类 |
| `src/main/goals/GoalEvaluator.ts` | 确定性完成判定（无 LLM judge） |
| `src/main/goals/GoalPipeline.ts` | 编排 + EventBus 事件 + deriveSuccessCriteria + verifyCompletion |
| `src/main/goals/GoalCompletionVerifier.ts` | LLM 完成复核 prompt + 解析 + 调用 |
| `src/main/agent/routing/types.ts` | IntentRouteDecision.successCriteria |
| `src/main/agent/routing/IntentRouter.ts` | 解析/校验 successCriteria |
| `src/main/agent/ChatExecutor.ts` | 建 Goal、ctx.activeGoalId、toolLoop 接入 |
| `src/main/agent/runstate.ts` | RunContext.activeGoalId / evidence |
| `src/main/superpowers/Methodology.ts` | 方法论 catalog + 确定性选择 + 提示注入 |
| `src/main/observability/MetricsCollector.ts` | 订阅 `execution_goal.*` 事件并计数 |
| `src/main/evolution/pipeline/EvolutionAnalyzer.ts` | 将执行目标统计注入分析 prompt |

## 验收场景（开发验收，非实验）

固定三个场景，检查"是否生成 Goal / 是否持续执行 / 是否正确判定完成"：

1. **MCP contract 修复**：`tool_required` → Goal(criteria 含测试通过) → run_command 输出 passed → completed；
2. **文件修改任务**：`tool_first` → Goal(criteria 含文件修改) → edit_file 成功 → completed；
3. **浏览器自动化任务**：`tool_first` → Goal + plan 绑定 → 工具链执行 → 按证据收敛。

## 后续（M6.2+ 可选）

- LLM 完成复核：对 deterministic completed 做异步确认（防误判），或对 continue 做收尾评估；
- Goal 状态接入 Evolution 反馈收集（`execution_goal.*` 事件已具备）；
- Superpowers 层：已实现最小桥接 `src/main/superpowers/Methodology.ts`，Goal → 确定性选择方法论 → 注入 toolLoop 提示；后续可扩展为更完整的多方法论编排。
