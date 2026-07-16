# RC Runtime Checklist

## Go/No-Go Checklist（RC 启动前检查）

| 检查项 | 状态 | 说明 |
|--------|------|------|
| Runtime Contract 已冻结 | ✅ | 架构边界清晰，不可逆向修改 |
| Runtime Harness 全通过 | ✅ | 单元验证通过 |
| Adapter Regression 全通过 | ✅ | SubAgentPool 行为一致性验证通过 |
| Feature Flag 默认关闭 | ✅ | 生产环境不受影响 |
| 回退路径可用 | ✅ | RUNTIME_ENABLED=0 即恢复旧路径 |
| RC 文档完成 | ✅ | 含 Go/No-Go 退出标准和回退流程 |
| Runtime 默认不影响生产 | ✅ | runtimeManager 在生产环境注入 null |

> **结论**: 满足所有前置条件，可以进入 **Go**。

---

## Phase Overview

| Phase | Default | 进入条件 | Purpose |
|-------|---------|----------|---------|
| RC-1 Shadow Mode | `RUNTIME_ENABLED=0` | Go 条件满足 | 旁路收集 Runtime 数据，回答稳定性/透明性/可观测性 |
| RC-2 Runtime Default | `RUNTIME_ENABLED=1` | RC-1 退出条件满足 | Runtime 为主执行路径，保留旧路径回退 |
| RC-3 Retirement | — | RC-2 退出条件满足 | 删除 legacy SubAgentPool，清理代码 |

---

## RC-1: Shadow Mode

### RC-1 目标

RC-1 不验证功能，而是回答三个问题：

1. **Runtime 是否稳定？** — 是否存在 Task/Worker 泄漏？是否存在非法状态转换？
2. **Runtime 是否透明？** — 开启后是否改变用户行为？是否影响旧执行路径？
3. **Runtime 是否可观测？** — Event 是否完整？Health 指标是否足够定位问题？

### 配置

```env
RUNTIME_ENABLED=0          # 默认关闭
# 仅在开发环境开启旁路收集
RUNTIME_ENABLED=1          # 开发/QA 环境
```

### 验证场景

- [ ] 正常对话（单轮/多轮）
- [ ] Tool Call 执行
- [ ] SubAgent 并发任务
- [ ] 长上下文（>8K tokens）对话
- [ ] 并发任务（>3 个同时 Worker）

### 监控指标

| 指标 | 关注点 |
|------|--------|
| Runtime Task Created | == SubAgentPool task count |
| Runtime Task Completed | 接近 100% |
| Runtime Worker Leak | 0 |
| Unfinished Task | 0（非长程任务） |
| Event 完整性 | RuntimeEvent 序列完整无缺失 |

### 退出条件（事件驱动，非时间驱动）

| 条件 | 说明 |
|------|------|
| 所有验证场景通过 | 无需完全覆盖，但需覆盖主要路径 |
| 无 Worker 泄漏 | workerLeak == 0 |
| 无 Runtime 崩溃 | 零 Runtime-related crash |
| 无回退 | 无需使用 Feature Flag 回到 RUNTIME_ENABLED=0 |
| Event 序列完整 | 所有 task 的 event chain 无缺失 |
| ChatExecutor 行为一致性 | 见下方详细定义 |
| 无新增 Bug | 无因 Runtime 旁路引入的新缺陷 |

> **时间不是条件**。如果上述条件 1 天内满足，可以提前进入 RC-2；如果 5 天后仍有异常，继续 RC-1 直到问题解决。

#### ChatExecutor 行为一致性

RC-1 必须验证 Runtime 旁路期间 ChatExecutor 的行为未受干扰：

- [ ] 相同输入得到相同执行路径（除 Runtime 内部实现差异外）
- [ ] `collectCompleted()` 收集结果与旧实现一致（task id、goal、status 匹配）
- [ ] 用户侧无新增延迟（旁路的 Runtime 操作不阻塞主路径）
- [ ] 无重复输出或遗漏输出
- [ ] SubAgentPool 行为无退化（主路径未受影响）

---

## RC-2: Runtime Default

### 配置

```env
RUNTIME_ENABLED=1          # 默认开启
RUNTIME_ENABLED=0          # 紧急回退
```

### 监控指标

| 指标 | 目标 | 说明 |
|------|------|------|
| Runtime Task Created | 与旧系统一致 | 确认所有任务正确路由到 Runtime |
| Runtime Task Completed | >99% | 任务正常完成率 |
| Failed | 可解释 | 每个 Failure 需有关联的 root cause |
| Cancelled | 可解释 | 每个 Cancellation 需有关联的上层决策 |
| Running > 30 min | 0 | 非长程任务不应超时 |
| Worker Leak | 0 | 无残留 Worker |
| Task State 一致性 | 100% | 所有 terminated task 状态 == final event state |

### 退出条件

- [ ] 所有指标达标并连续稳定运行（基于 task 量，非时间）
- [ ] 无 Runtime-related regression
- [ ] 无性能退化（P50/P95 latency）
- [ ] 无 Worker 泄漏
- [ ] Legacy task count == 0（连续数十个 task 无旧路径路由）

---

## RC-3: Retirement

### 退出条件（需要在 RC-2 稳定后逐一满足）

- [ ] Legacy Task == 0（连续 48 小时无走旧路径的 task）
- [ ] Runtime Health 连续稳定
- [ ] 无新增 Bug
- [ ] 无性能退化

### 执行步骤

1. 删除 Feature Flag `RUNTIME_ENABLED`
2. 删除 `SubAgentPoolAdapter`
3. 删除 `SubAgentPool`
4. 清理 `ChatExecutor` 构造参数（移除 `subAgentPool`）
5. 更新 ADR 状态为 **Production**

---

## 回退流程

### 回退条件

以下任一条件触发时，立即将 `RUNTIME_ENABLED` 置为 `0` 并切换回旧路径：

1. Runtime Task 完成率 < 95%
2. Worker Leak 出现
3. 对话流程异常（Agent 无法完成任务）
4. Runtime-related crash
5. P50/P95 latency 退化 > 20%

### 步骤

1. 设置 `RUNTIME_ENABLED=0`
2. 确认 ChatExecutor 恢复走 `subAgentPool` 路径
3. 确认所有活跃 Runtime Task 被正确终止或忽略
4. 保留 Runtime 日志用于事后分析
5. 创建 Bug 并关联日志
6. 修复后重新进入 RC-1
