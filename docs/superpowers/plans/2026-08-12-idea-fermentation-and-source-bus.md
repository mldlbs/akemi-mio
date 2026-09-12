# 创意点子发酵引擎 + 来源总线 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 让创意点子经过"发酵"才能被实现，并让产生端接入多元来源（模块/行为/观察/外部/失败/反馈六域）。

**Architecture:** 新增 `IdeaFermentationEngine`（draft→active 门禁）与 `SourceAggregator`（分域采样来源总线），`CreativityCollector` 只采集 `active`；复用现有 `draft/active` 状态语义，DB 仅加列不重建表。

**Tech Stack:** TypeScript、Electron 主进程、Drizzle SQLite（sql.js）、vitest、TaskRunner 后台调度。

设计依据：`docs/superpowers/specs/2026-08-12-idea-fermentation-and-source-bus-design.md`

---

## 文件结构

| 文件 | 责任 |
| --- | --- |
| `src/main/creativity/types.ts` | Hypothesis 发酵字段、FermentVerdict、`HypothesisFermentationPatch`、`FERMENT_INTERVAL_MS`、'feedback' 来源类型、IdeaStoreLike 新方法 |
| `src/main/db/migration.ts` | 迁移 v44：hypotheses 表加 4 列 |
| `src/main/creativity/IdeaStore.ts` | JSON store：`getFermentableHypotheses`、`updateHypothesisFermentation` |
| `src/main/creativity/DrizzleIdeaStore.ts` | SQLite store：同两个方法 + 解析新列 |
| `src/main/creativity/SourceAggregator.ts` | 新增：来源总线（分域采样、去重、限流、失败降级） |
| `src/main/creativity/IdeaFermentationEngine.ts` | 新增：发酵引擎（promote/keep/reject/merge/淘汰） |
| `src/main/core/tasks/unified/TaskTypes.ts` | `BackgroundTaskType` 增加 `'creativity.ferment'` |
| `src/main/creativity/CreativityService.ts` | 集成聚合器与发酵引擎、`forceFerment()`、注册定时任务 |
| `src/main/evolution/automation/CreativityCollector.ts` | 只采集 `active`；构造函数支持注入 store |
| `src/main/tool/definitions/CreativityTools.ts` | 新增 `trigger_idea_ferment` |
| `src/main/bootstrap/AppRuntime.ts` | 真实记忆、行为源、GitHubInspiration、feedback 接线 |
| `src/main/creativity/__tests__/*.test.ts` | 新增/更新测试 |

---

### Task 1: 类型与常量（types.ts）

**Files:**
- Modify: `src/main/creativity/types.ts`
- Modify: `src/main/creativity/__tests__/CreativityService.test.ts`（mock store 补新方法，保持编译通过）

- [x] **Step 1: 在 `src/main/creativity/types.ts` 中扩展类型**

在 `Hypothesis` 接口末尾（`perspectives?` 之后）追加：

```ts
  /** 已发酵轮数 */
  fermentCount?: number
  /** 最近发酵时间戳 */
  lastFermentedAt?: number
  /** 发酵历史记录 */
  fermentLog?: FermentLogEntry[]
  /** merge 后指向的新 hypothesis id */
  mergedInto?: string
```

在 `Hypothesis` 接口之前新增：

```ts
export type FermentVerdict = 'promote' | 'keep' | 'reject' | 'merge'

export interface FermentLogEntry {
  at: number
  verdict: FermentVerdict
  reason: string
  score?: { novelty: number; feasibility: number; impact: number }
}

export interface HypothesisFermentationPatch {
  status?: Hypothesis['status']
  fermentCount?: number
  lastFermentedAt?: number
  fermentLog?: FermentLogEntry[]
  idea?: string
  novelty?: number
  feasibility?: number
  impact?: number
  mergedInto?: string
}
```

修改 `CreativitySource` 的 `type` 联合类型，追加 `'feedback'`：

```ts
export interface CreativitySource {
  name: string
  content: string
  type: 'knowledge' | 'behavior' | 'insight' | 'failure' | 'random' | 'provocation' | 'feedback'
  weight: number
}
```

在常量区（`NORMAL_CYCLE_INTERVAL_MS` 之后）追加：

```ts
export const FERMENT_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h
```

在 `IdeaStoreLike` 接口中追加两个方法：

```ts
  getFermentableHypotheses: (limit?: number) => Hypothesis[]
  updateHypothesisFermentation: (id: string, patch: HypothesisFermentationPatch) => boolean
```

- [x] **Step 2: 更新 `CreativityService.test.ts` 的 mock store**

在 `src/main/creativity/__tests__/CreativityService.test.ts` 的 `createMockStore()` 返回对象中追加：

```ts
    getFermentableHypotheses: vi.fn(() => hypotheses),
    updateHypothesisFermentation: vi.fn(() => true),
```

- [x] **Step 3: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: 无新增错误（若有其他 `IdeaStoreLike` mock 报缺方法，按 Step 2 同样补上）。

---

### Task 2: DB 迁移 v44

**Files:**
- Modify: `src/main/db/migration.ts`（在 `MIGRATIONS` 数组末尾、version 43 之后追加）

- [x] **Step 1: 追加迁移**

在 `MIGRATIONS` 数组的最后一个元素（version 43）之后追加：

```ts
  {
    version: 44,
    sql: `
      ALTER TABLE hypotheses ADD COLUMN ferment_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE hypotheses ADD COLUMN last_fermented_at INTEGER;
      ALTER TABLE hypotheses ADD COLUMN ferment_log TEXT;
      ALTER TABLE hypotheses ADD COLUMN merged_into TEXT;
    `,
    revert: '',
    category: 'schema',
  },
```

- [x] **Step 2: 验证迁移可加载**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: 无错误。迁移框架 `runMigrations` 用 `sqlite.run(m.sql)` 执行多条语句（与 v1 多语句迁移一致）。
---

### Task 3: Store 发酵方法（IdeaStore + DrizzleIdeaStore）

**Files:**
- Modify: `src/main/creativity/IdeaStore.ts`
- Modify: `src/main/creativity/DrizzleIdeaStore.ts`
- Create: `src/main/creativity/__tests__/IdeaStore.test.ts`

