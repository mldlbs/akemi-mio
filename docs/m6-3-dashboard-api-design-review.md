# M6.3 Dashboard/API Design Review

> **Phase:** ADR-004 M6.3
> **Status:** Design Review
> **Date:** 2026-07-10
> **Entry Gates:** M6.2.1 ✅ — Runtime Wiring Gate Pass
> **Entry Constraints:** 四条入口冻结约束（见下文）

---

## S1 — API Boundary

### Truth Source

```
[GuardrailMetricsStore]  ←── 只读
       ↑
[GuardrailMetricsProjection]  ←── 唯一写入路径
       ↑
[EvaluationStore]
```

- **API 只能读取 `GuardrailMetricsStore`**。不允许在线扫描 `EvaluationEvent`，不依赖 `DecisionStore`。
- 当前 `GuardrailMetricsStore` 提供：
  - `getSummary()` — 全量聚合
  - `query(windowSince, windowUntil)` — 时间窗口扫描
  - `getLatest()` — 最新窗口
  - `getLastUpdateTimestamp()` — 投影时间戳
- Dashboard/API 是**观察层**，不触发 policy evaluation，不修改 ConfigStore，不产生 lifecycle event。

### Integration Path

**Electron IPC handlers**（与 M5.3 DecisionQueryService 一致）：

```
main process: registerHandlers() → ipcMain.handle('guardrail:metrics:*', ...)
preload:      electronAPI.getGuardrailMetricsSummary()
              electronAPI.queryGuardrailMetrics(range)
              electronAPI.getGuardrailMetricsLatest()
              electronAPI.getGuardrailProjectionState()
renderer:     window.electronAPI.getGuardrailMetricsSummary()
```

Push-based 实时推送复用已有 `monitoring:metrics` 推送通道，将 guardrail metrics 纳入统一监控数据推送（推荐），或独立建立 `guardrail:metrics:update` 推送通道。

**IPC Channel Design:**

| Channel | Type | Direction | Payload |
|---------|------|-----------|---------|
| `guardrail:metrics:summary` | invoke | Renderer → Main | `MetricsSummary` |
| `guardrail:metrics:query` | invoke | Renderer → Main | `(since, until) → MetricsRow[]` |
| `guardrail:metrics:latest` | invoke | Renderer → Main | `MetricsRow \| null` |
| `guardrail:metrics:state` | invoke | Renderer → Main | `ProjectionState` |
| `guardrail:metrics:update` | event | Main → Renderer | `MetricsRow`（新窗口完成时推送） |

### Channel 职责冻结

| Channel | 用途 | 不允许 |
|---------|------|--------|
| `metrics.summary` | 聚合概览 | — |
| `metrics.query` | 时间范围查询 | — |
| `metrics.latest` | 最近窗口 | — |
| `metrics.state` | projection 状态 | — |
| (内部) | — | `metrics.rebuild`, `metrics.clear`, `metrics.upsert` |

写操作（rebuild / clear / upsert）保持在 `GuardrailMetricsProjection` 内部，不暴露到 IPC 层。Dashboard 和管理界面后续如需管理端点，通过专门的 admin channel（`guardrail:admin:*`  defer 到 M6.4）。

> **Decision:** 首版只实现 invoke 型查询，event 推送作为可选优化。不降低首版复杂度。

### Service Layer

新增 `GuardrailMetricsQueryService`（与 `DecisionQueryService` 同级），封装 `GuardrailMetricsStore` 查询并添加 projection state 语义。

```
class GuardrailMetricsQueryService {
  constructor(
    private metricsStore: GuardrailMetricsStore,
    private projection: GuardrailMetricsProjection,
  ) {}

  async getSummary(): Promise<MetricsSummary>
  async queryTimeRange(since: number, until: number): Promise<MetricsRow[]>
  async getLatest(): Promise<MetricsRow | null>
  async getProjectionState(): Promise<ProjectionState>
}
```

---

## S2 — Query Model

### 首版支持的查询

**1. Metrics Summary**
```typescript
interface MetricsSummaryResponse {
  totalChecked: number
  totalWarning: number
  totalTerminated: number
  totalContinue: number
  totalSignalsHealthy: number
  totalSignalsDegrading: number
  totalSignalsStalled: number
  windowCount: number
}
```

直接映射 `GuardrailMetricsStore.getSummary()`。零额外计算。

**2. Time Range Query**
```typescript
interface TimeRangeQuery {
  since: number  // Unix ms
  until: number  // Unix ms
}

interface TimeRangeResponse {
  windows: MetricsRow[]
  totalWindows: number
  queryRangeMs: number
}
```

直接映射 `GuardrailMetricsStore.query(since, until)`。空窗口返回 `{ windows: [], totalWindows: 0 }`。

**3. Latest Window**
```typescript
interface LatestWindowResponse {
  window: MetricsRow | null
  updatedAt: number | null
}
```

直接映射 `GuardrailMetricsStore.getLatest()`。

