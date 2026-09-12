# M5.7 Observation Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a controlled M5.7 observation runner that launches Mio, submits real chat tasks through the existing chat path, collects observation artifacts, and stops automatically when the shadow evidence gate is reached.

**Architecture:** Keep legacy Evolution authority, collectors, `ProblemQueue`, and executors unchanged. Add one thin CLI runner script plus one testable core module that manages task scheduling, restart policy, status artifacts, and gate evaluation while delegating real work to the existing `window.electronAPI.chat(...)` path and the existing M5.6 observation collectors.

**Tech Stack:** TypeScript, Playwright Electron driver, Electron preload IPC, existing M5.6 observation helpers, Vitest, JSON artifact persistence.

---

## Planned File Structure

- Create: `src/main/evolution/automation/M57ObservationRunner.ts`
  - Pure runner contracts, prompt pools, task scheduling, gate checks, status/final-report builders, and loop helpers that are easy to test.
- Create: `src/main/evolution/automation/__tests__/M57ObservationRunner.test.ts`
  - Unit tests for parse args, weighted scheduling, stalled-growth detection, dry-run semantics, and authority invariants.
- Create: `src/main/evolution/automation/__tests__/M57ObservationRunner.artifacts.test.ts`
  - Artifact persistence tests for `latest.json`, `history.jsonl`, `runner_status.json`, and `final-report.json`.
- Create: `scripts/m57-observation-runner.ts`
  - CLI entrypoint that launches Electron through Playwright, calls `window.electronAPI.chat(...)`, invokes existing observation functions, and persists runner artifacts.
- Modify: `package.json`
  - Add a discoverable `m57:observe` script for operators.

This split keeps the script thin and puts nearly all branchy logic into one importable module. It also matches the existing pattern where tests import reusable helpers while the CLI script stays `isMain`-guarded.

### Task 1: Freeze the runner contract with failing tests

**Files:**
- Create: `src/main/evolution/automation/__tests__/M57ObservationRunner.test.ts`
- Create: `src/main/evolution/automation/__tests__/M57ObservationRunner.artifacts.test.ts`

- [ ] **Step 1: Write the failing CLI/options contract test**

```ts
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_M57_RUNNER_OPTIONS,
  parseM57RunnerArgs,
} from '../M57ObservationRunner'

describe('parseM57RunnerArgs', () => {
  it('parses explicit thresholds and keeps M5.7-safe defaults', () => {
    const options = parseM57RunnerArgs([
      '--targetToolEvents=1200',
      '--targetCapabilityEvents=350',
      '--since=2026-07-29T15:40:00+08:00',
      '--maxTasksPerApp=25',
      '--dryRun',
    ])

    expect(options).toMatchObject({
      targetToolEvents: 1200,
      targetCapabilityEvents: 350,
      sinceMs: Date.parse('2026-07-29T15:40:00+08:00'),
      maxTasksPerApp: 25,
      dryRun: true,
    })

    expect(DEFAULT_M57_RUNNER_OPTIONS.browserWeight).toBe(0.1)
    expect(DEFAULT_M57_RUNNER_OPTIONS.authorityReviewGranted).toBe(false)
  })
})
```

- [ ] **Step 2: Write the failing scheduling and balancing test**

```ts
import { buildDefaultM57TaskPool, pickNextTask } from '../M57ObservationRunner'

it('down-weights overrepresented classes and keeps browser optional', () => {
  const pool = buildDefaultM57TaskPool()

  const selected = pickNextTask(pool, {
    recentTaskTypes: [
      'system.execution',
      'system.execution',
      'system.execution',
      'file.management',
    ],
    failureCounts: {
      'browser.automation': 3,
    },
    browserEnabled: true,
  })

  expect(selected.type).not.toBe('system.execution')
  expect(pool.some((task) => task.type === 'browser.automation')).toBe(true)
})
```

- [ ] **Step 3: Write the failing stalled-growth and gate test**

```ts
import { evaluateM57RunnerGate, shouldRestartAfterSnapshot } from '../M57ObservationRunner'

it('restarts after repeated no-growth windows and never grants authority', () => {
  expect(
    shouldRestartAfterSnapshot({
      consecutiveNoGrowth: 3,
      consecutiveFailures: 1,
      tasksInCurrentApp: 8,
      elapsedMinutesInCurrentApp: 5,
      maxTasksPerApp: 20,
      maxMinutesPerApp: 30,
      maxConsecutiveFailures: 5,
    }),
  ).toBe('stalled_growth')

  const gate = evaluateM57RunnerGate({
    toolEvents: 1000,
    capabilityEvents: 300,
    capabilityTypes: ['browser.automation', 'file.management', 'search.retrieval', 'system.execution'],
    aggregationGainStable: true,
    sourceMismatchSpike: false,
  })

  expect(gate.status).toBe('complete')
  expect(gate.authorityReviewGranted).toBe(false)
})
```

