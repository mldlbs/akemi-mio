# ADR-005：Reliability / Scale

**Status:** ✅ Design Review
**Date:** 2026-07-10
**Supersedes:** None
**Superseded by:** None
**Upstream Dependencies:**
- ADR-003 (Unified Progress Observer) — Frozen
- ADR-004 (Decision Delivery Contract) — Maintenance Mode
- M7 Governance Design Review — Gate Pass
**References:**
- M7.4.1 Replay Completeness Patch — QUERY_NO_LIMIT sentinel introduced
- GuardrailMetricsProjection — current O(n) rebuild pattern
- EvaluationStore — batch flush with DEFAULT_QUERY_LIMIT=1000
- [Post-Freeze Verification Report](/docs/adr-004-completion-review.md) — V2 Replay Integrity findings

---

## Context

ADR-004 冻结了 Evaluation Event Sourced 基础设施的核心契约。当前系统是单实例 Electron + sql.js WASM 架构，以 ~10k-50k events/day 的速率产生评估事件。随着系统持续运行，三个规模化约束开始显现：

1. **事件存储无边界增长** — evaluation_events、guardrail_decisions、guardrail_metrics 均无 retention/archive 策略
2. **Replay 不可中断** — MetricsProjection.rebuild() 是 O(n) 全量扫描，无 checkpoint/断点续传
3. **无运营 SLO** — 延迟/持久化/恢复目标未定义，无法判断何时需要投入优化

本 ADR 不引入新的 EventType、不修改 Runtime 能力边界、不改变 ADR-003/004 的冻结契约。它的职责是在现有架构内定义可扩展性的约束和目标。

### 核心问题

> Evaluation Event 基础设施如何从单实例 Electron 原型扩展到具备可靠运营特性的系统？

### 决策域

| 域 | 问题 | 优先级 |
|----|------|--------|
| R1: Event Retention | 事件保留多久？如何归档/回收空间？ | P0 — 无此策略则数据无限增长 |
| R2: Large Replay | 如何使 Replay 可中断/可续传？ | P0 — Projection rebuild O(n) 不可扩展 |
| R3: Distributed Runtime | 如何支持多实例事件排序和所有权？ | P2 — 仅定义目标架构，不实现 |
| R4: Operational SLO | 承诺什么延迟/持久化/恢复保证？ | P1 — 为 R1+R2 的 tradeoff 提供依据 |
| R5: Storage Evolution | Schema 如何演化、分区、迁移？ | P1 — 实施 R1+R2 的前提 |

---

## G0 — 范围边界

### 冻结 vs 延迟

| 主题 | 状态 | 理由 |
|------|------|------|
| R1 Retention | DESIGN REVIEW | 数据增长无边界，必须冻结策略 |
| R2 Large Replay | DESIGN REVIEW | Projection rebuild 不可扩展 |
| R3 Distributed Runtime | DEFERRED to ADR-006 | 当前单实例，仅定义目标 |
| R4 Operational SLO | DESIGN REVIEW | 为 R1+R2 决策提供依据 |
| R5 Storage Evolution | DESIGN REVIEW | 实施 R1 迁移的前提 |

### 非目标（本 ADR 不涉及）

1. **多实例实现** — R3 仅定义目标架构，不下发运行时变更
2. **EventType 变更** — ADR-003/004 的 EventType 定义保持冻结
3. **ProgressObserver 协议变更** — ProgressConsumer/ProgressAnalyzer 接口不变
4. **GuardrailPolicy 算法变更** — 阈值、信号、评分逻辑不在范围
5. **ConfigStore 架构变更** — Event-sourced projection 模式冻结于 M4.4
6. **新 EventType** — 不引入新 EventType 值
7. **备份/灾难恢复** — 文件级备份是 OS 职责
8. **性能基准测试** — SLO 定义目标，不定义基准方法

---

## R1 — Event Retention

### 现状

| 表 | 日增长率 | 当前策略 |
|----|----------|----------|
| evaluation_events | ~10k-50k 行/天 | 无 retention |
| guardrail_decisions | 等同 guardrail 检查次数 | 无 retention |
| guardrail_metrics | ~24 行/天（每小时窗口） | 无 retention |