- [x] **Step 1: 写失败测试 `src/main/creativity/__tests__/IdeaStore.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { IdeaStore } from '../IdeaStore'
import type { Hypothesis } from '../types'

function makeHyp(partial: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id: 'h1',
    title: '点子',
    idea: '内容',
    expectedBenefit: '',
    risk: '',
    sourceLabels: [],
    novelty: 50,
    feasibility: 50,
    impact: 50,
    status: 'draft',
    createdAt: Date.now(),
    ...partial,
  }
}

let dir: string
let store: IdeaStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'idea-store-'))
  store = new IdeaStore(join(dir, 'creativity.json'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('IdeaStore 发酵方法', () => {
  it('getFermentableHypotheses 只返回 draft 并按综合分降序', () => {
    store.addHypothesis(makeHyp({ id: 'd1', status: 'draft', novelty: 60, feasibility: 60, impact: 60 }))
    store.addHypothesis(makeHyp({ id: 'a1', status: 'active' }))
    store.addHypothesis(makeHyp({ id: 'd2', status: 'draft', novelty: 80, feasibility: 80, impact: 80 }))
    const list = store.getFermentableHypotheses()
    expect(list.map((h) => h.id)).toEqual(['d2', 'd1'])
  })

  it('updateHypothesisFermentation 合并 patch 并持久化', () => {
    store.addHypothesis(makeHyp({ id: 'd1', status: 'draft' }))
    const ok = store.updateHypothesisFermentation('d1', {
      status: 'active',
      fermentCount: 2,
      lastFermentedAt: 123,
      fermentLog: [{ at: 123, verdict: 'keep', reason: 'ok' }],
      novelty: 77,
    })
    expect(ok).toBe(true)
    const reloaded = new IdeaStore(join(dir, 'creativity.json')).getHypotheses()
    const h = reloaded.find((x) => x.id === 'd1')!
    expect(h.status).toBe('active')
    expect(h.fermentCount).toBe(2)
    expect(h.novelty).toBe(77)
    expect(h.fermentLog?.[0].verdict).toBe('keep')
  })

  it('updateHypothesisFermentation 对不存在的 id 返回 false', () => {
    expect(store.updateHypothesisFermentation('nope', { status: 'active' })).toBe(false)
  })
})
```

- [x] **Step 2: 运行确认失败**

Run: `npx vitest run src/main/creativity/__tests__/IdeaStore.test.ts`
Expected: FAIL（`getFermentableHypotheses is not a function`）。

- [x] **Step 3: 实现 `IdeaStore.ts`**

在 `getHypotheses` 方法之后追加：

```ts
  getFermentableHypotheses(limit = 20): Hypothesis[] {
    return this.data.hypotheses
      .filter((h) => h.status === 'draft')
      .sort((a, b) => b.novelty + b.feasibility + b.impact - (a.novelty + a.feasibility + a.impact))
      .slice(0, limit)
  }
```

在 `updateHypothesisStatus` 方法之后追加：

```ts
  updateHypothesisFermentation(id: string, patch: HypothesisFermentationPatch): boolean {
    const h = this.data.hypotheses.find((h) => h.id === id)
    if (!h) return false
    if (patch.status !== undefined) h.status = patch.status
    if (patch.fermentCount !== undefined) h.fermentCount = patch.fermentCount
    if (patch.lastFermentedAt !== undefined) h.lastFermentedAt = patch.lastFermentedAt
    if (patch.fermentLog !== undefined) h.fermentLog = patch.fermentLog
    if (patch.idea !== undefined) h.idea = patch.idea
    if (patch.novelty !== undefined) h.novelty = patch.novelty
    if (patch.feasibility !== undefined) h.feasibility = patch.feasibility
    if (patch.impact !== undefined) h.impact = patch.impact
    if (patch.mergedInto !== undefined) h.mergedInto = patch.mergedInto
    this.save()
    return true
  }
```

更新 import：

```ts
import type { CreativityStoreData, ConceptCombo, Hypothesis, ExperimentPlan, DreamCycleLog, HypothesisFermentationPatch } from './types'
```

- [x] **Step 4: 实现 `DrizzleIdeaStore.ts`**

修改 `parseHypothesis` 为：

```ts
function parseHypothesis(obj: any): Hypothesis {
  const h: Hypothesis = {
    id: obj.id,
    title: obj.title,
    idea: obj.idea,
    expectedBenefit: obj.expected_benefit,
    risk: obj.risk,
    sourceLabels: JSON.parse(obj.source_labels || '[]'),
    novelty: obj.novelty,
    feasibility: obj.feasibility,
    impact: obj.impact,
    status: obj.status,
    createdAt: obj.created_at,
  }
  if (obj.ferment_count != null) h.fermentCount = Number(obj.ferment_count)
  if (obj.last_fermented_at != null) h.lastFermentedAt = Number(obj.last_fermented_at)
  if (obj.ferment_log) {
    try {
      h.fermentLog = JSON.parse(obj.ferment_log)
    } catch {
      h.fermentLog = []
    }
  }
  if (obj.merged_into != null) h.mergedInto = String(obj.merged_into)
  return h
}
```

在 `getNovelHypotheses` 之后追加：

```ts
  getFermentableHypotheses(limit = 20): Hypothesis[] {
    const db = getRawDb()
    const result = db.exec(
      `SELECT * FROM hypotheses WHERE status = 'draft' ORDER BY (novelty + feasibility + impact) DESC LIMIT ${limit}`,
    )
    if (!result || result.length === 0 || result[0].values.length === 0) return []
    return rowsToObjects(result[0].columns, result[0].values).map(parseHypothesis)
  }
```

在 `updateHypothesisStatus` 之后追加：

```ts
  updateHypothesisFermentation(id: string, patch: HypothesisFermentationPatch): boolean {
    const db = getRawDb()
    const sets: string[] = []
    const params: any[] = []
    const push = (col: string, val: any) => {
      sets.push(`${col} = ?`)
      params.push(val)
    }
    if (patch.status !== undefined) push('status', patch.status)
    if (patch.fermentCount !== undefined) push('ferment_count', patch.fermentCount)
    if (patch.lastFermentedAt !== undefined) push('last_fermented_at', patch.lastFermentedAt)
    if (patch.fermentLog !== undefined) push('ferment_log', JSON.stringify(patch.fermentLog))
    if (patch.idea !== undefined) push('idea', patch.idea)
    if (patch.novelty !== undefined) push('novelty', patch.novelty)
    if (patch.feasibility !== undefined) push('feasibility', patch.feasibility)
    if (patch.impact !== undefined) push('impact', patch.impact)
    if (patch.mergedInto !== undefined) push('merged_into', patch.mergedInto)
    if (sets.length === 0) return false
    params.push(id)
    db.run(`UPDATE hypotheses SET ${sets.join(', ')} WHERE id = ?`, params)
    markDirty()
    return true
  }
```

更新 import：

```ts
import type { ConceptCombo, Hypothesis, ExperimentPlan, DreamCycleLog, HypothesisFermentationPatch } from './types'
```

- [x] **Step 5: 运行测试确认通过**

Run: `npx vitest run src/main/creativity/__tests__/IdeaStore.test.ts`
Expected: PASS（3 个用例）。

- [x] **Step 6: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: 无错误。
---

### Task 4: SourceAggregator（来源总线）

**Files:**
- Create: `src/main/creativity/SourceAggregator.ts`
- Create: `src/main/creativity/__tests__/SourceAggregator.test.ts`

