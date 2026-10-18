import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { closeDatabase, initDatabase } from '@akemi-mio/core/db/connection'
import {
  DrizzleFeedbackEventStore,
  DrizzleIdeaStore,
  FeedbackLearningService,
  JsonlFeedbackEventStore,
  buildFeedbackPromptBlock,
  buildFeedbackBlockSection,
  buildMixerInputFromSnapshot,
  formatIngestSummary,
  ingestFeedbackEvents,
} from '@akemi-mio/creativity'
import type { Hypothesis } from '@akemi-mio/creativity'

import { useIsolatedTestDatabase } from './testDatabase'

function baseHypothesis(overrides: Partial<Hypothesis> & { id: string }): Hypothesis {
  return {
    title: `title-${overrides.id}`,
    idea: `idea-${overrides.id}`,
    expectedBenefit: 'b',
    risk: 'r',
    sourceLabels: ['A', 'B'],
    novelty: 60,
    feasibility: 60,
    impact: 60,
    status: 'active',
    createdAt: 1_000,
    ...overrides,
  }
}

describe('正向反馈闭环端到端（CLI JSONL → ingest → SQLite → 快照 → 提示块）', () => {
  afterEach(() => {
    closeDatabase()
  })

  it('双轴全链路：provenance 持久化、ingest 幂等与隔离、pair 归因、有界提示块', async () => {
    const restore = useIsolatedTestDatabase()
    const jsonlDir = mkdtempSync(join(tmpdir(), 'feedback-e2e-'))
    try {
      await initDatabase()

      // ── 主进程权威侧：假设（含 provenance）落 SQLite（v53 修复的断链） ──
      const ideaStore = new DrizzleIdeaStore()
      ideaStore.addHypothesis(
        baseHypothesis({
          id: 'h1',
          provenance: {
            strategy: 'explore',
            sources: [
              { name: 'A', type: 'knowledge', origin: 'memory:a' },
              { name: 'B', type: 'behavior', origin: 'memory:b' },
            ],
          },
        }),
      )
      ideaStore.addHypothesis(baseHypothesis({ id: 'h2' }))

      // provenance round-trip：读回与写入一致（此前 Drizzle 轴丢此列 → 归因断链）
      const reloaded = ideaStore.getHypothesisById('h1')
      expect(reloaded?.provenance?.sources?.map((s) => s.origin)).toEqual(['memory:a', 'memory:b'])
      expect(ideaStore.getHypothesisById('h2')?.provenance).toBeUndefined()

      // ── CLI/MCP 轴：真实 JSONL 文件生产（幂等键去重在 append 层） ──
      const jsonl = new JsonlFeedbackEventStore(jsonlDir)
      expect(jsonl.append({ hypothesisId: 'h1', eventType: 'validated', sourceType: 'experiment', sourceId: 'ferment:h1:1' }).appended).toBe(true)
      expect(jsonl.append({ hypothesisId: 'h1', eventType: 'validated', sourceType: 'experiment', sourceId: 'ferment:h1:1' }).deduped).toBe(true)
      expect(jsonl.append({ hypothesisId: 'h2', eventType: 'adopted', sourceType: 'adoption', sourceId: 'trace:h2:1' }).appended).toBe(true)
      // 幽灵假设：ingest 时进隔离，不入库不丢弃
      expect(jsonl.append({ hypothesisId: 'h-ghost', eventType: 'validated', sourceType: 'experiment', sourceId: 'ghost:1' }).appended).toBe(true)

      // ── 单向 ingest：JSONL → 权威 SQLite（幂等 + 隔离） ──
      const target = new DrizzleFeedbackEventStore()
      const hypothesisExists = (id: string) => !!ideaStore.getHypothesisById(id)
      const first = ingestFeedbackEvents(jsonl, target, { hypothesisExists })
      expect(first.ingested).toBe(2)
      expect(first.deduped).toBe(0)
      expect(first.quarantined).toHaveLength(1)
      expect(first.quarantined[0].reason).toBe('unknown_hypothesis')
      expect(formatIngestSummary(first)).toBe('feedback-ingest ingested=2 deduped=0 quarantined=1(unknown_hypothesis:1)')

      // 重复 ingest：同幂等键不增样本
      const second = ingestFeedbackEvents(jsonl, target, { hypothesisExists })
      expect(second.ingested).toBe(0)
      expect(second.deduped).toBe(2)
      expect(target.count()).toBe(2)

      // ── 快照：h1 有 provenance → pair 归因；h2 无 → hypothesis_only ──
      const service = new FeedbackLearningService({ now: 2_000 })
      const snapshot = service.buildSnapshot()
      // 幽灵事件已隔离，权威侧只有 2 条
      expect(snapshot.eventCount).toBe(2)
      const pair = snapshot.pairs.find((p) => p.pairKey === 'memory:a|memory:b')
      expect(pair?.attribution).toBe('pair')
      expect(pair?.quality.evidenceCount).toBe(1)
      expect(snapshot.pairs.some((p) => p.pairKey === 'hypothesis:h2' && p.attribution === 'hypothesis_only')).toBe(true)
      // 正向事件 2 条（h1 validated + h2 adopted），仅 h1 可归因 → 覆盖率 0.5
      expect(snapshot.attributionCoverage).toBeCloseTo(0.5)
      expect(snapshot.duplicateApplicationRate).toBe(0)

      // ── 提示块：只带 pair 归因，hypothesis_only 不进提示 ──
      const block = buildFeedbackPromptBlock(snapshot)
      expect(block.verified.length).toBeGreaterThan(0)
      expect(block.verified.every((v) => v.pairKey.startsWith('hypothesis:'))).toBe(false)
      const section = buildFeedbackBlockSection(block)
      expect(section).toContain('历史反馈')

      // ── mixer 输入有界（λ clamp 兜底） ──
      const mixerInput = buildMixerInputFromSnapshot(snapshot)
      const adjustment = mixerInput.pairAdjustments['memory:a|memory:b']
      expect(adjustment).toBeDefined()
      expect(Math.abs(adjustment!)).toBeLessThanOrEqual(mixerInput.maxAdjustment)

      // ── 回放报告不变量（调整方向依赖先验语义，这里只钉有界与可追溯） ──
      const replay = service.replay({ 'memory:a|memory:b': 60 })
      expect(replay.duplicateApplicationRate).toBe(0)
      expect(replay.traceableEvidenceCount).toBeGreaterThan(0)
      expect(replay.comparisons).toHaveLength(1)
      expect(Math.abs(replay.comparisons[0].clampedAdjustment)).toBeLessThanOrEqual(0.1)
    } finally {
      rmSync(jsonlDir, { recursive: true, force: true })
      restore()
    }
  })

  it('缺失列时（旧库未迁移）读侧不炸：provenance 视为缺失走 hypothesis_only', async () => {
    const restore = useIsolatedTestDatabase()
    try {
      await initDatabase()
      const ideaStore = new DrizzleIdeaStore()
      ideaStore.addHypothesis(baseHypothesis({ id: 'h-no-prov' }))
      // 直接构造无 provenance 的事件，快照仍可计算，只是不归因到对
      const jsonl = new JsonlFeedbackEventStore(mkdtempSync(join(tmpdir(), 'feedback-e2e-nop-')))
      jsonl.append({ hypothesisId: 'h-no-prov', eventType: 'validated', sourceType: 'experiment', sourceId: 's1' })
      const target = new DrizzleFeedbackEventStore()
      ingestFeedbackEvents(jsonl, target, { hypothesisExists: (id) => !!ideaStore.getHypothesisById(id) })

      const service = new FeedbackLearningService({ now: 2_000 })
      const snapshot = service.buildSnapshot()
      expect(snapshot.eventCount).toBe(1)
      expect(snapshot.pairs[0].attribution).toBe('hypothesis_only')
      expect(snapshot.attributionCoverage).toBe(0)
    } finally {
      restore()
    }
  })
})