sql.js 加载整个 DB 到 WASM 内存，文件大小直接影响堆使用。当前每 10s 通过 writeFileSync 全量导出。

### R1-A: Hot Storage Retention Policy

**问题：** 每张表在热存储（SQLite）中的保留期是多少？

**证据：**
- evaluation_events 增长最快，直接决定 sql.js WASM 堆大小
- guardrail_decisions 语义上可从 evaluation_events 推导
- guardrail_metrics 是派生投影，可完全重建
- 用户查询默认 DEFAULT_QUERY_LIMIT=1000（近期事件）
- 无 cache_size/mmap_size/page_size 配置

**决策：** 冻结以下保留目标。

| 表 | 热存储保留期 | 理由 |
|----|-------------|------|
| evaluation_events | 30 天滚动 | 覆盖典型分析窗口，控制 WASM 堆 |
| guardrail_decisions | 7 天 | 决策数据可从事件推导 |
| guardrail_metrics | 90 天 | 聚合数据体积小，保留长周期趋势 |

**延迟：**
- 可配置保留期（后续加参数）
- 按事件类型的保留期分层（当前统一对待）

### R1-B: Archive Lifecycle

**问题：** 如何在超出热存储保留期后保留事件？

**证据：**
- sql.js 不支持增量导出，只有全量 export()
- 归档目标基础设施尚未建设
- 归档后重放需要归档阅读器

**决策：**

1. **归档格式：** NDJSON（Newline-Delimited JSON），每日一个文件，gzip 压缩
   - 文件名：`evaluation_events_YYYY-MM-DD.ndjson.gz`
   - 每行：完整 EvaluationEvent JSON
   - 理由：简单、可流式读取、不依赖 WASM SQLite

2. **归档触发：** 基于时间（每日），非基于大小
   - 系统空闲时段执行（默认 02:00）
   - 归档所有 `timestamp < (now - hot_retention_days)` 的事件

3. **归档存储：** 文件系统目录 `<WORKSPACE_ROOT>/archive/evaluation_events/`
   - 延迟：S3/GCS/Azure Blob 连接器（多实例后再需要）

4. **归档后删除：** `DELETE FROM evaluation_events WHERE timestamp < cutoff`
   - 在 sql.js 单线程模型内事务安全
   - 分批 DELETE（每次 500 行）避免 WASM 内存压力

**延迟：**
- 归档阅读器 API（查询冷存储）
- 归档校验（checksum、完整性检查）
- 自动从归档恢复缺失的热数据

### R1-C: Partition Strategy

**问题：** evaluation_events 表需要分区吗？

**证据：**
- sql.js 是单文件 SQLite，无原生分区支持
- 所有查询使用 (timestamp) 或 (trace_id, timestamp) 索引
- DELETE 做 retention 是 O(rows) + 索引

**决策：** 热存储不做表分区。
- DELETE-based retention 在当前规模下足够
- 归档文件本身就是按天隐式分区（NDJSON 文件）
- 如果热存储超过 500k 事件仍未触发归档，评估分区

**不变量 R1-I1：** 归档文件是 append-only。写入后永不修改。归档后删除热事件是最佳努力优化，不是持久化要求。

**不变量 R1-I2：** 热存储保留期是软限制。超出目标时不崩溃、不降级。retention 执行是最佳努力。

### R1-D: Freeze Boundary — F1 RetentionScheduler Startup Jitter

**现状：** AppRuntime.initRetentionScheduler() 在启动时立即执行一次 retention cycle。

**决策：** 启动仅注册调度，首执行加 random jitter。

```
Startup:
  schedule registration only    // 不立即执行
First execution:
  delay = random(300000, 1800000)  // 5min ~ 30min
Subsequent:
  daily 02:00
```

**不变量 R1-I3：** RetentionScheduler 启动执行不早于启动后 5 分钟。

**理由：** 多实例同时启动时，立即执行会导致所有实例同时做 archive + DELETE。sql.js WASM 多进程写同一 DB 文件出现竞争。当前单实例无需紧急处理，jitter 对规模变化友好。

### R1-E: Freeze Boundary — F2 Archive Manifest Integrity

**现状：** 归档仅输出 NDJSON gzip 文件，无校验清单。Archive 当前做"备份"而非"replay source"。