- [ ] **Step 4: Write the failing artifact persistence test**

```ts
import { mkdtempSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  persistM57ObservationArtifacts,
  type M57RunnerStatus,
} from '../M57ObservationRunner'

it('writes runner status separately from observation evidence', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'm57-runner-'))
  const status: M57RunnerStatus = {
    state: 'running',
    startedAt: '2026-07-30T02:00:00.000Z',
    updatedAt: '2026-07-30T02:05:00.000Z',
    lastTaskType: 'search.retrieval',
    lastEffectiveGrowthAt: '2026-07-30T02:04:00.000Z',
    consecutiveFailures: 0,
    consecutiveNoGrowth: 0,
    gateReached: false,
    authorityReviewGranted: false,
  }

  persistM57ObservationArtifacts(outDir, {
    latestSnapshot: {
      timestamp: '2026-07-30T02:05:00.000Z',
      since: '2026-07-29T07:40:00.000Z',
      events: 320,
      taggedEvents: 110,
      coverage: 0.34375,
      capabilities: { 'search.retrieval': 30 },
      enrichmentGap: 0,
      catalogGap: 0,
      sourceMismatch: 0,
    },
    status,
    finalReport: null,
  })

  expect(JSON.parse(readFileSync(join(outDir, 'runner_status.json'), 'utf8'))).toEqual(status)
})
```

- [ ] **Step 5: Run the focused suite to verify RED**

Run:

```bash
npm test -- src/main/evolution/automation/__tests__/M57ObservationRunner.test.ts src/main/evolution/automation/__tests__/M57ObservationRunner.artifacts.test.ts
```

Expected: FAIL because the M5.7 runner module does not exist yet.

- [ ] **Step 6: Commit the frozen red contract**

```bash
git add src/main/evolution/automation/__tests__/M57ObservationRunner.test.ts src/main/evolution/automation/__tests__/M57ObservationRunner.artifacts.test.ts
git commit -m "test(m57): freeze observation runner contract"
```

### Task 2: Build the pure runner core and artifact helpers

**Files:**
- Create: `src/main/evolution/automation/M57ObservationRunner.ts`
- Modify: `src/main/evolution/automation/__tests__/M57ObservationRunner.test.ts`
- Modify: `src/main/evolution/automation/__tests__/M57ObservationRunner.artifacts.test.ts`

- [ ] **Step 1: Add the runner contracts and defaults**

```ts
import { appendFileSync, mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'

import type { M56ObservationSnapshot } from '../../../../scripts/m56-observation-window'

export type M57TaskType =
  | 'system.execution'
  | 'file.management'
  | 'search.retrieval'
  | 'browser.automation'

export interface M57TaskPrompt {
  id: string
  type: M57TaskType
  prompt: string
}

export interface M57RunnerOptions {
  sinceMs: number
  outDir: string
  persistDir: string
  targetToolEvents: number
  targetCapabilityEvents: number
  maxTasksPerApp: number
  maxMinutesPerApp: number
  pollMs: number
  maxConsecutiveFailures: number
  browserWeight: number
  dryRun: boolean
  authorityReviewGranted: false
}

export const DEFAULT_M57_RUNNER_OPTIONS: M57RunnerOptions = {
  sinceMs: Date.parse('2026-07-29T15:40:00+08:00'),
  outDir: resolve(process.cwd(), 'reports', 'm57', 'observation'),
  persistDir: resolve(process.env.APPDATA || '', 'akemi-mio', 'evolution_workspace', 'pipeline_data'),
  targetToolEvents: 1000,
  targetCapabilityEvents: 300,
  maxTasksPerApp: 20,
  maxMinutesPerApp: 30,
  pollMs: 3000,
  maxConsecutiveFailures: 5,
  browserWeight: 0.1,
  dryRun: false,
  authorityReviewGranted: false,
}
```

- [ ] **Step 2: Implement arg parsing, task pool, and weighted picker**