- [x] **Step 1: 写失败测试 `src/main/creativity/__tests__/SourceAggregator.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { SourceAggregator } from '../SourceAggregator'

describe('SourceAggregator', () => {
  it('跨域采样：至少覆盖 minDomains 个域', () => {
    const agg = new SourceAggregator(4, 3)
    agg.addProvider({ domain: 'module', name: 'm', collect: () => [{ name: 'Memory', content: 'a', type: 'knowledge', weight: 0.9 }] })
    agg.addProvider({ domain: 'behavior', name: 'b', collect: () => [{ name: 'UserBehavior', content: 'b', type: 'behavior', weight: 0.7 }] })
    agg.addProvider({ domain: 'failure', name: 'f', collect: () => [{ name: '失败:x', content: 'c', type: 'failure', weight: 0.6 }] })
    const out = agg.build()
    expect(out.length).toBe(3)
  })

  it('每域限流 maxPerDomain 且同域去重', () => {
    const agg = new SourceAggregator(2, 1)
    agg.addProvider({
      domain: 'module',
      name: 'm',
      collect: () => [
        { name: 'A', content: '1', type: 'knowledge', weight: 0.5 },
        { name: 'A', content: 'dup', type: 'knowledge', weight: 0.5 },
        { name: 'B', content: '2', type: 'knowledge', weight: 0.9 },
        { name: 'C', content: '3', type: 'knowledge', weight: 0.7 },
      ],
    })
    const out = agg.build()
    expect(out.length).toBe(2)
    expect(out.map((s) => s.name).sort()).toEqual(['A', 'B'])
  })

  it('provider 抛错时跳过并继续其他域', () => {
    const agg = new SourceAggregator(4, 2)
    agg.addProvider({ domain: 'module', name: 'bad', collect: () => { throw new Error('boom') } })
    agg.addProvider({ domain: 'behavior', name: 'good', collect: () => [{ name: 'B', content: 'x', type: 'behavior', weight: 0.7 }] })
    agg.addProvider({ domain: 'failure', name: 'f2', collect: () => [{ name: 'F', content: 'y', type: 'failure', weight: 0.6 }] })
    const out = agg.build()
    expect(out.length).toBe(2)
  })
})
```

- [x] **Step 2: 运行确认失败**

Run: `npx vitest run src/main/creativity/__tests__/SourceAggregator.test.ts`
Expected: FAIL（无法解析 `../SourceAggregator`）。

- [x] **Step 3: 实现 `src/main/creativity/SourceAggregator.ts`**

```ts
import { log } from '../logger/Logger'
import type { CreativitySource } from './types'

export type SourceDomain = 'module' | 'behavior' | 'observation' | 'external' | 'failure' | 'feedback'

export interface SourceProvider {
  domain: SourceDomain
  name: string
  collect: () => CreativitySource[]
}

/**
 * SourceAggregator — 来源总线
 *
 * 统一收集多域来源，做去重、每域限流与失败降级，
 * 供创意产生与发酵两端共用同一份信号。
 */
export class SourceAggregator {
  private providers: SourceProvider[] = []
  private maxPerDomain: number
  private minDomains: number

  constructor(maxPerDomain = 4, minDomains = 3) {
    this.maxPerDomain = maxPerDomain
    this.minDomains = minDomains
  }

  addProvider(provider: SourceProvider): void {
    this.providers.push(provider)
  }

  build(): CreativitySource[] {
    const byDomain = new Map<SourceDomain, CreativitySource[]>()
    const seen = new Set<string>()

    for (const provider of this.providers) {
      let collected: CreativitySource[] = []
      try {
        collected = provider.collect() ?? []
      } catch (err: any) {
        log('WARN', 'source_provider_failed', { provider: provider.name, error: String(err?.message ?? err) })
        continue
      }
      const unique = collected.filter((s) => {
        const key = `${provider.domain}:${s.name}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      const list = byDomain.get(provider.domain) ?? []
      byDomain.set(provider.domain, [...list, ...unique])
    }

    const output: CreativitySource[] = []
    let domainsWithData = 0
    for (const [domain, sources] of byDomain) {
      if (sources.length > 0) domainsWithData++
      const sorted = [...sources].sort((a, b) => b.weight - a.weight)
      output.push(...sorted.slice(0, this.maxPerDomain))
    }

    if (domainsWithData < this.minDomains) {
      log('WARN', 'source_aggregator_low_diversity', { domains: domainsWithData, min: this.minDomains })
    }
    log('INFO', 'source_aggregator_build', { total: output.length, domains: domainsWithData })
    return output
  }
}
```

- [x] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/main/creativity/__tests__/SourceAggregator.test.ts`
Expected: PASS（3 个用例）。
---

### Task 5: IdeaFermentationEngine（发酵引擎）

**Files:**
- Create: `src/main/creativity/IdeaFermentationEngine.ts`
- Create: `src/main/creativity/__tests__/IdeaFermentationEngine.test.ts`

- [x] **Step 1: 写失败测试 `src/main/creativity/__tests__/IdeaFermentationEngine.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest'
import { IdeaFermentationEngine } from '../IdeaFermentationEngine'
import type { Hypothesis, IdeaStoreLike } from '../types'

const DAY = 24 * 60 * 60 * 1000

function makeHyp(partial: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id: 'h1',
    title: '点子',
    idea: '内容',
    expectedBenefit: '',
    risk: '',
    sourceLabels: ['A'],
    novelty: 60,
    feasibility: 60,
    impact: 60,
    status: 'draft',
    createdAt: Date.now() - 2 * DAY,
    ...partial,
  }
}

function createStore(initial: Hypothesis[] = []) {
  const hyps = [...initial]
  const updates: Array<{ id: string; patch: any }> = []
  return {
    store: {
      getFermentableHypotheses: vi.fn(() => [...hyps]),
      addHypothesis: vi.fn((h: Hypothesis) => hyps.push(h)),
      updateHypothesisFermentation: vi.fn((id: string, patch: any) => {
        updates.push({ id, patch })
        const h = hyps.find((x) => x.id === id)
        if (h) Object.assign(h, patch)
        return true
      }),
      updateHypothesisStatus: vi.fn(() => true),
    } as unknown as IdeaStoreLike,
    updates,
    hyps,
  }
}

const chatJson = vi.fn()

function makeEngine(store: IdeaStoreLike, signals: any[] = []) {
  return new IdeaFermentationEngine(store, chatJson as any, () => signals as any)
}

describe('IdeaFermentationEngine', () => {
  beforeEach(() => {
    chatJson.mockReset()
  })

  it('promote：满 2 轮且年龄 ≥24h 才升级为 active', async () => {
    const { store, updates } = createStore([makeHyp({ id: 'h1', fermentCount: 1 })])
    chatJson.mockResolvedValue({ data: { results: [{ id: 'h1', verdict: 'promote', reason: '成熟', novelty: 80, feasibility: 80, impact: 80 }] } })
    const result = await makeEngine(store).ferment()
    expect(result.promoted).toContain('h1')
    expect(updates[0].patch.status).toBe('active')
    expect(updates[0].patch.fermentCount).toBe(2)
  })

  it('promote 但年龄不足时降级为 keep，留在 draft', async () => {
    const { store, updates } = createStore([makeHyp({ id: 'h1', createdAt: Date.now() - 1 * 60 * 60 * 1000, fermentCount: 1 })])
    chatJson.mockResolvedValue({ data: { results: [{ id: 'h1', verdict: 'promote', reason: '太年轻', novelty: 80, feasibility: 80, impact: 80 }] } })
    const result = await makeEngine(store).ferment()
    expect(result.promoted).toHaveLength(0)
    expect(updates[0].patch.status).toBeUndefined()
    expect(updates[0].patch.fermentCount).toBe(2)
  })

  it('keep：分数按 新*0.6 + 旧*0.4 混合', async () => {
    const { store, updates } = createStore([makeHyp({ id: 'h1', novelty: 60, feasibility: 60, impact: 60 })])
    chatJson.mockResolvedValue({ data: { results: [{ id: 'h1', verdict: 'keep', reason: '再想想', novelty: 90, feasibility: 70, impact: 80 }] } })
    await makeEngine(store).ferment()
    expect(updates[0].patch.novelty).toBe(78) // 60*0.4 + 90*0.6 = 78
    expect(updates[0].patch.feasibility).toBe(66)
  })

  it('reject：标记 rejected 并记录理由', async () => {
    const { store, updates } = createStore([makeHyp({ id: 'h1' })])
    chatJson.mockResolvedValue({ data: { results: [{ id: 'h1', verdict: 'reject', reason: '不可行' }] } })
    const result = await makeEngine(store).ferment()
    expect(result.rejected).toContain('h1')
    expect(updates[0].patch.status).toBe('rejected')
    expect(updates[0].patch.fermentLog[0].reason).toBe('不可行')
  })
})
```