**决策：** Manifest 文件延迟实现。当前 NDJSON 格式保留。

```
Current:
  archive/evaluation_events_2026-07-10.ndjson.gz
  (仅原始数据，无元数据)

Future (Gate 3 or Maintenance):
  archive/evaluation_events_2026-07-10.ndjson.gz
  archive/evaluation_events_2026-07-10.manifest.json
  manifest: { firstSeq, lastSeq, count, checksum, createdAt }
```

**理由：** Archive reader API（按 seq/timestamp 范围查询冷存储）需要 manifest 提供范围查询和完整性验证。manifest 的设计依赖 archive reader 的查询需求，reader 未实现前先定义 manifest 会过度设计。

---

## R2 — Large Replay

### 现状

| 消费者 | 当前行为 | 问题 |
|--------|----------|------|
| GuardrailMetricsProjection.rebuild() | clear + build(0) | 无 checkpoint，中断后从头开始 |
| GuardrailMetricsProjection.build(since) | fetch all from since，内存分组 | O(n) 全量扫描 |
| AuditVerifier.verifyAll() | QUERY_NO_LIMIT | 无界查询 |
| OutcomeStore.getAllOutcomeEvents() | QUERY_NO_LIMIT | 无界查询 |
| GuardrailHealthService.verifyProjectionConsistency() | QUERY_NO_LIMIT | 无界查询 |

核心问题：没有 seq 列导致无法使用游标，没有 checkpoint 导致中断后从头开始。

### R2-A: Sequence Number Column

**问题：** 什么机制提供有序、可恢复的 evaluation_events 迭代？

**证据：**
- (timestamp) 索引有碰撞（同一毫秒多个事件）
- (trace_id, timestamp) 是 per-trace，不是全局
- sql.js ROWID 在 DELETE+VACUUM 后不可靠
- 单调递增的 seq 能支持 checkpoint 断点续传

**决策：** 为 evaluation_events 表增加 seq 列。

```sql
ALTER TABLE evaluation_events ADD COLUMN seq INTEGER;
CREATE INDEX IF NOT EXISTS idx_ev_seq ON evaluation_events(seq);
```

- seq 在 flush() 时分配（不在 append()，因为 batch flush 一次性写入多个）
- 已有行回填为 NULL（不要求完整性）
- Migration v33：加列 + 从当前 max+1 开始分配

**用法：**
- Replay/Projection：`SELECT ... FROM evaluation_events WHERE seq > ? ORDER BY seq ASC LIMIT ?`
- Catch-up：在内存（ProgressObserver）或 checkpoints 表（projections）中记录最后处理的 seq

**延迟：**
- 多实例 seq 生成（要求分布式序列）— R3 域
- seq 间隙（正常现象：batch flush 跳过空批次）— consumer 通过追踪 max(seq) 处理

### R2-B: Checkpoint Table for Projection Replay

**问题：** 如何使 projection rebuild 在中断后可恢复？

**证据：**
- GuardrailMetricsProjection.rebuild() 全有或全无：clear + 全量重扫
- GuardrailConfigStore.loadFromEvents() 全有或全无：clear + 全量重放
- 在 500k+ 事件规模下，全量扫描可能阻塞事件循环数秒

**决策：** 创建 projection_checkpoints 表。

```sql
CREATE TABLE IF NOT EXISTS projection_checkpoints (
    projection_name TEXT PRIMARY KEY,
    last_seq INTEGER NOT NULL,
    last_updated_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle'
      CHECK(status IN ('idle', 'running', 'failed')),
    error TEXT
);
```

**行为：**
1. 构建前：`INSERT OR UPDATE status='running', last_seq=checkpoint`
2. 构建中：每 N 事件（默认 500）更新 last_seq
3. 完成时：`status='idle', last_seq=final`
4. 重启时：读取 last_seq，从 `seq > last_seq` 继续
5. 失败时：`status='failed'`，下次从最后 checkpoint 重试

**不变量 R2-I1：** Checkpoint 是最佳努力。从 seq=0 的全量 rebuild 必须语义正确。Checkpoint 仅减少恢复时间。

**不变量 R2-I2：** Checkpoint 表不是 Event-sourced。它是运营元数据，不是审计数据。丢失 checkpoint 表意味着全量重建，不是数据丢失。