```ts
export function parseM57RunnerArgs(args: string[]): M57RunnerOptions {
  const options = { ...DEFAULT_M57_RUNNER_OPTIONS }

  for (const arg of args) {
    if (arg.startsWith('--targetToolEvents=')) options.targetToolEvents = Number(arg.slice('--targetToolEvents='.length))
    else if (arg.startsWith('--targetCapabilityEvents=')) options.targetCapabilityEvents = Number(arg.slice('--targetCapabilityEvents='.length))
    else if (arg.startsWith('--since=')) options.sinceMs = Date.parse(arg.slice('--since='.length))
    else if (arg.startsWith('--persistDir=')) options.persistDir = resolve(arg.slice('--persistDir='.length))
    else if (arg.startsWith('--outDir=')) options.outDir = resolve(arg.slice('--outDir='.length))
    else if (arg.startsWith('--maxTasksPerApp=')) options.maxTasksPerApp = Number(arg.slice('--maxTasksPerApp='.length))
    else if (arg.startsWith('--maxMinutesPerApp=')) options.maxMinutesPerApp = Number(arg.slice('--maxMinutesPerApp='.length))
    else if (arg.startsWith('--pollMs=')) options.pollMs = Number(arg.slice('--pollMs='.length))
    else if (arg.startsWith('--maxConsecutiveFailures=')) options.maxConsecutiveFailures = Number(arg.slice('--maxConsecutiveFailures='.length))
    else if (arg.startsWith('--browserWeight=')) options.browserWeight = Number(arg.slice('--browserWeight='.length))
    else if (arg === '--dryRun') options.dryRun = true
  }

  return options
}

export function buildDefaultM57TaskPool(): M57TaskPrompt[] {
  return [
    { id: 'sys-git-status', type: 'system.execution', prompt: '查看当前项目 git 状态，并总结有哪些未提交改动。' },
    { id: 'sys-last-commit', type: 'system.execution', prompt: '列出最近一次提交影响的文件，并按目录归类。' },
    { id: 'file-package-version', type: 'file.management', prompt: '读取项目里的 package.json，告诉我当前版本，然后创建一个临时说明文件并写入内容。' },
    { id: 'file-config-summary', type: 'file.management', prompt: '读取一个配置文件内容，再在临时目录生成摘要文件。' },
    { id: 'search-capability', type: 'search.retrieval', prompt: '搜索项目中所有包含 capability 的定义位置，并总结。' },
    { id: 'search-collector-entry', type: 'search.retrieval', prompt: '搜索 evolution 相关 collector 的入口并列出关键文件。' },
    { id: 'browser-public-title', type: 'browser.automation', prompt: '打开一个公开网页，提取标题和主要内容。' },
    { id: 'browser-domestic-summary', type: 'browser.automation', prompt: '访问一个国内公开网页，提取页面主标题和前两段内容。' },
  ]
}
```

- [ ] **Step 3: Implement restart/gate evaluation and artifact writers**

```ts
export function shouldRestartAfterSnapshot(input: {
  consecutiveNoGrowth: number
  consecutiveFailures: number
  tasksInCurrentApp: number
  elapsedMinutesInCurrentApp: number
  maxTasksPerApp: number
  maxMinutesPerApp: number
  maxConsecutiveFailures: number
}): 'stalled_growth' | 'failure_budget' | 'session_rollover' | null {
  if (input.consecutiveNoGrowth >= 3) return 'stalled_growth'
  if (input.consecutiveFailures >= input.maxConsecutiveFailures) return 'failure_budget'
  if (input.tasksInCurrentApp >= input.maxTasksPerApp) return 'session_rollover'
  if (input.elapsedMinutesInCurrentApp >= input.maxMinutesPerApp) return 'session_rollover'
  return null
}

export function evaluateM57RunnerGate(input: {
  toolEvents: number
  capabilityEvents: number
  capabilityTypes: string[]
  aggregationGainStable: boolean
  sourceMismatchSpike: boolean
}): {
  status: 'hold' | 'complete'
  gateReached: boolean
  authorityReviewGranted: false
} {
  const gateReached =
    input.toolEvents >= 1000 &&
    input.capabilityEvents >= 300 &&
    input.capabilityTypes.length >= 4 &&
    input.aggregationGainStable &&
    !input.sourceMismatchSpike

  return {
    status: gateReached ? 'complete' : 'hold',
    gateReached,
    authorityReviewGranted: false,
  }
}
```