### 首版不支持的查询（冻结 defer）

| 查询 | 原因 | 预计 defer 到 |
|------|------|---------------|
| `policyVersion` breakdown | 当前 schema 无此列 | M6.4 Feedback Loop |
| `action` breakdown | 当前 schema 无此列 | M6.4 |
| 逐 event 原始数据 | 违反 S1 约束 | 永不 |
| 通用 analytics SQL | 违反 Query Contract 限制 | 永不 |

> **Decision:** 如果 M6.3 实现前 policyVersion/action breakdown 需求优先级提升，可以在 M6.2 投影层先扩展 schema，再进入 M6.3 实现。否则 defer 到 M6.4。

---

## S3 — Consistency Semantics

### Projection State Model (Separate API)

GuardrailMetrics 不是实时镜像，而是一个**周期重建的投影**。**projection state 通过独立 API 查询，不耦合到数据响应模型：**

```
GuardrailMetricsQueryService
        |
        +-- query result       → data API (summary / query / latest)
        |
        +-- getProjectionState() → state API (metrics.state)
```

```typescript
type ProjectionState =
  | { status: 'READY'; lastBuiltAt: number; windowCount: number }
  | { status: 'REBUILDING'; startedAt: number; windowsBuilt: number }
  | { status: 'UNAVAILABLE'; reason: string }
```

| State | Meaning | Occurrence |
|-------|---------|------------|
| `READY` | 投影已完成最近一次构建或重建 | 正常运行时 |
| `REBUILDING` | `rebuild()` 或增量 `build()` 正在进行中 | 启动时、Config 变更后 |
| `UNAVAILABLE` | MetricsStore 不可达或从未构建过 | DB 错误、首次启动 |

### State Transitions

```
UNAVAILABLE ──build()──→ REBUILDING ──complete──→ READY
                              ↑                      │
                              └────rebuild()─────────┘
```

### When Projection Not READY

- **数据 API**（summary / query / latest）正常返回当前投影数据（可能是旧数据），不携带 state。
- **状态 API**（metrics.state）返回准确的非 READY 状态。
- Consumer 同时调用数据 API + 状态 API，UI 在数据旁显示 "Metrics 正在重建中" 提示，不隐藏数据。

> **Design Rationale:** 未来 Dashboard 可能同时展示 metrics + ingestion lag + rebuild 状态。不应该让每个 metric DTO 继承基础设施状态。

### 运行时写入对查询的影响

| 操作 | 对 API 响应的影响 |
|------|-------------------|
| 增量 `build(since)` | 已有窗口不变，新增/更新 upsert → 后续查询可见 |
| 全量 `rebuild()` | 先清空 → `UNAVAILABLE` → 逐步填充 → `READY` |
| MetricsProjection 未运行 | 状态保持上次完成时的数据，无更新 |

---

## S4 — Access/Control Boundary

### 严格禁止的 API

| 行为 | 约束 |
|------|------|
| 通过 API 触发 ConfigStore.activateConfig() | 禁止 |
| 通过 API 修改 Policy | 禁止 |
| 通过 API 产生 EvaluationEvent | 禁止 |
| 通过 API 触发 projection rebuild（除明确的管理端点） | 禁止（首版无管理端点） |
| 直接暴露 GuardrailMetricsStore 到 renderer context | 禁止 — 必须经过 IPC handler |

### 管理端点（M6.4+）

首版不实现任何写端点。M6.4 Feedback Loop 可能新增：
- `POST guardrail:admin:rebuild` — 手动触发全量重建
- `POST guardrail:admin:build` — 手动触发增量构建

### 安全边界（现有模式遵循）

- `contextIsolation: true`, `nodeIntegration: false` — renderer 只能通过 IPC 通信
- IPC handler 在 main process 中执行，访问 DB
- 无 renderer → DB 直连路径

---

## Implementation Plan

### Files to Create

| File | Role |
|------|------|
| `src/main/core/evaluation/GuardrailMetricsQueryService.ts` | 查询服务 + projection state |
| `src/main/core/evaluation/__tests__/m6-3-metrics-query-service.test.ts` | 查询服务测试 |

### Files to Modify

| File | Change |
|------|--------|
| `src/main/ipc/handlers.ts` | 注册 `guardrail:metrics:*` 4 个 IPC handler |
| `src/preload/index.ts` | 新增 `electronAPI.getGuardrailMetricsSummary()` 等方法 |
| `src/renderer/src/widgets/plugins/index.ts` | 注册 guardrail metrics widget（首版可简化为一个卡片） |
| `src/main/bootstrap/AppRuntime.ts` | 注入 `GuardrailMetricsQueryService` |

### Renderer 组件（首版最小实现）

1. **GuardrailMetricsCard** — widget 插件，显示 summary 数字（checked/warning/terminated/signals）
   - Zone: `monitor`
   - 数据源: `electronAPI.getGuardrailMetricsSummary()`（pull）
   - 可选: 通过 `monitoring:metrics` 通道接入 guardrail 数据并实时刷新