### R2-C: Incremental Projection Contract

**问题：** Projection build 契约从全量扫描改为增量？

**证据：**
- GuardrailMetricsProjection.compute() 已是纯函数
- build(since) 从 timestamp 获取全部事件，按小时窗口分组
- compute() 是幂等的（相同事件 + 相同窗口 = 相同行）
- 唯一缺失的是"我已经处理了哪些事件？"

**决策：** 采用增量构建作为主路径。

**契约：**
```
loadCheckpoint(projection_name) → last_seq
fetchUnprocessed(last_seq) → EvaluationEvent[] (使用 idx_ev_seq)
groupByHourWindow(events)
for each window: compute(events, since, until) → MetricsRow; upsert
saveCheckpoint(projection_name, max_seq)
```

**全量重建路径保留：**
- Rebuild = clear checkpoint + build from seq=0
- 必须保持有效且产生相同结果

**延迟：**
- ConfigStore 迁移到 checkpointed replay（当前使用 loadFromEvents + timestamp 排序）
- 安全延迟，因为 ConfigStore 事件量很小（每次激活 1-2 条）

### R2-D: Cursor-Based Internal Queries

**问题：** 内部查询路径从无界改为游标式？

**决策：** 冻结规则：

> 所有可能超过 DEFAULT_QUERY_LIMIT 的内部查询路径必须使用 seq-based cursor 迭代，不得使用 QUERY_NO_LIMIT。

保留 QUERY_NO_LIMIT 的角色：
- 保留用于启动引导（ConfigStore.loadFromEvents 在零状态下启动）
- 对定时/后台批量处理路径废弃
- 新批量处理代码不得使用 QUERY_NO_LIMIT

**不变量 R2-I3：** seq-based cursor 查询为 replay consumer 提供恰好一次语义。每个 projection 构建周期中，每条事件被精确处理一次。seq 间隙（batch flush 跳过空批次）由 checkpoint 记录 max(seq) 而非 count(rows) 处理。

---

## R3 — Distributed Runtime（目标架构）

### 现状
- 单进程 Electron
- sql.js WASM（单线程，无并发访问）
- 无多实例支持、无事件所有权模型、无重复检测

### R3-A: Target Event Ordering Model

**问题：** 多实例场景下如何跨实例排序事件？

**证据：**
- EvaluationEvent.timestamp 是时钟时间（Date.now()）— 无同步
- seq 在当前单进程模型中由 flush() 分配
- 多实例：每个进程独立分配 seq = 冲突

**决策（仅定义目标，不实现）：**

目标事件排序：
1. 每个实例获得唯一 instance_id（UUID，启动时分配）
2. Event seq = 混合逻辑时钟（HLC）时间戳 + instance_id 打破平局
3. Replay 游标使用 HLC + instance_id 作为复合游标

**冻结：**
- 排序模型是分布式运行时决策
- 实现基础设施（共享 DB、事件总线、共识）显式延迟

**延迟：**
- 分布式 seq 生成实现
- 共享数据库或事件总线选择
- 共识协议选择
- 实例发现和健康检查

### R3-B: Target Event Ownership Model

**问题：** 多实例系统中谁拥有哪些事件？

**决策（仅定义目标，不实现）：**

1. Trace 亲和性：trace T 的事件由执行 trace T 的实例 I 产生
2. 所有权不强制执行 — 任何实例可读任何 trace 的事件
3. 写入所有权：实例 I 是 trace T 事件的主要写入者
4. 来自不同实例对同一 trace 的并发写入 = 可被 HLC 排序检测

**不变量 R3-I1：** 事件所有权是写入优化，不是一致性要求。系统必须在违反所有权约束时正常运作（性能降级）。

### R3-C: Target Duplicate Handling

**问题：** 系统如何检测和处理重复事件？

**决策（仅定义目标，不实现）：**

1. Event.id (UUIDv4) 是去重键 — 每事件全局唯一
2. 存储层：`INSERT OR IGNORE ON event.id`（幂等写入）
3. Replay：游标式迭代自然跳过重复（相同 seq = 已处理）
4. 读取者：evaluate() 必须幂等（已在 ADR-003 Producer Contract 中冻结）

