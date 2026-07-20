# Memory Evolution v2 — Merge Boundary Audit

> Phase 2: 在合并 `feat/memory-evolution-v2` 之前确认接口依赖关系。
> 目标：回答三个问题 (A) Evolution 是否依赖 Runtime state？(B) 是否引入新的恢复需求？(C) 合并策略。

---

## A. Evolution 是否依赖 Runtime state？

**结论：不依赖。**

`SelfEvolutionService` 的输入输出：

```
MemoryService  ←  记忆上下文/画像/优先级建议
     ↑
MemoryEvolutionBridge (v2)
     ↓
SelfEvolutionService
     ↓
File System      →  evolution_state.json（自身持久化）
MemoryService    →  evolution_cycle / evolution_insight（记忆写入）
CICD             →  CICD pipeline
```

v2 新增的数据流（红框部分）全部是 **Memory → Evolution 单向**：

| 数据流 | 方向 | 来源 |
|--------|------|------|
| 记忆驱动的进化优先级建议 | Memory → Evolution | `MemoryEvolutionBridge.getTargetedEvolutionPriorities()` |
| 记忆变化事件通知 | Memory → Evolution | `onMemoryChangeEvent()` |
| 跨域关联查询 | Memory ↔ Evolution | 纯查询，无副作用 |
| 进化洞察同步 | Evolution → VectorMemory/KG | 单向写入 |

**Evolution 从不读取 Workflow state、Scheduler state、或任何 Runtime 层数据。** 它的所有输入来自 MemoryService + 文件系统。

### 当前架构关系

```
Runtime ←→ Workflow
    ↓
  Evidence
    ↓
SelfEvolution     ←  MemoryService
    ↓                    ↓
 CICD + Config        SQLite (持久化)
```

符合单向依赖：Runtime → Evidence → Evolution。Evolution 不引入 `Runtime ↔ Evolution` 双向耦合。

---

## B. Memory Evolution v2 是否引入新的恢复需求？

**结论：不引入。** 逐项检查：

### B1. Evolution 自身状态持久化

SelfEvolutionService 已有独立的文件持久化（`loadState/saveState`）：

```typescript
// 持久化字段（evolution_state.json）
{
  tryRunFailures: number,
  executeFailures: number,
  recoveryCooldownUntil: number,
  lastSuccessTime: number,
  savedAt: number
}
```

| 字段 | 是否影响运行连续性 | 恢复方式 |
|------|------------------|---------|
| `tryRunFailures` | 否 — 累积计数器，重置后从 0 开始 | 加载文件值 |
| `executeFailures` | 否 — 同上 | 加载文件值 |
| `recoveryCooldownUntil` | **是** — 阻止过早重试 | 加载文件值 |
| `lastSuccessTime` | 否 — 仅日志用途 | 加载文件值 |

**判定：无需引入 Runtime checkpoint。** SelfEvolutionService 有完全独立的持久化机制：
- Scheduler state → `evolution_state.json`
- Evolution checkpoints → SQLite `evolution_checkpoints` 表
- CICD state → `EvolutionCheckpointManager`（独立管理）
- Analysis history → MemoryService（evolution_cycle entries）

### B2. Memory Evolution 新增状态检查

| 状态 | 类别 | 是否影响连续性 |
|------|------|--------------|
| `evolution_insight` / `evolution_cycle` entries | MemoryService (SQLite) | 否 — 纯分析记录，丢失后从下次进化周期重新生成 |
| `changeSubscribers[]` | 运行时回调引用 | 否 — 启动时由 AppRuntime.setMemoryBridge() 重新订阅 |
| VectorMemory/KG 中的进化同步数据 | 可重建 | 否 — 下次进化周期自动同步 |

**判定：全部已在 MemoryService 的 SQLite 持久化覆盖范围内。** Memory v2 没有引入任何内存独占且不能重建的新状态类型。

### B3. MemoryService.addEntry 的 evolution_insight/evolution_cycle 支持

`types.ts` 中的 `MemoryEntry.type` union 增加了两个值。这是 **类型扩展**，不是状态变更。evolution 类型的 entry 和 `user_fact` 使用完全相同的 SQLite `memories` 表，无新增表或索引。

---

## C. 合并策略

### C1. 文件冲突检查

| 文件 | v2 改动 | 当前分支是否也改过 | 冲突风险 |
|------|---------|-------------------|---------|
| `SelfEvolutionService.ts` | +83 行：setMemoryBridge + onMemoryChangeEvent + 进化优先级注入 | ✅ 当前分支也改了（+29 行） | **有冲突** — 两方都改了 `runAnalysisCycle`、memoryBridge 相关区域 |
| `MemoryEvolutionBridge.ts` | 从 130 行 → 650 行：v2 深度集成 | 当前分支未改 | 无冲突 |
| `memory/types.ts` | MemoryEntry.type + `evolution_insight` \| `evolution_cycle` | 当前分支也扩展了（+VoiceBookmark 等） | **有冲突** — union 成员扩展相同位置 |
| `evolution/index.ts` | re-export 新增类型 | 当前分支也改了 | 低风险 — 仅新增 export |

### C2. 推荐合并顺序

```
1. 在当前分支合并 feat/memory-evolution-v2
   ├── SelfEvolutionService.ts   → 手动合并（两方都改了 setMemoryBridge/runAnalysisCycle）
   ├── memory/types.ts           → 手动合并（union 成员合并）
   └── evolution/index.ts        → 自动合并（仅新增 export）
```

### C3. 合并后依赖图（目标状态）

```
AppRuntime
  ├── MemoryService               ← SQLite 持久化
  │     └── MemoryEvolutionBridge  ← IMemoryPlugin 注册
  │           └── 事件通知
  ├── SelfEvolutionService
  │     ├── 引用 MemoryEvolutionBridge  ← 单向
  │     └── 自身状态 → evolution_state.json ← 文件持久化
  └── Runtime Restore (ADR-011)
        └── 不依赖 Evolution

MemoryService  ↔  SelfEvolutionService  ← 双向数据流（但通过桥接器隔离）
                                            ↑ 不是 Runtime 层耦合
```

### C4. 保持的边界

```
Runtime restore ≠ Evolution state restore

Runtime:
  └── execution continuity (scheduler / workflow)

Evolution:
  └── analysis cycle continuity (evolution_state.json)
      └── 独立于 Runtime checkpoint
```

---

## 审计结论

| 问题 | 答案 |
|------|------|
| A: Evolution 依赖 Runtime state？ | ❌ 不依赖。所有输入来自 MemoryService + 文件系统 |
| B: 引入新恢复需求？ | ❌ 不引入。SelfEvolutionService 已有独立文件持久化 |
| C: 合并策略？ | 有冲突但可控。2 个文件需要手动合并 |

**可以合并。** Memory Evolution v2 是安全的水平扩展——它扩展 MemoryService 的类型层和 SelfEvolutionService 的数据来源，但不触及 Runtime restore 边界。