> **Decision:** 首版不实现独立 Dashboard 页面。只实现一个 wallpaper widget 卡片。独立 Dashboard 页面 defer 到 M6.4（视需求优先级决定）。

### Service Wiring（在 AppRuntime）

```typescript
// AppRuntime.ts 中，GuardrailMetricsProjection 初始化后：
const metricsQueryService = new GuardrailMetricsQueryService(
  guardrailMetricsStore,
  guardrailMetricsProjection,
)

registerHandlers(
  agentService, stateManager, ttsService,
  ...,
  metricsQueryService,  // 新增参数
)
```

### Handler Registration（在 handlers.ts）

```typescript
// 与 decisionQueryRef 一致，使用可变的 ServiceRef
if (metricsQueryRef) {
  ipcMain.handle('guardrail:metrics:summary', async () => {
    const svc = metricsQueryRef.current
    if (!svc) return emptySummary()
    return svc.getSummary()
  })

  ipcMain.handle('guardrail:metrics:query', async (_event, since: number, until: number) => {
    const svc = metricsQueryRef.current
    if (!svc) return { windows: [], totalWindows: 0 }
    return svc.queryTimeRange(since, until)
  })

  ipcMain.handle('guardrail:metrics:latest', async () => {
    const svc = metricsQueryRef.current
    if (!svc) return null
    return svc.getLatest()
  })

  // ── 独立的状态 API，不耦合到数据 response ──
  ipcMain.handle('guardrail:metrics:state', async () => {
    const svc = metricsQueryRef.current
    if (!svc) return { status: 'UNAVAILABLE', reason: 'GuardrailMetricsQueryService not initialized' }
    return svc.getProjectionState()
  })
}
```

### GuardrailMetricsQueryService Design

```typescript
export class GuardrailMetricsQueryService {
  private projectionState: ProjectionState = { status: 'UNAVAILABLE', reason: 'not started' }

  constructor(
    private metricsStore: GuardrailMetricsStore,
    private projection: GuardrailMetricsProjection,
  ) {}

  /** Projection 完成时调用 */
  notifyBuildStarted(): void {
    this.projectionState = { status: 'REBUILDING', startedAt: Date.now(), windowsBuilt: 0 }
  }

  /** 窗口构建进度 */
  notifyWindowBuilt(): void {
    if (this.projectionState.status === 'REBUILDING') {
      this.projectionState = { ...this.projectionState, windowsBuilt: this.projectionState.windowsBuilt + 1 }
    }
  }

  /** 切换为 READY */
  notifyReady(): void {
    this.projectionState = { status: 'READY', lastBuiltAt: Date.now(), windowCount: 0 }
    // 异步更新 windowCount
    this.metricsStore.getSummary().then(s => {
      this.projectionState = { status: 'READY', lastBuiltAt: Date.now(), windowCount: s.windowCount }
    }).catch(() => {})
  }

  async getProjectionState(): Promise<ProjectionState> {
    // 如果标记为 READY，尝试刷新 windowCount
    if (this.projectionState.status === 'READY') {
      try {
        const summary = await this.metricsStore.getSummary()
        this.projectionState = { ...this.projectionState, windowCount: summary.windowCount }
      } catch {}
    }
    return this.projectionState
  }

  async getSummary(): Promise<MetricsSummary> {
    return this.metricsStore.getSummary()
  }

  async queryTimeRange(since: number, until: number): Promise<MetricsRow[]> {
    return this.metricsStore.query(since, until)
  }

  async getLatest(): Promise<MetricsRow | null> {
    return this.metricsStore.getLatest()
  }
}
```

---

## Freeze Checklist

- [ ] S1: API 只读 GuardrailMetricsStore，不扫描 EvaluationEvent，不依赖 DecisionStore
- [ ] S1: IPC handler 层作为强制边界，renderer 不直接访问 store
- [ ] S2: 首版 Query Contract 只包含 summary / time range / latest
- [ ] S2: policyVersion / action breakdown deferred 到 M6.4（如需，先扩展投影层）
- [ ] S2: 不开放通用 analytics 查询
- [ ] S3: ProjectionState 通过独立 API 查询，不污染数据 response 模型
- [ ] S3: 数据 API (summary/query/latest) 返回纯数据
- [ ] S3: 状态 API (metrics.state) 返回 ProjectionState
- [ ] S3: Consumer 必须处理非 READY 状态
- [ ] S4: 不暴露任何 ConfigStore/Policy/EvaluationEvent 修改端点
- [ ] S4: 首版无管理端点
- [ ] S4: IPC channel 固化：不暴露 metrics.rebuild / metrics.clear / metrics.upsert
- [ ] 集成: 复用 `monitoring:metrics` 推送通道（可选）
- [ ] 集成: 渲染层首版只实现 wallpaper widget 卡片，不实现独立 Dashboard 页面