**不变量 R3-I2：** 事件去重是读取侧关注点。写入者总是 append。读取者检测并跳过。这保持了 append-only 日志语义。

---

## R4 — Operational SLO

### 现状

- 无文档化的延迟目标
- 无 RPO/RTO 定义
- 持久化：at-most-once delivery（事件在 flush 失败时丢失）
- DB 导出：每 10s（writeFileSync 全量 DB）
- 崩溃恢复：重启时从文件系统导出文件重新加载

### R4-A: Event Production Latency Budget

**问题：** 从 Runtime 事件发射到持久化存储的可接受延迟是多少？

**证据：**
- 当前 batch flush：最多 50 事件或 1s 间隔
- ADR-004 D1-D4 要求 guardrail 决策同步投递
- 非控制流事件（model.completed, tool.completed）无延迟要求
- 事件生产是非阻塞的 — append() 立即返回，flush 异步

**决策：**

| 层级 | 事件类型 | 目标 | 测量 | 理由 |
|------|---------|------|------|------|
| P0 | guardrail.terminated | < 100ms 到 flush | P90 | D2 要求同轮次投递 |
| P1 | guardrail.*, task.*, workflow.* | < 1s 到 flush | P90 | 时间线正确性 |
| P2 | model.*, tool.*, user.*, agent.* | < 5s 到 flush | P95 | 无控制流依赖 |

**执行：**
- 当前 batch flush（50/1s）满足 P1/P2 目标
- P0（guardrail.terminated）要求立即 flush：在 terminate 路径上调用 forceFlush()
- 不修改 batch flush 机制

**延迟：**
- 按事件类型的延迟监控（仪表盘指标）
- 基于延迟预算的自适应批次大小

### R4-B: Durability Guarantee

**问题：** Evaluation Event Store 提供什么持久化保证？

**证据：**
- 当前：at-most-once delivery，事件在 flush 失败时丢失
- sql.js 没有 WAL flush 保证（PRAGMA WAL 已设置但数据保留在 WASM 内存中）
- 周期性导出（10s）是唯一的持久化副本
- 导出和上次 flush 之间的电源故障 = 事件丢失

**决策：** 将当前持久化模型记录为设计意图。

持久化模型：At-Most-Once with Best-Effort Persistence

1. 批次缓冲区中的事件（未 flush）：崩溃时丢失
2. flush 到 sql.js WASM 的事件：如果导出及时则存活
3. 导出的文件中的事件：在完整系统重启后存活
4. 最大数据丢失窗口：10s（导出间隔）+ 1s（flush 间隔）= 11s 窗口

RPO（Recovery Point Objective）：最多 11 秒的事件数据可能丢失。
- 当前非关键评估数据可接受
- Guardrail 决策：P0 事件（terminate）已立即 force-flushed

RTO（Recovery Time Objective）：< 5 秒
- 文件读取 + WASM 初始化 < 1s
- Migration 重放 < 1s
- Catch-up 重放：在 60s 窗口内

**不变量 R4-I1：** 事件持久化是 at-most-once 设计。未来升级到 at-least-once 不得改变 EvaluationRepository.append() API 签名（与 ADR-003 consumer 契约稳定性一致）。

**不变量 R4-I2：** 11s 丢失窗口是最大值，不是典型值。正常活跃事件生产中，实际窗口约 1s（flush 间隔）。P0 事件的 forceFlush() 将 guardrail 决策的丢失窗口降至接近零。

### R4-C: Recovery Objectives

**问题：** 崩溃后 projection rebuild 的恢复目标是多少？

**决策：**

按组件的 RTO：
- EvaluationEvent 读取路径：< 1s
- GuardrailConfigStore：< 100ms
- GuardrailMetricsProjection：< 5s（当前规模），< 30s（500k 事件）
- ProgressObserver catch-up：在 60s 时钟时间内
- GuardrailHealthService：< 5s

恢复策略：
1. 文件系统 DB 文件是恢复源
2. 启动时：加载 DB 文件 → 运行迁移 → 启动 store → 启动 observer
3. Projection 独立重建（非阻塞启动）
4. Metrics projection 重建是异步的 — 系统在指标陈旧时仍可工作
5. ConfigStore 重放同步 — 系统等待配置就绪后启动