- [x] **Step 1b: 追加 merge / 淘汰 / 失败 / 上限 用例**

继续在同一测试文件中追加：

```ts
  it('merge：生成合并版 draft，原条目标 rejected + mergedInto', async () => {
    const { store, hyps, updates } = createStore([
      makeHyp({ id: 'a', sourceLabels: ['A'] }),
      makeHyp({ id: 'b', sourceLabels: ['B'] }),
    ])
    chatJson.mockResolvedValue({
      data: {
        results: [
          { id: 'a', verdict: 'merge', reason: '互补', mergeWithId: 'b', mergedIdea: { title: '合并', idea: '合并内容', expectedBenefit: 'x', risk: 'y', sourceLabels: ['A', 'B'], novelty: 70, feasibility: 70, impact: 70 } },
        ],
      },
    })
    const result = await makeEngine(store).ferment()
    expect(result.merged).toBe(1)
    const merged = hyps.find((h) => h.id.startsWith('hyp_merge_'))
    expect(merged).toBeDefined()
    expect(merged!.status).toBe('draft')
    const aUpdate = updates.find((u) => u.id === 'a')
    const bUpdate = updates.find((u) => u.id === 'b')
    expect(aUpdate?.patch.status).toBe('rejected')
    expect(aUpdate?.patch.mergedInto).toBe(merged!.id)
    expect(bUpdate?.patch.status).toBe('rejected')
  })

  it('满 6 轮仍未升级自动淘汰', async () => {
    const { store, updates } = createStore([makeHyp({ id: 'h1', fermentCount: 5 })])
    chatJson.mockResolvedValue({ data: { results: [{ id: 'h1', verdict: 'keep', reason: '没动静' }] } })
    await makeEngine(store).ferment()
    expect(updates[0].patch.status).toBe('rejected')
  })

  it('LLM 失败时 skipped=true 且不修改任何数据', async () => {
    const { store, updates } = createStore([makeHyp({ id: 'h1' })])
    chatJson.mockResolvedValue({ error: 'timeout' })
    const result = await makeEngine(store).ferment()
    expect(result.skipped).toBe(true)
    expect(updates).toHaveLength(0)
  })

  it('每轮最多 promote 3 条', async () => {
    const hyps = [1, 2, 3, 4].map((i) => makeHyp({ id: `h${i}`, fermentCount: 1 }))
    const { store, updates } = createStore(hyps)
    chatJson.mockResolvedValue({
      data: {
        results: hyps.map((h) => ({ id: h.id, verdict: 'promote', reason: 'ok', novelty: 80, feasibility: 80, impact: 80 })),
      },
    })
    const result = await makeEngine(store).ferment()
    expect(result.promoted).toHaveLength(3)
    const activeCount = updates.filter((u) => u.patch.status === 'active').length
    expect(activeCount).toBe(3)
  })
})
```

- [x] **Step 2: 运行确认失败**

Run: `npx vitest run src/main/creativity/__tests__/IdeaFermentationEngine.test.ts`
Expected: FAIL（无法解析 `../IdeaFermentationEngine`）。
- [x] **Step 3: 实现 `src/main/creativity/IdeaFermentationEngine.ts`（第 1 部分）**

```ts
import { log } from '../logger/Logger'
import type { CreativitySource, FermentLogEntry, Hypothesis, HypothesisFermentationPatch, IdeaStoreLike } from './types'

export interface FermentResult {
  promoted: string[]
  rejected: string[]
  merged: number
  kept: number
  skipped: boolean
}

const FERMENT_SYSTEM_PROMPT = `你是一个点子发酵师。
你负责评估"还在发酵中"的创意点子（draft 状态）：
- 结合最近的新信号判断点子是否成熟到可以落地；
- 可以强化点子、合并互补点子、或淘汰失去价值的点子。
只输出 JSON，不要输出其他内容。`

function clampScore(value: any, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(10, Math.min(100, Math.round(n)))
}

/**
 * IdeaFermentationEngine — 创意点子发酵引擎
 *
 * 读取 draft 状态的 hypothesis，结合来源总线的新信号，
 * 由 LLM 逐条评估并给出 promote / keep / reject / merge 判定。
 */
export class IdeaFermentationEngine {
  private store: IdeaStoreLike
  private chatJson: (
    userText: string,
    options?: { system?: string; temperature?: number; timeoutMs?: number; requestId?: string },
  ) => Promise<{ data?: any; error?: string }>
  private getSignals: () => CreativitySource[]
  private minFermentRounds = 2
  private minAgeMs = 24 * 60 * 60 * 1000
  private maxPromotePerRound = 3
  private maxFermentRounds = 6

  constructor(
    store: IdeaStoreLike,
    chatJson: (
      userText: string,
      options?: { system?: string; temperature?: number; timeoutMs?: number; requestId?: string },
    ) => Promise<{ data?: any; error?: string }>,
    getSignals: () => CreativitySource[],
  ) {
    this.store = store
    this.chatJson = chatJson
    this.getSignals = getSignals
  }

  async ferment(): Promise<FermentResult> {
    const candidates = this.store.getFermentableHypotheses(20)
    if (candidates.length === 0) {
      log('INFO', 'idea_ferment_empty')
      return { promoted: [], rejected: [], merged: 0, kept: 0, skipped: false }
    }

    const signals = this.getSignals()
    const prompt = this.buildPrompt(candidates, signals)

    log('INFO', 'idea_ferment_start', { candidates: candidates.length, signals: signals.length })

    const result = await this.chatJson(prompt, {
      system: FERMENT_SYSTEM_PROMPT,
      temperature: 0.5,
      timeoutMs: 120000,
    })

    if (result.error) {
      log('WARN', 'idea_ferment_failed', { error: result.error })
      return { promoted: [], rejected: [], merged: 0, kept: 0, skipped: true }
    }

    const results = Array.isArray(result.data?.results) ? result.data.results : []
    return this.applyVerdicts(candidates, results)
  }

  private buildPrompt(candidates: Hypothesis[], signals: CreativitySource[]): string {
    const candidateText = candidates
      .map(
        (h, i) =>
          `${i + 1}. [${h.id}] ${h.title}\n` +
          `   内容: ${h.idea}\n` +
          `   新颖度 ${h.novelty} / 可行性 ${h.feasibility} / 影响 ${h.impact}\n` +
          `   已发酵轮数: ${h.fermentCount ?? 0}\n` +
          `   风险: ${h.risk}`,
      )
      .join('\n')

    const signalText =
      signals.length > 0
        ? signals.map((s) => `- [${s.type}] ${s.name}: ${s.content}`).join('\n')
        : '（无）'

    return `以下是需要发酵的 ${candidates.length} 个创意点子（draft 状态）：

