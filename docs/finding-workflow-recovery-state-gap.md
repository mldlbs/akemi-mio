# Finding: WorkflowRuntime Restore — Running Without Gate 恢复语义缺口

**Date:** 2026-07-19
**Context:** WorkflowRuntimeCheckpointableComponent 实现审查

---

## 发现

WorkflowRuntime restore 遇到 `status=running, no pendingGate` 的 workflow 时，当前策略是"标记手动恢复"：

```ts
// running without gate — 无法自动恢复
// 因为 executeLoop 的 promise 已丢失，无法重建并发执行
return { runId, ok: true, reason: 'running without gate — manual resume needed' }
```

这暴露了一个恢复语义缺口：

```
checkpoint restore
    ↓
workflow run = running
    ↓
没有 executor / executeLoop 引用
    ↓
永久悬挂（直到手动干预）
```

## 根因

- `executeLoop` 返回的是 in-flight Promise，checkpoint 不保存 Promise。
- restore 后无法重建正在运行的异步执行流。
- 当前只保存了 `runId` + `status`，没有保存"谁在执行"的信息。

## 临时策略（当前）

```
RUNNING (no gate)
    ↓
标记 manual resume needed
    ↓
上层决定如何处理
```

这是合理的临时策略，无需在当前阶段修复。但 Scheduler 接入后会触发此路径。

## 未来方向

未来需要明确三层恢复模型：

```ts
enum WorkflowRecoveryState {
  RESUMABLE       // 可以自动恢复（paused / waiting_gate）
  WAITING         // 需要上层触发继续（completed steps, waiting for input）
  MANUAL_RESUME   // 需要人工介入（running without gate / orphan）
}
```

期望的 Scheduler 恢复流程：

```
Runtime restore 完成
    ↓
Registry 遍历所有 CheckpointableComponent
    ↓
WorkflowRuntime.restore()
    ↓
逐 workflow 判断 RecoveryState
    ↓
  RESUMABLE   → 注册到调度器，开始等待
  WAITING     → 注册到调度器等待触发
  MANUAL_RESUME → 标记但不注册
    ↓
最终：Scheduler 持有可恢复的 workflow 列表
      不可恢复的暴露给上层（用户/系统）处理
```

## 何时解决

至少需要在以下三个条件满足后才解决：

1. Runtime restore 完整链路通过（Manager → Container → Component chain）
2. Scheduler 明确接入需求
3. 真实场景出现 running workflow 需要恢复

在此之前，`manual resume needed` 的日志足够用于调试和告警。

## References

- ADR-010 §3: 恢复流程
- ADR-010 §3.2: 失败处理（degraded 模式）
- WorkflowRuntimeCheckpointableComponent.ts:179-181