---

## R5 — Storage Evolution

### 现状
- 32 个版本，通过 _migrations 追踪表顺序应用
- 无回滚支持 — 所有迁移是只增的
- 无迁移验证（schema 或数据完整性检查）
- 无 dry-run 模式

### R5-A: Migration Validation Gate

**问题：** Schema 迁移在应用前必须通过哪些验证？

**决策：** 冻结迁移验证门：

迁移必须通过：
1. **Schema-only**：CREATE TABLE/INDEX 语句对 SQLite 有效
2. **Data-preserving**：仅 ALTER TABLE ADD COLUMN（无 DROP/无 RENAME 无安全检查）
3. **Rollback-defined**：每个迁移 vN 必须有 vN_revert SQL（可为 no-op）
4. **Foreign-key-safe**：新 FK 约束必须引用现有表
5. **Index safety**：索引创建使用 IF NOT EXISTS（已在执行）

回滚契约：
- Revert 必须恢复 schema 到迁移前状态
- Revert 不恢复 DROP TABLE/DROP COLUMN 丢失的数据
- Revert 是手动的（操作员触发），非自动

### R5-B: Backfill Strategy

**问题：** Schema 迁移添加列时，如何回填现有行？

**决策：**

1. 新列：`ALTER TABLE ADD COLUMN col_name TYPE [DEFAULT value]`
2. 现有行保留 NULL 除非指定 DEFAULT
3. 现有行回填是异步且最佳努力的
   - 迁移后作为独立步骤运行（不在迁移 SQL 中）
   - 可使用批量 UPDATE（每次 500 行）
   - 不得阻塞读取
4. 读取列的代码必须处理 NULL（或调用者提供默认值）
5. 未来对回填列施加 NOT NULL 需要在回填验证后进行独立迁移

### R5-C: Migration Rollback Protocol

**问题：** 如何支持已部署的 schema 迁移回滚？

**决策：**

回滚流程（手动的，非自动的）：

1. 每个迁移 vN 可以在 MIGRATIONS 数组中定义 `vN_revert`：
   ```typescript
   { version: N, sql: '...', revert?: '...' }
   ```

2. Revert 通过恢复工具由操作员应用，非启动时

3. 回滚策略：
   - 增量的变更（ADD COLUMN）：no-op revert（列保留，代码忽略）
   - 破坏性变更（DROP/RENAME）：必须定义 revert SQL
   - 索引变更：DROP INDEX 移除，revert = CREATE INDEX

4. 回滚前提：
   - revert 操作不能导致数据丢失
   - 如果 revert 会导致数据丢失，迁移不可逆转
   - 不可逆迁移必须在迁移条目中记录

5. 版本恢复：
   - 回滚时 _migrations 表不修改（版本保持已应用状态）
   - 后续前向迁移版本处理修正
   - 这使版本序列单调递增

**不变量 R5-I1：** 所有迁移是增量且向后兼容的。无迁移可删除列、更改列类型、或对现有列添加 NOT NULL 约束。

**不变量 R5-I2：** _migrations 表是 append-only。版本从不移除。回滚通过修正性前向迁移实现，不是通过删除版本条目。

---

## 冻结决策汇总

| 域 | 决策 | 冻结内容 | 延迟项 |
|----|------|----------|--------|
| R1-A | 30d evaluation_events / 7d decisions / 90d metrics | 保留策略目标 | 可配置层级 |
| R1-B | NDJSON 每日归档文件 | 归档格式和触发 | 归档阅读器 API、S3 连接器 |
| R1-C | 热存储不分表分区 | 当前架构 | 未来分片 |
| F1 | RetentionScheduler startup jitter | 首执行加 random(5min, 30min) 延迟 | 下轮 retention 维护 |
| F2 | Archive manifest integrity | NDJSON 格式保留，manifest 延迟 | Gate 3 archive reader |
| R2-A | evaluation_events 增加 seq 列 | Seq 作为 replay 游标 | 多实例 seq 生成 |
| R2-B | projection_checkpoints 表 | Checkpoint 契约 | ConfigStore 迁移 |
| R2-C | 增量构建为主路径 | 增量契约 | - |
| R2-D | 批量内部查询须用 seq 游标 | 游标规则 | - |
| R3-A | HLC + instance_id 打破平局（目标） | 排序模型 | 分布式 seq 实现 |
| R3-B | Trace 亲和性作为写入优化 | 所有权模型 | 共享 DB/事件总线 |
| R3-C | UUIDv4 id 为去重键 | 去重键 | 实现 |
| R4-A | 3 层事件生产延迟预算 | 延迟目标 | 按类型监控 |
| R4-B | At-most-once 最佳努力持久化 | 持久化模型 | At-least-once 升级 |
| R4-C | 组件级 RTO | 恢复目标 | 温备 projection |
| R5-A | 迁移验证门：5 项检查 | 验证契约 | CI 自动化测试 |
| R5-B | 仅增量列，异步回填 | 回填策略 | - |
| R5-C | 修正前向迁移实现回滚 | 回滚协议 | - |