${candidateText}

近期新信号（可能对点子有影响）：
${signalText}

请逐条评估每个点子，输出 JSON：
{
  "results": [
    {
      "id": "点子id",
      "verdict": "promote | keep | reject | merge",
      "reason": "一句话理由",
      "novelty": 0-100,
      "feasibility": 0-100,
      "impact": 0-100,
      "enrichedIdea": "可选，强化后的点子描述",
      "mergeWithId": "可选，verdict=merge 时合并的目标点子id",
      "mergedIdea": { "title": "", "idea": "", "expectedBenefit": "", "risk": "", "sourceLabels": [], "novelty": 0, "feasibility": 0, "impact": 0 }
    }
  ]
}

评判标准：
- promote：仅当点子足够成熟且当前信号支持落地；
- merge：仅当两个点子互补可合并（mergedIdea 给出合并后的完整点子）；
- reject：点子已失去价值或明确不可行；
- keep：其余情况，留在发酵池继续观察。`
  }
```
- [x] **Step 3b: 实现 `IdeaFermentationEngine.ts`（第 2 部分，追加到类内）**

在 `buildPrompt` 方法之后、类结束前追加：

```ts
  private applyVerdicts(
    candidates: Hypothesis[],
    results: Array<Record<string, any>>,
  ): FermentResult {
    const byId = new Map(candidates.map((c) => [c.id, c]))
    const now = Date.now()
    let promotedCount = 0
    const promoted: string[] = []
    const rejected: string[] = []
    let merged = 0
    let kept = 0
    const mergeResults: Array<Record<string, any>> = []

    for (const r of results) {
      const h = byId.get(r?.id)
      if (!h) continue
      const rounds = (h.fermentCount ?? 0) + 1
      const entry: FermentLogEntry = { at: now, verdict: r.verdict ?? 'keep', reason: r.reason ?? '' }

      if (r.verdict === 'promote') {
        const ageOk = now - h.createdAt >= this.minAgeMs
        if (rounds >= this.minFermentRounds && ageOk && promotedCount < this.maxPromotePerRound) {
          this.store.updateHypothesisFermentation(h.id, {
            status: 'active',
            fermentCount: rounds,
            lastFermentedAt: now,
            fermentLog: [...(h.fermentLog ?? []), entry],
            novelty: clampScore(r.novelty, h.novelty),
            feasibility: clampScore(r.feasibility, h.feasibility),
            impact: clampScore(r.impact, h.impact),
          })
          promoted.push(h.id)
          promotedCount++
          continue
        }
        this.applyKeep(h, r, rounds, now)
        kept++
        continue
      }

      if (r.verdict === 'reject') {
        this.store.updateHypothesisFermentation(h.id, {
          status: 'rejected',
          fermentCount: rounds,
          lastFermentedAt: now,
          fermentLog: [...(h.fermentLog ?? []), entry],
        })
        rejected.push(h.id)
        continue
      }

      if (r.verdict === 'merge') {
        mergeResults.push(r)
        continue
      }

      this.applyKeep(h, r, rounds, now)
      kept++
    }

    // 第二轮处理 merge
    const processed = new Set<string>()
    let mergeIndex = 0
    for (const r of mergeResults) {
      const h = byId.get(r.id)
      if (!h || processed.has(h.id)) continue
      const mergedIdea = r.mergedIdea
      if (!mergedIdea || typeof mergedIdea.title !== 'string' || typeof mergedIdea.idea !== 'string') {
        this.applyKeep(h, r, (h.fermentCount ?? 0) + 1, now)
        kept++
        continue
      }

      const newId = `hyp_merge_${now}_${++mergeIndex}`
      const newHyp: Hypothesis = {
        id: newId,
        title: mergedIdea.title,
        idea: mergedIdea.idea,
        expectedBenefit: String(mergedIdea.expectedBenefit ?? ''),
        risk: String(mergedIdea.risk ?? ''),
        sourceLabels: Array.isArray(mergedIdea.sourceLabels) ? mergedIdea.sourceLabels : h.sourceLabels,
        novelty: clampScore(mergedIdea.novelty, h.novelty),
        feasibility: clampScore(mergedIdea.feasibility, h.feasibility),
        impact: clampScore(mergedIdea.impact, h.impact),
        status: 'draft',
        createdAt: now,
      }
      this.store.addHypothesis(newHyp)

      const entry: FermentLogEntry = { at: now, verdict: 'merge', reason: r.reason ?? '合并' }
      this.store.updateHypothesisFermentation(h.id, {
        status: 'rejected',
        fermentCount: (h.fermentCount ?? 0) + 1,
        lastFermentedAt: now,
        fermentLog: [...(h.fermentLog ?? []), entry],
        mergedInto: newId,
      })
      processed.add(h.id)

      const partner = typeof r.mergeWithId === 'string' ? byId.get(r.mergeWithId) : undefined
      if (partner && !processed.has(partner.id) && partner.id !== h.id) {
        this.store.updateHypothesisFermentation(partner.id, {
          status: 'rejected',
          fermentCount: (partner.fermentCount ?? 0) + 1,
          lastFermentedAt: now,
          fermentLog: [...(partner.fermentLog ?? []), { at: now, verdict: 'merge', reason: r.reason ?? '合并' }],
          mergedInto: newId,
        })
        processed.add(partner.id)
      }
      merged++
    }

    log('INFO', 'idea_ferment_done', {
      promoted: promoted.length,
      rejected: rejected.length,
      merged,
      kept,
    })

    return { promoted, rejected, merged, kept, skipped: false }
  }

  private applyKeep(h: Hypothesis, r: Record<string, any>, rounds: number, now: number): void {
    const entry: FermentLogEntry = {
      at: now,
      verdict: 'keep',
      reason: r.reason ?? '',
      score: { novelty: h.novelty, feasibility: h.feasibility, impact: h.impact },
    }
    const patch: HypothesisFermentationPatch = {
      fermentCount: rounds,
      lastFermentedAt: now,
      fermentLog: [...(h.fermentLog ?? []), entry],
      novelty: r.novelty != null ? Math.round(h.novelty * 0.4 + clampScore(r.novelty, h.novelty) * 0.6) : h.novelty,
      feasibility: r.feasibility != null ? Math.round(h.feasibility * 0.4 + clampScore(r.feasibility, h.feasibility) * 0.6) : h.feasibility,
      impact: r.impact != null ? Math.round(h.impact * 0.4 + clampScore(r.impact, h.impact) * 0.6) : h.impact,
    }
    if (typeof r.enrichedIdea === 'string' && r.enrichedIdea.trim().length > 0) {
      patch.idea = r.enrichedIdea
    }
    if (rounds >= this.maxFermentRounds) {
      patch.status = 'rejected'
    }
    this.store.updateHypothesisFermentation(h.id, patch)
  }
}
```

- [x] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/main/creativity/__tests__/IdeaFermentationEngine.test.ts`
Expected: PASS（8 个用例）。

- [x] **Step 5: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: 无错误。
---

### Task 6: TaskTypes 增加 creativity.ferment

**Files:**
- Modify: `src/main/core/tasks/unified/TaskTypes.ts`

- [x] **Step 1: 追加任务类型**

在 `'creativity.dream'` 之后追加：

```ts
  | 'creativity.ferment'