```ts
export interface M57RunnerStatus {
  state: 'starting' | 'running' | 'restarting' | 'complete' | 'failed'
  startedAt: string
  updatedAt: string
  lastTaskType: M57TaskType | null
  lastEffectiveGrowthAt: string | null
  consecutiveFailures: number
  consecutiveNoGrowth: number
  gateReached: boolean
  authorityReviewGranted: false
}

export function persistM57ObservationArtifacts(
  outDir: string,
  input: {
    latestSnapshot: M56ObservationSnapshot
    status: M57RunnerStatus
    finalReport: Record<string, unknown> | null
  },
): void {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'latest.json'), JSON.stringify(input.latestSnapshot, null, 2), 'utf8')
  appendFileSync(join(outDir, 'history.jsonl'), `${JSON.stringify(input.latestSnapshot)}\n`, 'utf8')
  writeFileSync(join(outDir, 'runner_status.json'), JSON.stringify(input.status, null, 2), 'utf8')
  if (input.finalReport) {
    writeFileSync(join(outDir, 'final-report.json'), JSON.stringify(input.finalReport, null, 2), 'utf8')
  }
}
```

- [ ] **Step 4: Run the new unit tests to verify GREEN**

Run:

```bash
npm test -- src/main/evolution/automation/__tests__/M57ObservationRunner.test.ts src/main/evolution/automation/__tests__/M57ObservationRunner.artifacts.test.ts
```

Expected: PASS for arg parsing, scheduling, gate logic, and artifact writing.

- [ ] **Step 5: Commit the pure runner core**

```bash
git add src/main/evolution/automation/M57ObservationRunner.ts src/main/evolution/automation/__tests__/M57ObservationRunner.test.ts src/main/evolution/automation/__tests__/M57ObservationRunner.artifacts.test.ts
git commit -m "feat(m57): add observation runner core"
```

### Task 3: Build the Electron app controller and chat driver

**Files:**
- Create: `scripts/m57-observation-runner.ts`
- Modify: `src/main/evolution/automation/M57ObservationRunner.ts`
- Test: `src/main/evolution/automation/__tests__/M57ObservationRunner.test.ts`

- [ ] **Step 1: Write the failing dry-run and preload-API probe test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { createM57RunnerAppController } from '../M57ObservationRunner'

describe('createM57RunnerAppController', () => {
  it('fails fast when preload chat API is unavailable', async () => {
    const windowMock = {
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue(false),
    }

    const launcher = vi.fn().mockResolvedValue({
      firstWindow: vi.fn().mockResolvedValue(windowMock),
      close: vi.fn().mockResolvedValue(undefined),
    })

    const controller = createM57RunnerAppController({
      launchElectron: launcher,
      now: () => 1,
    })

    await expect(controller.launchAndProbe('D:/work/code/akemi-mio/out/main/index.js')).rejects.toThrow(
      'electronAPI.chat unavailable',
    )
  })
})
```

- [ ] **Step 2: Add the reusable app controller and chat driver helpers**

```ts
export function createM57RunnerAppController(deps: {
  launchElectron: (entry: string) => Promise<{
    firstWindow(): Promise<{
      waitForLoadState(state: 'domcontentloaded'): Promise<void>
      evaluate<T>(fn: () => T | Promise<T>): Promise<T>
    }>
    close(): Promise<void>
  }>
  now?: () => number
}) {
  return {
    async launchAndProbe(entry: string) {
      const app = await deps.launchElectron(entry)
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      await new Promise((resolve) => setTimeout(resolve, 8000))

      const hasChat = await win.evaluate(() => typeof window.electronAPI?.chat === 'function')
      if (!hasChat) {
        await app.close()
        throw new Error('electronAPI.chat unavailable')
      }

      return { app, win }
    },
  }
}