---

## 架构不变量

| # | 不变量 | 域 | 违规示例 |
|---|--------|----|----------|
| R1-I1 | 归档文件是 append-only，永不修改 | R1 | 重写归档文件以修正数据错误 |
| R1-I2 | 热保留是软限制，超出时不崩溃 | R1 | 因 evaluation_events 超出 30 天目标而崩溃 |
| R1-I3 | RetentionScheduler 启动执行不早于 5 分钟 | R1 | 启动后立即执行 archive+DELETE |
| R2-I1 | 从 seq=0 的全量 rebuild 必须与增量产生相同结果 | R2 | 增量路径产生与全量 rebuild 不同的指标 |
| R2-I2 | Checkpoint 表丢失意味着全量重建，非数据丢失 | R2 | 因 checkpoint 表被删除而无法恢复 |
| R2-I3 | seq-based 游标在每 projection 周期内提供恰好一次语义 | R2 | 同轮重建中同一事件被处理两次 |
| R3-I1 | 事件所有权是写入优化，非一致性要求 | R3 | 因错误实例拥有事件而无法读取 |
| R3-I2 | 事件去重是读取侧关注点，写入者总是 append | R3 | 写入者在 append 前检查重复 |
| R4-I1 | At-most-once 交付是设计意图；升级不改变 append() API | R4 | 增加交付保证改动了 append() |
| R4-I2 | 11s 丢失窗口是最大值；P0 事件 force-flushed | R4 | Guardrail terminate 事件等待 batch flush 计时器 |
| R5-I1 | 所有迁移是增量和向后兼容的 | R5 | v33 从 evaluation_events 删除列 |
| R5-I2 | _migrations 表是 append-only；回滚是修正前向 | R5 | 回滚删除 _migrations 中的版本 N |

---

## 实施阶段

### Gate 1: R2 Large Replay + R4 SLO

基础 — seq 列、checkpoint 表、游标迭代
依赖：R5 迁移用于 seq 列添加

- v33 迁移：ADD COLUMN seq to evaluation_events + idx_ev_seq 索引
- projection_checkpoints 表（v34 迁移）
- EvaluationStore：flush 时分配 seq，新增 seq-based 查询方法
- GuardrailMetricsProjection：增量构建 + checkpoint 游标迭代
- GuardrailHealthService：游标式 verifyProjectionConsistency
- OutcomeStore：游标式迭代（废弃 QUERY_NO_LIMIT）
- AuditVerifier：游标式迭代（废弃 QUERY_NO_LIMIT）
- ProgressObserver：checkpoint 持久化
- GuardrailPipeline：forceFlush() on guardrail.terminated（R4 P0）

### Gate 2: R1 Event Retention + R5 Storage Evolution ✅ FROZEN

归档基础设施、retention 执行
依赖：Gate 1 seq 列用于归档游标

- EventArchiver 模块（NDJSON 写入器、每日触发、gzip） ✅
- Retention 调度器（基于时间的 DELETE） ✅
- 迁移验证门实施 ✅
- 回滚协议工具 ✅
- GuardrailMetricsStore retention（90d） ✅
- 归档目录结构和配置 ✅

冻结边界：
- F1: RetentionScheduler startup jitter — 首执行加 random(5min, 30min) 延迟
- F2: Archive manifest — 延迟到 Gate 3 或 maintenance 实现

### Gate 3: Design Reserved 📋