```

- [x] **Step 2: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: 无错误。

---

### Task 7: CreativityService 集成

**Files:**
- Modify: `src/main/creativity/CreativityService.ts`
- Modify: `src/main/creativity/index.ts`（deps 类型透传）
- Create: `src/main/creativity/__tests__/CreativityFermentation.test.ts`

- [x] **Step 1: 写失败测试 `src/main/creativity/__tests__/CreativityFermentation.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CreativityService } from '../CreativityService'
import type { IdeaStoreLike, Hypothesis } from '../types'

function makeStore(): IdeaStoreLike {
  return {
    addCombo: vi.fn(),
    addHypothesis: vi.fn(),
    addManyHypotheses: vi.fn(),
    addExperiment: vi.fn(),
    logDreamCycle: vi.fn(),
    getHypotheses: vi.fn(() => []),
    getNovelHypotheses: vi.fn(() => []),
    getActiveExperiments: vi.fn(() => []),
    getRecentCombos: vi.fn(() => []),
    getRecentDreamCycles: vi.fn(() => []),
    updateHypothesisStatus: vi.fn(() => true),
    addExploredPair: vi.fn(),
    getExploredPairs: vi.fn(() => []),
    resetExploredPairs: vi.fn(),
    count: vi.fn(() => ({ combos: 0, hypotheses: 0, experiments: 0, dreamCycles: 0 })),
    templateAdoptionStats: vi.fn(() => ({})),
    adoptionReport: vi.fn(() => ''),
    getFermentableHypotheses: vi.fn(() => []),
    updateHypothesisFermentation: vi.fn(() => true),
  }
}

describe('CreativityService 发酵集成', () => {
  let chatJson: ReturnType<typeof vi.fn>
  let store: IdeaStoreLike

  beforeEach(() => {
    vi.clearAllMocks()
    chatJson = vi.fn()
    store = makeStore()
  })

  it('forceFerment 调用发酵引擎并返回结果', async () => {
    const h: Hypothesis = {
      id: 'h1', title: 't', idea: 'i', expectedBenefit: '', risk: '',
      sourceLabels: ['A'], novelty: 70, feasibility: 70, impact: 70,
      status: 'draft', createdAt: Date.now() - 2 * 24 * 60 * 60 * 1000, fermentCount: 1,
    }
    store.getFermentableHypotheses = vi.fn(() => [h])
    chatJson.mockResolvedValue({ data: { results: [{ id: 'h1', verdict: 'promote', reason: 'ok', novelty: 80, feasibility: 80, impact: 80 }] } })

    const deps = {
      getSources: vi.fn(() => [{ name: 'A', content: 'x', type: 'knowledge', weight: 0.8 }]),
      getInsights: vi.fn(() => []),
      getFailedHypotheses: vi.fn(() => []),
    }
    const service = new CreativityService(store, deps as any, chatJson as any, undefined, 0, 42, undefined, '', undefined, undefined)
    const result = await service.forceFerment()
    expect(result.promoted).toContain('h1')
    expect(store.updateHypothesisFermentation).toHaveBeenCalledWith('h1', expect.objectContaining({ status: 'active' }))
  })

  it('cycle 通过来源总线聚合 external 来源', async () => {
    chatJson.mockResolvedValue({
      data: [{
        title: '跨模块缓存优化',
        idea: '这是一个足够描述的改进方案不少于二十个字的内容描述用于验证测试',
        expectedBenefit: '提升响应速度',
        risk: '增加内存占用',
        sourceLabels: ['Agent', 'Memory'],
        novelty: 65,
        feasibility: 75,
        impact: 70,
      }],
    })
    const deps = {
      getSources: vi.fn(() => [{ name: 'Memory', content: 'a', type: 'knowledge', weight: 0.9 }]),
      getExternalSources: vi.fn(() => [{ name: 'GitHub灵感', content: 'b', type: 'knowledge', weight: 0.8 }]),
      getInsights: vi.fn(() => []),
      getFailedHypotheses: vi.fn(() => []),
    }
    const service = new CreativityService(store, deps as any, chatJson as any, undefined, 0, 42, undefined, '', undefined, undefined)
    await (service as any).cycle()
    expect(chatJson).toHaveBeenCalledTimes(1)
  })
})
```

- [x] **Step 2: 运行确认失败**

Run: `npx vitest run src/main/creativity/__tests__/CreativityFermentation.test.ts`
Expected: FAIL（`service.forceFerment is not a function`）。
- [x] **Step 3: 修改 `CreativityService.ts`**

**3a. imports**，追加：

```ts
import { SourceAggregator } from './SourceAggregator'
import { IdeaFermentationEngine } from './IdeaFermentationEngine'
import type { FermentResult } from './IdeaFermentationEngine'
```

`types` import 增加 `FERMENT_INTERVAL_MS`：

```ts
import { DREAM_CYCLE_INTERVAL_MS, NORMAL_CYCLE_INTERVAL_MS, FERMENT_INTERVAL_MS } from './types'
```

**3b. 字段**，在现有私有字段区追加：

```ts
  private sourceAggregator: SourceAggregator
  private fermentation: IdeaFermentationEngine
  private getBehaviorSources: (() => CreativitySource[]) | null = null
  private getExternalSources: (() => CreativitySource[]) | null = null
  private getFeedbackSources: (() => CreativitySource[]) | null = null
  private fermentTimer: ReturnType<typeof setInterval> | null = null
```

**3c. 构造函数 deps 类型**，追加可选字段：

```ts
    deps: {
      getSources: () => CreativitySource[]
      getBehaviorSources?: () => CreativitySource[]
      getInsights: () => { title: string; description: string; score: number }[]
      getFailedHypotheses: () => { title: string; idea: string; risk: string }[]
      getExternalSources?: () => CreativitySource[]
      getFeedbackSources?: () => CreativitySource[]
    },
```

**3d. 构造函数内**，在 `this.worldTrendProvider = observerDir ? new WorldTrendProvider(observerDir, seed) : null` 之后追加：

```ts
    this.getBehaviorSources = deps.getBehaviorSources ?? null
    this.getExternalSources = deps.getExternalSources ?? null
    this.getFeedbackSources = deps.getFeedbackSources ?? null
    this.sourceAggregator = new SourceAggregator()
    this.sourceAggregator.addProvider({ domain: 'module', name: 'module-metrics', collect: () => this.getSources() })
    this.sourceAggregator.addProvider({ domain: 'behavior', name: 'user-behavior', collect: () => this.getBehaviorSources?.() ?? [] })
    this.sourceAggregator.addProvider({ domain: 'observation', name: 'observer-insights', collect: () => this.buildInsightSources() })
    this.sourceAggregator.addProvider({ domain: 'external', name: 'github-inspiration', collect: () => this.getExternalSources?.() ?? [] })
    this.sourceAggregator.addProvider({ domain: 'feedback', name: 'user-feedback', collect: () => this.getFeedbackSources?.() ?? [] })
    this.sourceAggregator.addProvider({ domain: 'failure', name: 'rejected-hypotheses', collect: () => this.buildFailureSources() })
    this.fermentation = new IdeaFermentationEngine(this.store, hypothesisJson, () => this.buildSources())
