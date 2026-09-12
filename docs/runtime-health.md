# Runtime Health

## 指标定义

### Task 生命周期指标

```
taskCreated     = RuntimeManagerImpl 创建新 task 时的 count
taskCompleted   = task 进入 completed/fulfilled 状态的 count
taskFailed      = task 进入 failed 状态的 count
taskCancelled   = task 进入 cancelled 状态的 count
taskRunning     = 当前状态为 running 的 task 数量
taskRunning30m  = running 持续时间超过 30 分钟的 task 数量
```

### Worker 指标

```
workerSpawned   = Supervisor spawnWorker 调用次数
workerCompleted = Worker 正常结束的次数
workerFailed    = Worker 异常终止的次数
workerLeak      = workerSpawned - (workerCompleted + workerFailed) 的差值
```

> `workerLeak > 0` 意味着有 Worker 未正确释放，这是最高优先级的异常。

### 状态一致性指标

```
stateMismatch   = task 的 terminal 状态与最后一次 RuntimeEvent 中的 state 不一致的数量
```

### Event 完整性指标

```
eventChainValid = 从 taskCreated → terminal event 的序列中无缺失 event 的 task 比例
```

## 数据收集方式

### 日志采集

```
[runtime] [task:<taskId>] <event_type> <state>
```

所有 Runtime 关键事件通过以下方式输出：

- `Logger.info` 记录结构化日志
- `emitter.emit(RUNTIME_EVENT.*)` 发送事件到 EventBus

### 聚合查询

可用日志查询示例：

```bash
# 统计 task 完成数
grep 'runtime.*taskCompleted' logs/current.log | wc -l

# 查找运行超时的 task
grep 'runtime.*taskRunning.*duration>1800' logs/current.log

# 查找 Worker 泄漏
grep 'workerLeak' logs/current.log

# 查找状态不一致
grep 'stateMismatch' logs/current.log
```

## 健康阈值

| 指标 | Warning | Critical | Action |
|------|---------|----------|--------|
| taskCompleted / taskCreated | < 95% | < 90% | 回退至 RC-1 |
| taskFailed（每小时） | > 5 | > 20 | 调查 root cause |
| workerLeak | > 0 | > 3 | **立即回退** |
| taskRunning30m | > 0 | > 3 | 检查是否合理（长程任务豁免） |
| stateMismatch | > 0 | > 0 | **立即调查** |
| eventChainValid | < 100% | < 95% | 调查 event 丢失原因 |

## 告警

### 自动告警条件

1. `workerLeak > 0` → 触发紧急告警
2. `stateMismatch > 0` → 触发紧急告警
3. `taskCompleted/taskCreated < 90%` → 触发告警
4. 连续 3 次同一 Task 重试失败 → 触发告警

### 告警渠道

- 日志 + EventBus 事件
- 后续接入：监控面板

## Rollback 触发条件

参见 [rc-runtime-checklist.md](./rc-runtime-checklist.md#回退流程) 中的回退条件和步骤。
