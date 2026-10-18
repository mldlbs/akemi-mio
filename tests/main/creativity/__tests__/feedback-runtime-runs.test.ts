/**
 * 反馈双轴观测对齐（P3 收尾）— feedback-runtime-runs.jsonl 共享读写 + CreativityService 落盘接线
 *
 * 核心验证点：
 * 1. 共享读写模块：roundtrip 保字段 / 损坏行跳过 / off·非法模式行过滤 / 缺目录返回 []
 * 2. CreativityService：observed 模式注入即落盘（shadow → applied=false；canary → applied=true）
 * 3. off 模式零行为变化：recorder 与 getFeedbackSnapshot 都不被触碰（逐字节原行为）
 * 4. 落盘失败（recorder 抛错）不阻断生成
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CreativityService } from '@akemi-mio/creativity/CreativityService'
import type { IdeaStoreLike, CreativitySource } from '@akemi-mio/creativity/types'
import {
  FEEDBACK_RUNTIME_RUNS_FILE,
  recordFeedbackRuntimeRun,
  readFeedbackRuntimeRuns,
} from '@akemi-mio/creativity/FeedbackRuntimeRuns'
import { DEFAULT_FEEDBACK_RUNTIME, type FeedbackMode } from '@akemi-mio/creativity/FeedbackRuntime'
import {
  buildFeedbackSnapshot,
  type FeedbackSnapshot,
} from '@akemi-mio/creativity/FeedbackLearning'
import type { HypothesisFeedbackEvent } from '@akemi-mio/creativity/FeedbackEvents'
import type { FeedbackRuntimeRun } from '@akemi-mio/creativity/FeedbackRollout'

const NOW = 1_800_000_000_000

function createMockStore(): IdeaStoreLike {
  const hypotheses: any[] = []
  return {
    addCombo: vi.fn(),
    addHypothesis: vi.fn(),
    addManyHypotheses: vi.fn((hs: any[]) => hypotheses.push(...hs)),
    addExperiment: vi.fn(),
    logDreamCycle: vi.fn(),
    getHypotheses: vi.fn(() => hypotheses),
    getNovelHypotheses: vi.fn(() => hypotheses),
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
    getFermentableHypotheses: vi.fn(() => hypotheses),
    updateHypothesisFermentation: vi.fn(() => true),
  }
}

function makeDiverseSources(): CreativitySource[] {
  return [
    { name: 'Memory', content: '用户偏好与记忆', type: 'knowledge', weight: 0.8 },
    { name: 'Agent', content: '工具调用模式', type: 'behavior', weight: 0.7 },
    { name: 'Insight', content: '代码质量趋势', type: 'insight', weight: 0.6 },
  ]
}

function makeValidHypothesisResponse() {
  return {
    data: [
      {
        title: '跨模块缓存优化',
        idea: '这是一个足够描述的改进方案不少于二十个字的内容描述用于验证测试',
        expectedBenefit: '提升响应速度',
        risk: '增加内存占用',
        sourceLabels: ['Agent', 'Memory'],
        novelty: 65,
        feasibility: 75,
        impact: 70,
        relevance: '记忆偏好可与行为模式协同提升任务上下文',
      },
    ],
  }
}

function feedbackEvent(
  over: Partial<HypothesisFeedbackEvent> & Pick<HypothesisFeedbackEvent, 'hypothesisId' | 'eventType'>,
): HypothesisFeedbackEvent {
  return {
    id: over.id ?? `fbe_${Math.random().toString(36).slice(2)}`,
    sourceType: over.sourceType ?? 'experiment',
    sourceId: over.sourceId ?? 's1',
    occurredAt: over.occurredAt ?? NOW,
    ingestedAt: over.ingestedAt ?? NOW,
    idempotencyKey: over.idempotencyKey ?? `k:${over.hypothesisId}:${over.eventType}:${over.sourceId ?? 's1'}`,
    schemaVersion: 1,
    ...over,
  }
}

function buildTestSnapshot(): FeedbackSnapshot {
  return buildFeedbackSnapshot(
    [
      feedbackEvent({ hypothesisId: 'h1', eventType: 'validated', sourceId: 's1' }),
      feedbackEvent({ hypothesisId: 'h1', eventType: 'adopted', sourceId: 's2' }),
      feedbackEvent({ hypothesisId: 'h2', eventType: 'rejected', sourceId: 's3' }),
    ],
    {
      h1: { sources: [{ name: 'A', origin: 'memory:a' }, { name: 'B', origin: 'memory:b' }] },
      h2: { sources: [{ name: 'C', origin: 'memory:c' }, { name: 'D', origin: 'memory:d' }] },
    },
    undefined,
    NOW,
  )
}

function createService(opts: {
  mode: FeedbackMode
  snapshot?: FeedbackSnapshot | null
  snapshotFn?: () => FeedbackSnapshot | null
  recorder?: (run: FeedbackRuntimeRun) => void
}) {
  const bus = new (require('events').EventEmitter)()
  const chatJson = vi.fn().mockResolvedValue(makeValidHypothesisResponse())
  const store = createMockStore()
  const getFeedbackSnapshot = opts.snapshotFn ?? vi.fn(() => opts.snapshot ?? null)
  const deps = {
    getSources: vi.fn(() => makeDiverseSources()),
    getInsights: vi.fn(() => []),
    getFailedHypotheses: vi.fn(() => []),
    getFeedbackSnapshot,
    getFeedbackRuntime: () => ({ ...DEFAULT_FEEDBACK_RUNTIME, mode: opts.mode }),
    recordFeedbackRuntimeRun: opts.recorder,
  }
  const service = new CreativityService(store, deps, chatJson as any, undefined, 0, 42, bus, '', undefined, undefined)
  return { service, chatJson, getFeedbackSnapshot }
}

describe('feedback-runtime-runs.jsonl 共享读写（双轴唯一实现）', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mio-fb-runs-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('record → read roundtrip 保字段，文件名固定', () => {
    const first: FeedbackRuntimeRun = { at: 1, mode: 'shadow', snapshotVersion: 'v1', pairCount: 3, applied: false }
    const second: FeedbackRuntimeRun = { at: 2, mode: 'canary', snapshotVersion: null, pairCount: 0, applied: true }
    recordFeedbackRuntimeRun(dir, first)
    recordFeedbackRuntimeRun(dir, second)

    expect(readdirSync(dir)).toContain(FEEDBACK_RUNTIME_RUNS_FILE)
    expect(FEEDBACK_RUNTIME_RUNS_FILE).toBe('feedback-runtime-runs.jsonl')
    expect(readFeedbackRuntimeRuns(dir)).toEqual([first, second])
  })

  it('损坏行 / 非对象行 / off 行 / 非法模式行全部跳过', () => {
    recordFeedbackRuntimeRun(dir, {
      at: 10,
      mode: 'full',
      snapshotVersion: 'v9',
      pairCount: 5,
      applied: true,
    })
    const file = join(dir, FEEDBACK_RUNTIME_RUNS_FILE)
    appendFileSync(file, 'not-json\n', 'utf8')
    appendFileSync(file, '"just-a-string"\n', 'utf8')
    appendFileSync(file, 'null\n', 'utf8')
    appendFileSync(file, JSON.stringify({ mode: 'off', at: 11 }) + '\n', 'utf8')
    appendFileSync(file, JSON.stringify({ mode: 'bogus', at: 12 }) + '\n', 'utf8')
    appendFileSync(file, JSON.stringify({ mode: 'shadow', at: 'bad', pairCount: 'x', applied: 1, snapshotVersion: 42 }) + '\n', 'utf8')

    const runs = readFeedbackRuntimeRuns(dir)
    expect(runs).toHaveLength(2)
    expect(runs[0]).toEqual({ at: 10, mode: 'full', snapshotVersion: 'v9', pairCount: 5, applied: true })
    // 字段级归一：数值化失败回退 0，非字符串 version 回退 null，truthy applied 归一为布尔
    expect(runs[1]).toEqual({ at: 0, mode: 'shadow', snapshotVersion: null, pairCount: 0, applied: true })
  })

  it('目录不存在时 read 返回 []，record 自动建目录', () => {
    const missing = join(dir, 'nested', 'creativity')
    expect(readFeedbackRuntimeRuns(missing)).toEqual([])
    expect(existsSync(join(missing, FEEDBACK_RUNTIME_RUNS_FILE))).toBe(false)

    recordFeedbackRuntimeRun(missing, { at: 3, mode: 'shadow', snapshotVersion: null, pairCount: 1, applied: false })
    expect(existsSync(join(missing, FEEDBACK_RUNTIME_RUNS_FILE))).toBe(true)
    expect(readFeedbackRuntimeRuns(missing)).toHaveLength(1)
  })
})

describe('CreativityService 观测落盘接线（双轴观测对齐）', () => {
  it('shadow：落一条 applied=false 的运行摘要，快照指标随行', async () => {
    const snapshot = buildTestSnapshot()
    const recorder = vi.fn()
    const { service, chatJson } = createService({ mode: 'shadow', snapshot, recorder })

    await (service as any).cycle()

    expect(recorder).toHaveBeenCalledTimes(1)
    const run = recorder.mock.calls[0][0]
    expect(run).toMatchObject({
      mode: 'shadow',
      snapshotVersion: snapshot.version,
      pairCount: snapshot.pairs.length,
      applied: false,
    })
    expect(typeof run.at).toBe('number')
    expect(chatJson).toHaveBeenCalledTimes(1)
  })

  it('canary：applied=true（反馈已注入生成）', async () => {
    const snapshot = buildTestSnapshot()
    const recorder = vi.fn()
    const { service, chatJson } = createService({ mode: 'canary', snapshot, recorder })

    await (service as any).cycle()

    expect(recorder).toHaveBeenCalledTimes(1)
    expect(recorder.mock.calls[0][0]).toMatchObject({
      mode: 'canary',
      snapshotVersion: snapshot.version,
      pairCount: snapshot.pairs.length,
      applied: true,
    })
    expect(chatJson).toHaveBeenCalledTimes(1)
  })

  it('快照缺失（null）也落盘：version/pairs 置空，applied=false', async () => {
    const recorder = vi.fn()
    const { service } = createService({ mode: 'shadow', snapshot: null, recorder })

    await (service as any).cycle()

    expect(recorder).toHaveBeenCalledTimes(1)
    expect(recorder.mock.calls[0][0]).toMatchObject({
      mode: 'shadow',
      snapshotVersion: null,
      pairCount: 0,
      applied: false,
    })
  })

  it('off：零行为变化——recorder 与 getFeedbackSnapshot 都不被触碰', async () => {
    const recorder = vi.fn()
    const snapshotFn = vi.fn(() => buildTestSnapshot())
    const { service, chatJson } = createService({ mode: 'off', snapshotFn, recorder })

    await (service as any).cycle()

    expect(recorder).not.toHaveBeenCalled()
    expect(snapshotFn).not.toHaveBeenCalled()
    expect(chatJson).toHaveBeenCalledTimes(1)
  })

  it('recorder 抛错（落盘失败）不阻断生成', async () => {
    const recorder = vi.fn(() => {
      throw new Error('disk full')
    })
    const { service, chatJson } = createService({ mode: 'shadow', snapshot: buildTestSnapshot(), recorder })

    await (service as any).cycle()

    expect(recorder).toHaveBeenCalledTimes(1)
    expect(chatJson).toHaveBeenCalledTimes(1)
  })

  it('未注入 recorder（缺省）时 observed 模式照常生成', async () => {
    const { service, chatJson } = createService({ mode: 'shadow', snapshot: buildTestSnapshot() })

    await (service as any).cycle()

    expect(chatJson).toHaveBeenCalledTimes(1)
  })
})