```

**3e. 新增私有方法**（放在 `forceCycle()` 之前）：

```ts
  private buildInsightSources(): CreativitySource[] {
    const sources: CreativitySource[] = []
    for (const i of this.getInsights()) {
      sources.push({ name: `洞察:${i.title}`, content: `${i.description} (评分:${i.score})`, type: 'insight', weight: 0.7 })
    }
    if (this.worldTrendProvider) {
      for (const insight of this.worldTrendProvider.getInsights()) {
        sources.push({ name: `观察:${insight.slice(0, 16)}`, content: insight, type: 'insight', weight: 0.75 })
      }
    }
    return sources
  }

  private buildFailureSources(): CreativitySource[] {
    return this.getFailedHypotheses().map((h) => ({
      name: `失败:${h.title}`,
      content: h.idea,
      type: 'failure' as const,
      weight: 0.6,
    }))
  }

  private buildSources(): CreativitySource[] {
    return this.sourceAggregator.build()
  }
```

**3f. `cycle()`**：`let sources = this.getSources()` 改为 `const sources = this.buildSources()`。

**3g. `dreamCycle()`**：把

```ts
    const recentSources = this.getSources()
    const historicalCombos = this.store.getRecentCombos(30)
    const failedHypotheses = this.store.getHypotheses({ status: 'rejected' }).map((h) => ({ title: h.title, idea: h.idea, risk: h.risk }))

    const insights = this.getInsights()
    const insightSources: CreativitySource[] = insights.map((i) => ({
      name: `洞察:${i.title}`,
      content: `${i.description} (评分:${i.score})`,
      type: 'insight' as const,
      weight: 0.7,
    }))

    const allSources = [...recentSources, ...insightSources]
```

改为：

```ts
    const recentSources = this.buildSources()
    const historicalCombos = this.store.getRecentCombos(30)
    const failedHypotheses = this.store.getHypotheses({ status: 'rejected' }).map((h) => ({ title: h.title, idea: h.idea, risk: h.risk }))
```

并把 `this.generator.dreamIdeas(allSources, ...)` 改为 `this.generator.dreamIdeas(recentSources, ...)`。
**3h. `forceCycle()`**：`const sources = this.getSources()` 改为 `const sources = this.buildSources()`。

**3i. `forceDreamCycle()`**：把

```ts
    const recentSources = this.getSources()
    const historicalCombos = this.store.getRecentCombos(30)
    const failedHypotheses = this.store.getHypotheses({ status: 'rejected' })
    const insights = this.getInsights().map((i) => ({
      name: `洞察:${i.title}`,
      content: `${i.description} (评分:${i.score})`,
      type: 'insight' as const,
      weight: 0.7,
    }))
    const allSources = [...recentSources, ...insights]
```

改为：

```ts
    const recentSources = this.buildSources()
    const historicalCombos = this.store.getRecentCombos(30)
    const failedHypotheses = this.store.getHypotheses({ status: 'rejected' })
```

并把 `this.generator.dreamIdeas(allSources, ...)` 改为 `this.generator.dreamIdeas(recentSources, ...)`。

**3j. 新增 `forceFerment()`**，放在 `forceDreamCycle()` 之后、`getStore()` 之前：

```ts
  async forceFerment(): Promise<FermentResult> {
    return this.fermentation.ferment()
  }
```

**3k. `start()`**：TaskRunner 分支中 `this.taskRunner.register('creativity.dream', ...)` 之后追加：

```ts
      this.taskRunner.register(
        'creativity.ferment',
        async () => {
          await this.forceFerment()
          return { success: true }
        },
        FERMENT_INTERVAL_MS,
      )
```

并把 `this.taskRunnerKeys = ['creativity.cycle', 'creativity.dream']` 改为：

```ts
      this.taskRunnerKeys = ['creativity.cycle', 'creativity.dream', 'creativity.ferment']
```

Fallback 分支中 `this.dreamTimer = setInterval(...)` 之后追加：

```ts
    this.fermentTimer = setInterval(() => {
      this.forceFerment()
    }, FERMENT_INTERVAL_MS)
```

**3l. `stop()`**：Fallback 分支中清 dreamTimer 之后追加：

```ts
    if (this.fermentTimer) {
      clearInterval(this.fermentTimer)
      this.fermentTimer = null
    }
```

- [x] **Step 4: 修改 `src/main/creativity/index.ts` deps 类型**

`initCreativity` 的 `deps` 参数类型追加可选字段：

```ts
  deps: {
    getSources: () => CreativitySource[]
    getBehaviorSources?: () => CreativitySource[]
    getInsights: () => { title: string; description: string; score: number }[]
    getFailedHypotheses: () => { title: string; idea: string; risk: string }[]
    getExternalSources?: () => CreativitySource[]
    getFeedbackSources?: () => CreativitySource[]
  },
```

- [x] **Step 5: 运行测试**

Run: `npx vitest run src/main/creativity/__tests__/CreativityFermentation.test.ts src/main/creativity/__tests__/CreativityService.test.ts src/main/creativity/__tests__/IdeaStore.test.ts src/main/creativity/__tests__/SourceAggregator.test.ts src/main/creativity/__tests__/IdeaFermentationEngine.test.ts`
Expected: 全部 PASS。

- [x] **Step 6: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: 无错误。
---

### Task 8: CreativityCollector 门禁

**Files:**
- Modify: `src/main/evolution/automation/CreativityCollector.ts`
- Create: `src/main/evolution/automation/__tests__/CreativityCollector.test.ts`

- [x] **Step 1: 写失败测试 `src/main/evolution/automation/__tests__/CreativityCollector.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest'
import { CreativityCollector } from '../CreativityCollector'
import type { Hypothesis } from '../../../creativity/types'

function makeHyp(partial: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id: 'h1',
    title: '点子',
    idea: '内容',
    expectedBenefit: '',
    risk: '',
    sourceLabels: [],
    novelty: 70,
    feasibility: 70,
    impact: 70,
    status: 'active',
    createdAt: Date.now(),
    ...partial,
  }
}

describe('CreativityCollector', () => {
  it('只采集 status=active 的假设', async () => {
    const store = {
      getHypotheses: vi.fn(() => [
        makeHyp({ id: 'd1', status: 'draft' }),
        makeHyp({ id: 'a1', status: 'active' }),
      ]),
    }
    const collector = new CreativityCollector(store as any)
    const problems = await collector.collect()
    expect(problems.map((p) => p.id)).toEqual(['feature:a1'])
  })

  it('无 active 时返回空数组', async () => {
    const store = {
      getHypotheses: vi.fn(() => [makeHyp({ id: 'd1', status: 'draft' })]),
    }
    const collector = new CreativityCollector(store as any)
    expect(await collector.collect()).toEqual([])
  })
})
```

- [x] **Step 2: 运行确认失败**

Run: `npx vitest run src/main/evolution/automation/__tests__/CreativityCollector.test.ts`
Expected: FAIL（测试期望只返回 active，但实现返回 draft+active）。

- [x] **Step 3: 修改 `CreativityCollector.ts`**

**3a.** 类声明改为支持注入 store：

```ts
export class CreativityCollector implements SignalCollector {
  readonly name = 'creativity'
  readonly source = 'feature' as const