仅架构文档，无生产代码
依赖：无（仅设计）

- ADR-006 草案（分布式运行时）
- HLC 排序原型（可选，用于验证）
- 所有权模型模拟（概念性）

---

## 验证清单

### Gate 1: Replay + SLO

| 检查 | 方法 | 标准 |
|------|------|------|
| seq 列存在 | 读 evaluation_events schema | seq INTEGER 列存在，idx_ev_seq 索引存在 |
| Checkpoint 表存在 | 读 schema | projection_checkpoints 表列正确 |
| 增量 build 匹配全量 rebuild | 对相同事件集运行两个路径 | MetricsRow 逐字段相同 |
| Checkpoint 续传正确性 | 中途中断 build，重启 | 从 checkpoint 继续，无事件跳过或重复 |
| Force flush on terminate | 追踪 terminate 路径 | guardrail.terminated 后调用 forceFlush() |
| seq 游标替换 QUERY_NO_LIMIT | 审计所有内部查询路径 | 无批量/后台路径使用 QUERY_NO_LIMIT |
| RTO 合规 | 用生产 DB 测量启动时间 | ConfigStore <100ms，Metrics <5s |

### Gate 2: Retention + Migration

| 检查 | 方法 | 标准 |
|------|------|------|
| 归档产生有效 NDJSON | 运行归档，读首文件 | 文件 gzip，每行是有效 JSON EvaluationEvent |
| 归档数据正确 | 归档与热 DB retention 后比较 | timestamp < cutoff 的事件全部在归档中 |
| 热 retention DELETE 成功 | retention 后计数 evaluation_events | 行数符合预期 |
| 迁移验证门 | 用测试应用 v33 迁移 | 5 项检查全部通过 |
| 回滚 revert SQL | 应用 v33，再应用 revert | Schema 恢复到 v33 前状态 |
| Backfill 处理 NULL | 读前 v33 行的 seq 列 | NULL 值不导致任何代码路径崩溃 |
| F1: Startup jitter | 启动后 retention 首次执行时间 | 不早于启动后 5 分钟 |
| F2: Archive manifest | manifest 文件存在性（未来） | 实现时验证 firstSeq/lastSeq/checksum |

---

## 文件清单

### 新建文件

| 文件 | 职责 |
|------|------|
| docs/adr-005-reliability-scale-design-review.md | 本文档 |
| src/main/db/schema/projection_checkpoints.ts | Drizzle schema for checkpoints table |
| src/main/core/evaluation/EventArchiver.ts | 归档模块 |
| src/main/core/evaluation/CheckpointTracker.ts | Checkpoint 读写 |
| src/main/core/evaluation/__tests__/r2-checkpoint-resume.test.ts | Gate 1 验证 |
| src/main/core/evaluation/__tests__/r1-archive-retention.test.ts | Gate 2 验证 |

### 修改文件

| 文件 | 变更 |
|------|------|
| src/main/db/migration.ts | v33: ADD COLUMN seq, v34: projection_checkpoints |
| src/main/db/schema/evaluation_events.ts | 加 seq 字段 |
| src/main/core/evaluation/EvaluationStore.ts | flush 时分配 seq, cursor 查询 |
| src/main/core/evaluation/GuardrailMetricsProjection.ts | 增量 build + checkpoint |
| src/main/core/evaluation/GuardrailHealthService.ts | cursor 式 verification |
| src/main/core/evaluation/OutcomeStore.ts | cursor 式迭代 |
| src/main/core/evaluation/AuditVerifier.ts | cursor 式迭代 |
| src/main/core/evaluation/ProgressObserver.ts | checkpoint 持久化 |
| src/main/core/evaluation/GuardrailPipeline.ts | forceFlush() on terminate |

### 未修改（明确排除）

| 文件 | 理由 |
|------|------|
| GuardrailConfigStore.ts | 事件量低，游标迁移延迟 |
| GuardrailPolicy.ts | 算法、阈值、信号不在范围内 |
| GuardrailTypes.ts | 事件类型 schema 冻结 |
| types.ts | 事件 schema 冻结 |
| GuardrailTypes.ts | 事件类型 schema 冻结 |
| db/connection.ts | 初始化/关闭流程不变 |