export async function submitM57ChatTask(input: {
  win: {
    evaluate<T, P>(fn: (payload: P) => T | Promise<T>, payload: P): Promise<T>
  }
  prompt: M57TaskPrompt
  requestId: string
  sessionId: string
}): Promise<{ reply?: string; error?: string }> {
  return input.win.evaluate(async (payload) => {
    const api = window.electronAPI
    if (!api?.chat) return { error: 'NO_CHAT_API' }
    return api.chat(payload.prompt, payload.requestId, payload.sessionId, true)
  }, {
    prompt: input.prompt.prompt,
    requestId: input.requestId,
    sessionId: input.sessionId,
  })
}
```

- [ ] **Step 3: Add the thin CLI entrypoint that launches Electron through Playwright**

```ts
#!/usr/bin/env tsx
import { existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { _electron as electron } from 'playwright'

import {
  createM57RunnerAppController,
  parseM57RunnerArgs,
} from '../src/main/evolution/automation/M57ObservationRunner'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT = resolve(ROOT, 'out', 'main', 'index.js')

function assertEntryExists(entry: string): void {
  if (!existsSync(entry)) {
    throw new Error(`Electron entry not found: ${entry}`)
  }
}

async function launchElectron(entry: string) {
  return electron.launch({
    args: [entry],
    cwd: ROOT,
    env: { ...process.env, RUNTIME_ENABLED: '1' },
  })
}

async function main() {
  const options = parseM57RunnerArgs(process.argv.slice(2))
  assertEntryExists(OUT)

  const controller = createM57RunnerAppController({ launchElectron })
  const session = await controller.launchAndProbe(OUT)
  await session.app.close()

  if (options.dryRun) {
    console.log('M5.7 dry run OK')
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
```

- [ ] **Step 4: Run the focused controller test and dry run**

Run:

```bash
npm test -- src/main/evolution/automation/__tests__/M57ObservationRunner.test.ts
npx tsx scripts/m57-observation-runner.ts --dryRun
```

Expected:
- tests PASS
- CLI prints `M5.7 dry run OK` if the app launches and `electronAPI.chat` is available
- no real observation task is sent during `--dryRun`

- [ ] **Step 5: Commit the app controller**

```bash
git add scripts/m57-observation-runner.ts src/main/evolution/automation/M57ObservationRunner.ts src/main/evolution/automation/__tests__/M57ObservationRunner.test.ts
git commit -m "feat(m57): add electron app controller for observation runner"
```

### Task 4: Reuse the M5.6 observation helpers and persist runner evidence

**Files:**
- Modify: `src/main/evolution/automation/M57ObservationRunner.ts`
- Modify: `scripts/m57-observation-runner.ts`
- Test: `src/main/evolution/automation/__tests__/M57ObservationRunner.artifacts.test.ts`

- [ ] **Step 1: Write the failing observation-bridge test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { createM57ObservationBridge } from '../M57ObservationRunner'

describe('createM57ObservationBridge', () => {
  it('flags no-growth snapshots without mutating authority', async () => {
    const bridge = createM57ObservationBridge({
      collectSnapshot: vi
        .fn()
        .mockResolvedValueOnce({ events: 300, taggedEvents: 100, coverage: 1 / 3, capabilities: {}, enrichmentGap: 0, catalogGap: 0, sourceMismatch: 0, since: '', timestamp: '' })
        .mockResolvedValueOnce({ events: 300, taggedEvents: 100, coverage: 1 / 3, capabilities: {}, enrichmentGap: 0, catalogGap: 0, sourceMismatch: 0, since: '', timestamp: '' }),
      collectShadow: vi.fn().mockResolvedValue({
        summary: { aggregationGainRate: 0.2, trendCorrelation: 1, capabilityEvents: 100, totalToolEvents: 300, legacyBucketCount: 5, capabilityBucketCount: 4, aggregationGain: 1, trendSampleCount: 4, coverageRate: 1 / 3 },
      }),
    })

    const first = await bridge.collect()
    const second = await bridge.collect()

    expect(first.grew).toBe(true)
    expect(second.grew).toBe(false)
    expect(second.authorityReviewGranted).toBe(false)
  })
})
```

- [ ] **Step 2: Add the observation bridge around existing M5.6 helpers**

```ts
import { collectObservationSnapshot } from '../../../../scripts/m56-observation-window'
import { resolveCapabilityEvolutionShadowRun } from './CapabilityEvolutionShadowObservationSource'
import { CapabilityEvolutionShadowStore } from './CapabilityEvolutionShadowStore'
import { toolCallLogStore } from '../../tool/ToolCallLogStore'

export function createM57ObservationBridge(deps?: {
  collectSnapshot?: () => Promise<M56ObservationSnapshot> | M56ObservationSnapshot
  collectShadow?: () => Promise<{ summary: { aggregationGainRate: number; trendCorrelation: number | null } }>
}) {
  let previousEvents = -1

  return {
    async collect() {
      const snapshot = await (deps?.collectSnapshot?.() ?? collectObservationSnapshot(process.cwd(), DEFAULT_M57_RUNNER_OPTIONS.sinceMs))
      const shadow = await (deps?.collectShadow?.() ?? Promise.resolve({
        summary: resolveCapabilityEvolutionShadowRun({
          latestStoredRun: new CapabilityEvolutionShadowStore(DEFAULT_M57_RUNNER_OPTIONS.persistDir).getLatest(),
          records: toolCallLogStore.query({ limit: 500 }),
          collectorName: 'capability-evolution-shadow-collector',
        }).run.summary,
      }))

      const grew = previousEvents < 0 || snapshot.events > previousEvents
      previousEvents = snapshot.events

      return {
        snapshot,
        shadowSummary: shadow.summary,
        grew,
        authorityReviewGranted: false as const,
      }
    },
  }
}
```

- [ ] **Step 3: Wire the bridge into the CLI and persist latest/history/status**

```ts
const bridge = createM57ObservationBridge()
const observation = await bridge.collect()

persistM57ObservationArtifacts(options.outDir, {
  latestSnapshot: observation.snapshot,
  status: {
    state: 'running',
    startedAt,
    updatedAt: new Date().toISOString(),
    lastTaskType: null,
    lastEffectiveGrowthAt: observation.grew ? new Date().toISOString() : null,
    consecutiveFailures: 0,
    consecutiveNoGrowth: observation.grew ? 0 : 1,
    gateReached: false,
    authorityReviewGranted: false,
  },
  finalReport: null,
})
```

- [ ] **Step 4: Run the artifact bridge tests**

Run:

```bash
npm test -- src/main/evolution/automation/__tests__/M57ObservationRunner.artifacts.test.ts
```

Expected: PASS, including separate status artifacts and no-growth detection.

- [ ] **Step 5: Commit the observation bridge**

```bash
git add src/main/evolution/automation/M57ObservationRunner.ts scripts/m57-observation-runner.ts src/main/evolution/automation/__tests__/M57ObservationRunner.artifacts.test.ts
git commit -m "feat(m57): bridge runner to existing observation collectors"
```

### Task 5: Implement the main loop, restart policy, and final report

**Files:**
- Modify: `src/main/evolution/automation/M57ObservationRunner.ts`
- Modify: `scripts/m57-observation-runner.ts`
- Modify: `package.json`
- Test: `src/main/evolution/automation/__tests__/M57ObservationRunner.test.ts`

- [ ] **Step 1: Write the failing loop/gate integration test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { createM57RunnerLoop } from '../M57ObservationRunner'

describe('createM57RunnerLoop', () => {
  it('stops only after the M5.7 evidence gate is reached', async () => {
    const submitTask = vi.fn().mockResolvedValue({ reply: 'ok' })
    const collect = vi
      .fn()
      .mockResolvedValueOnce({
        snapshot: { events: 900, taggedEvents: 280, coverage: 0.31, capabilities: { 'file.management': 80, 'search.retrieval': 70, 'system.execution': 80, 'browser.automation': 50 }, enrichmentGap: 0, catalogGap: 0, sourceMismatch: 0, since: '', timestamp: '' },
        shadowSummary: { aggregationGainRate: 0.2, trendCorrelation: 1, capabilityEvents: 280, totalToolEvents: 900, legacyBucketCount: 5, capabilityBucketCount: 4, aggregationGain: 1, trendSampleCount: 4 },
        grew: true,
        authorityReviewGranted: false,
      })
      .mockResolvedValueOnce({
        snapshot: { events: 1000, taggedEvents: 300, coverage: 0.3, capabilities: { 'file.management': 90, 'search.retrieval': 80, 'system.execution': 80, 'browser.automation': 50 }, enrichmentGap: 0, catalogGap: 0, sourceMismatch: 0, since: '', timestamp: '' },
        shadowSummary: { aggregationGainRate: 0.2, trendCorrelation: 1, capabilityEvents: 300, totalToolEvents: 1000, legacyBucketCount: 5, capabilityBucketCount: 4, aggregationGain: 1, trendSampleCount: 4 },
        grew: true,
        authorityReviewGranted: false,
      })

    const loop = createM57RunnerLoop({
      options: { ...DEFAULT_M57_RUNNER_OPTIONS, pollMs: 1 },
      submitTask,
      collectObservation: collect,
      sleep: async () => {},
      now: () => 0,
    })

    const finalReport = await loop.run()
    expect(finalReport.toolEvents).toBe(1000)
    expect(finalReport.gateReached).toBe(true)
    expect(finalReport.authorityReviewGranted).toBe(false)
  })
})
```

- [ ] **Step 2: Implement the serial task loop and restart handling**

```ts
export function createM57RunnerLoop(deps: {
  options: M57RunnerOptions
  submitTask: (task: M57TaskPrompt, sessionId: string) => Promise<{ reply?: string; error?: string }>
  collectObservation: () => Promise<{
    snapshot: M56ObservationSnapshot
    shadowSummary: { aggregationGainRate: number; trendCorrelation: number | null }
    grew: boolean
    authorityReviewGranted: false
  }>
  sleep: (ms: number) => Promise<void>
  now?: () => number
}) {
  return {
    async run() {
      const pool = buildDefaultM57TaskPool()
      const taskCounts: Record<string, number> = {}
      const failureCounts: Record<string, number> = {}
      const capabilityTypes = new Set<string>()
      let consecutiveFailures = 0
      let consecutiveNoGrowth = 0
      let tasksInCurrentApp = 0
      let sessionId = `m57-${Date.now().toString(36)}`
      const startedAt = new Date((deps.now ?? Date.now)()).toISOString()

      while (true) {
        const task = pickNextTask(pool, {
          recentTaskTypes: Object.keys(taskCounts),
          failureCounts,
          browserEnabled: true,
        })

        const result = await deps.submitTask(task, sessionId)
        taskCounts[task.type] = (taskCounts[task.type] ?? 0) + 1
        tasksInCurrentApp += 1

        if (result.error) {
          failureCounts[task.type] = (failureCounts[task.type] ?? 0) + 1
          consecutiveFailures += 1
        } else {
          consecutiveFailures = 0
        }

        const observation = await deps.collectObservation()
        Object.keys(observation.snapshot.capabilities).forEach((item) => capabilityTypes.add(item))
        consecutiveNoGrowth = observation.grew ? 0 : consecutiveNoGrowth + 1

        const gate = evaluateM57RunnerGate({
          toolEvents: observation.snapshot.events,
          capabilityEvents: observation.snapshot.taggedEvents,
          capabilityTypes: [...capabilityTypes],
          aggregationGainStable: observation.shadowSummary.aggregationGainRate >= 0.2,
          sourceMismatchSpike: observation.snapshot.sourceMismatch > 0,
        })

        if (gate.gateReached) {
          return {
            startedAt,
            finishedAt: new Date((deps.now ?? Date.now)()).toISOString(),
            since: new Date(deps.options.sinceMs).toISOString(),
            toolEvents: observation.snapshot.events,
            capabilityEvents: observation.snapshot.taggedEvents,
            coverage: observation.snapshot.coverage,
            capabilityTypes: [...capabilityTypes].sort(),
            aggregationGain: observation.shadowSummary.aggregationGainRate,
            trendCorrelation: observation.shadowSummary.trendCorrelation ?? 0,
            taskCounts,
            failureCounts,
            gateReached: true,
            authorityReviewGranted: false,
          }
        }

        if (shouldRestartAfterSnapshot({
          consecutiveNoGrowth,
          consecutiveFailures,
          tasksInCurrentApp,
          elapsedMinutesInCurrentApp: 0,
          maxTasksPerApp: deps.options.maxTasksPerApp,
          maxMinutesPerApp: deps.options.maxMinutesPerApp,
          maxConsecutiveFailures: deps.options.maxConsecutiveFailures,
        })) {
          sessionId = `m57-${Date.now().toString(36)}`
          tasksInCurrentApp = 0
        }

        await deps.sleep(deps.options.pollMs)
      }
    },
  }
}
```

- [ ] **Step 3: Wire the loop into the CLI and write `final-report.json` on completion**

```ts
const loop = createM57RunnerLoop({
  options,
  submitTask: (task, sessionId) =>
    submitM57ChatTask({
      win: session.win,
      prompt: task,
      requestId: `m57_${Date.now()}`,
      sessionId,
    }),
  collectObservation: () => bridge.collect(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
})

const finalReport = options.dryRun ? null : await loop.run()

persistM57ObservationArtifacts(options.outDir, {
  latestSnapshot: finalReport ? await collectObservationSnapshot(process.cwd(), options.sinceMs) : await collectObservationSnapshot(process.cwd(), options.sinceMs),
  status: {
    state: finalReport ? 'complete' : 'running',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastTaskType: null,
    lastEffectiveGrowthAt: null,
    consecutiveFailures: 0,
    consecutiveNoGrowth: 0,
    gateReached: Boolean(finalReport?.gateReached),
    authorityReviewGranted: false,
  },
  finalReport,
})
```

- [ ] **Step 4: Add a package script and verify end-to-end dry behavior**

```json
{
  "scripts": {
    "m57:observe": "tsx scripts/m57-observation-runner.ts"
  }
}
```

Run:

```bash
npm test -- src/main/evolution/automation/__tests__/M57ObservationRunner.test.ts src/main/evolution/automation/__tests__/M57ObservationRunner.artifacts.test.ts
npx tsx scripts/m57-observation-runner.ts --dryRun --pollMs=1000
```

Expected:
- tests PASS
- dry run validates startup and preload chat
- no authority fields are ever set to `true`

- [ ] **Step 5: Commit the main loop**

```bash
git add package.json scripts/m57-observation-runner.ts src/main/evolution/automation/M57ObservationRunner.ts src/main/evolution/automation/__tests__/M57ObservationRunner.test.ts src/main/evolution/automation/__tests__/M57ObservationRunner.artifacts.test.ts
git commit -m "feat(m57): add observation runner loop and gate"
```

### Task 6: Verify governance boundaries and operator workflow

**Files:**
- Modify: `docs/superpowers/specs/2026-07-30-m57-observation-runner-design.md`
- Modify: `docs/superpowers/plans/2026-07-30-m57-observation-runner.md`

- [ ] **Step 1: Run the focused verification slice**

Run:

```bash
npm test -- src/main/evolution/automation/__tests__/M57ObservationRunner.test.ts src/main/evolution/automation/__tests__/M57ObservationRunner.artifacts.test.ts src/main/evolution/automation/__tests__/CapabilityEvolutionShadowObservationSource.test.ts src/main/evolution/automation/__tests__/CapabilityEvolutionShadowCollector.test.ts
```

Expected: PASS, confirming the new runner composes with the existing shadow observation path.

- [ ] **Step 2: Run an operator dry run**

Run:

```bash
npm run m57:observe -- --dryRun --since=2026-07-29T15:40:00+08:00
```

Expected:
- app launches
- `window.electronAPI.chat` probe succeeds
- `reports/m57/observation/runner_status.json` is written
- no real sampling tasks are sent

- [ ] **Step 3: Record the invariants in the spec if any wording drift appeared during implementation**

```md
Legacy Evolution authority remains active.
Capability observation remains shadow-only.
Executor authority remains legacy-only.
Runner success is evidence readiness, not cutover approval.
```

- [ ] **Step 4: Commit the verification pass**

```bash
git add docs/superpowers/specs/2026-07-30-m57-observation-runner-design.md docs/superpowers/plans/2026-07-30-m57-observation-runner.md reports/m57/observation
git commit -m "docs(m57): record observation runner verification workflow"
```

## Guardrails

- Do not modify `src/main/evolution/automation/ProblemQueue.ts`.
- Do not modify `src/main/evolution/automation/ToolEvolutionExecutor.ts`.
- Do not modify `src/main/evolution/automation/ToolConfigOptimizationExecutor.ts`.
- Do not change collector scoring, scheduler authority, or executor authority.
- Do not write directly to `toolCallLogStore`.
- Do not replace the real chat path with a synthetic shortcut.
- Do not set any `authorityReviewGranted` field to `true`.

## Expected Operator Commands

- Dry run:

```bash
npm run m57:observe -- --dryRun
```

- Real observation run:

```bash
npm run m57:observe -- --targetToolEvents=1000 --targetCapabilityEvents=300 --since=2026-07-29T15:40:00+08:00
```

- Inspect latest M5.7 artifacts:

```bash
type reports\m57\observation\runner_status.json
type reports\m57\observation\final-report.json
```

## Self-Review

- Spec coverage: this plan covers app launch/reconnect, real chat task scheduling, observation snapshot reuse, runner status artifacts, restart policy, gate auto-stop, and dry-run validation without granting capability-first authority.
- Placeholder scan: no `TODO`, `TBD`, or “implement later” markers remain.
- Type consistency: `M57RunnerOptions`, `M57TaskPrompt`, `M57RunnerStatus`, gate outputs, and `authorityReviewGranted: false` use the same names throughout the plan.