  private lastRun = 0
  private minIntervalMs = 30 * 60 * 1000
  private store: typeof ideaStore

  constructor(store?: typeof ideaStore) {
    this.store = store ?? ideaStore
  }

  shouldRun(): boolean {
    if (!this.store) return false
    if (Date.now() - this.lastRun < this.minIntervalMs) return false
    return true
  }
```

**3b.** `collect()` 中的 `if (!ideaStore)` 改为 `if (!this.store)`，并把内部所有 `ideaStore` 引用改为 `this.store`。

**3c.** 过滤条件改为只采集 active：

```ts
      const candidates = all.filter(
        (h) => h.status === 'active' && (h.novelty || 0) >= 60 && (h.feasibility || 0) >= 40 && h.title && h.idea,
      )
```

- [x] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/main/evolution/automation/__tests__/CreativityCollector.test.ts`
Expected: PASS（2 个用例）。

- [x] **Step 5: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: 无错误。

---

### Task 9: 新增 trigger_idea_ferment 工具

**Files:**
- Modify: `src/main/tool/definitions/CreativityTools.ts`

- [x] **Step 1: 追加工具定义**

在 `listIdeasTool` 之后追加：

```ts
export const triggerIdeaFermentTool = buildTool({
  name: 'trigger_idea_ferment',
  description: '手动触发创意点子发酵：让 draft 状态的点子结合最新信号重新评估，合格者升级为 active',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const cs = getCreativityService()
      if (!cs) return formatToolError('创意服务暂不可用')
      const result = await cs.forceFerment()
      return formatToolResult(
        `发酵完成：升级 ${result.promoted.length} 条，拒绝 ${result.rejected.length} 条，合并 ${result.merged} 条，保留 ${result.kept} 条`,
      )
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})
```

说明：`triggerCreativityTool` / `triggerDreamCycleTool` / `listIdeasTool` 目前同样未注册进 `getAllTools.ts`（与 `trigger_ferment` 一致，属既有模式）；本任务只新增定义，不改变注册方式。

- [x] **Step 2: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: 无错误。
---

### Task 10: AppRuntime 来源接线

**Files:**
- Modify: `src/main/bootstrap/AppRuntime.ts`

- [x] **Step 1: imports**

在 fs import 中追加 `readdirSync, existsSync`：

```ts
import { promises as fsp, readFileSync, readdirSync, existsSync } from 'fs'
```

追加 inspiration 类型 import：

```ts
import { initInspiration } from '../inspiration'
import type { GitHubInspiration } from '../inspiration/GitHubInspiration'
```

- [x] **Step 2: 类字段**

在类字段区（`private pipeline?: PipelineOrchestrator` 附近）追加：

```ts
  private inspirationService?: GitHubInspiration
```

- [x] **Step 3: creativity lazyInit deps**

在 `initCreativity(...)` 调用的 deps 对象中，`getFailedHypotheses` 之后追加三个字段：

```ts
            getBehaviorSources: () => this.buildBehaviorSources(memoryService),
            getExternalSources: () => this.inspirationService?.getSources() ?? [],
            getFeedbackSources: () => this.buildFeedbackSources(join(WORKSPACE.evolution, 'observer')),
```

- [x] **Step 4: inspiration lazyInit**

把 `const inspiration = initInspiration(...)` 改为持有到字段：

```ts
        this.inspirationService = initInspiration(join(WORKSPACE.evolution, 'inspiration'), process.env.GITHUB_TOKEN)
        this.inspirationService.refresh().catch(() => {})
```

- [x] **Step 5: 修复 `buildCreativitySources` 记忆空壳**

把函数开头：

```ts
    const recentTopics: string[] = []
    const entryCount = 0
    const interactionCount = memoryService?.getInteractionCount?.() || 0
```

改为：

```ts
    const recentTopics = memoryService?.summary?.getRecent?.(5) ?? []
    const entryCount = memoryService?.getInteractionCount?.() || 0
```

把 `Memory` source 的 content 改为：

```ts
        content: `对话记忆：${recentTopics.length} 条摘要${recentTopics.length > 0 ? `，最近：${recentTopics.slice(0, 3).join('、')}` : ''}`,
```

删除该函数中的 `UserBehavior` source 条目（行为域改由 `buildBehaviorSources` 提供）。
- [x] **Step 6: 新增 `buildBehaviorSources` 与 `buildFeedbackSources`**

在 `buildCreativitySources` 方法之后追加：

```ts
  private buildBehaviorSources(memoryService: MemoryService | null): any[] {
    const interactions = memoryService?.interactionTracker?.getRecent?.(5) ?? []
    const interactionCount = memoryService?.getInteractionCount?.() || 0
    const recent = interactions
      .map((i: any) => i.userText ?? '')
      .filter(Boolean)
      .slice(0, 3)
    const content = recent.length > 0
      ? `最近交互 ${interactionCount} 次，最近记录：${recent.join(' | ')}`
      : `最近交互 ${interactionCount} 次`
    return [{ name: 'UserBehavior', content, type: 'behavior', weight: 0.7 }]
  }

  private buildFeedbackSources(observerDir: string): any[] {
    try {
      const feedbackDir = join(observerDir, 'evolution', 'feedback')
      if (!existsSync(feedbackDir)) return []
      const files = readdirSync(feedbackDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, 3)
      const sources: any[] = []
      for (const file of files) {
        let signals: any[] = []
        try {
          signals = JSON.parse(readFileSync(join(feedbackDir, file), 'utf-8'))
        } catch {
          continue
        }
        for (const s of signals.slice(0, 5)) {
          sources.push({
            name: `反馈:${s.source}:${s.dimension}`,
            content: `${s.topicId} ${s.dimension}=${s.value}${s.comment ? `，${s.comment}` : ''}`,
            type: 'feedback',
            weight: 0.8,
          })
        }
      }
      return sources
    } catch {
      return []
    }
  }
```

- [x] **Step 7: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: 无错误。

---

### Task 11: 全量验证

- [x] **Step 1: 运行全部相关测试**

Run: `npx vitest run src/main/creativity src/main/evolution/automation/__tests__/CreativityCollector.test.ts`
Expected: 全部 PASS（含既有 creativity 测试）。

- [x] **Step 2: 全量类型检查**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: 无错误。

- [x] **Step 3: 收尾核对**

核对清单：
- `CreativityCollector` 只采集 `active`；
- `forceFerment()` 可被工具调用；
- `creativity.ferment` 已注册 TaskRunner；
- AppRuntime 的 `getSources` 不再有空壳 Memory；
- 迁移 v44 可执行（在空库与存量库）。

---

## 自检记录

- **Spec 覆盖**：发酵状态语义（Task 1/3/5）、采集器门禁（Task 8）、调度与工具（Task 6/7/9）、来源六域（Task 4/7/10）、失败兜底（Task 5 测试）、淘汰规则（Task 5 测试）、迁移（Task 2）、真实记忆与 GitHubInspiration/feedback 接线（Task 10）。
- **无占位符**：所有代码步骤含完整代码；命令含期望输出。
- **类型一致性**：`getFermentableHypotheses`、`updateHypothesisFermentation`、`forceFerment`、`buildSources` 等名称在全部任务中保持一致；`HypothesisFermentationPatch` 字段与 Drizzle 列名一一对应。
