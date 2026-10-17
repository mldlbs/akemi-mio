import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  FEEDBACK_EVENT_SCHEMA_VERSION,
  buildFeedbackIdempotencyKey,
  normalizeFeedbackEvent,
  feedbackEvidenceDimension,
} from '@akemi-mio/creativity/FeedbackEvents'
import { JsonlFeedbackEventStore } from '@akemi-mio/creativity/JsonlFeedbackEventStore'
import { ingestFeedbackEvents, formatIngestSummary } from '@akemi-mio/creativity/ingestFeedbackEvents'

/**
 * 正向反馈闭环 P0 钉（设计 2026-10-17-creativity-positive-feedback-loop）：
 * - 规范化拒绝不合格事件（隔离，不生效）；implemented 缺 commitSha 必须拦
 * - idempotencyKey 确定性 → 重复追加/导入不增样本
 * - 证据维度分离：adopted=selection, validated=quality, implemented=landing, rejected=负向
 * - ingest 单向：未知 hypothesisId 进隔离；JSONL 损坏行不参与幂等集合
 */

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('normalizeFeedbackEvent', () => {
  const now = 1_700_000_000_000

  it('accepts a valid validated event and fills id/idempotencyKey/schemaVersion', () => {
    const r = normalizeFeedbackEvent(
      { hypothesisId: 'h-1', eventType: 'validated', sourceType: 'experiment', sourceId: 'ferment:h-1:3' },
      now,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.event.hypothesisId).toBe('h-1')
    expect(r.event.eventType).toBe('validated')
    expect(r.event.occurredAt).toBe(now)
    expect(r.event.ingestedAt).toBe(now)
    expect(r.event.schemaVersion).toBe(FEEDBACK_EVENT_SCHEMA_VERSION)
    expect(r.event.idempotencyKey).toBe('h-1:validated:experiment:ferment:h-1:3::')
    expect(r.event.id).toMatch(/^fbe_/)
  })

  it('parses ISO occurredAt strings', () => {
    const r = normalizeFeedbackEvent(
      {
        hypothesisId: 'h-1',
        eventType: 'adopted',
        sourceType: 'adoption',
        sourceId: 'adopt:h-1:1',
        occurredAt: '2026-10-17T00:00:00.000Z',
      },
      now,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.event.occurredAt).toBe(Date.parse('2026-10-17T00:00:00.000Z'))
  })

  it('quarantines implemented without commitSha (R1: 无关联 commit 的落地证据不生效)', () => {
    const r = normalizeFeedbackEvent(
      { hypothesisId: 'h-1', eventType: 'implemented', sourceType: 'commit', sourceId: 'deliver:p1' },
      now,
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('missing_commit_sha_for_implemented')
  })

  it('accepts implemented with commitSha', () => {
    const r = normalizeFeedbackEvent(
      {
        hypothesisId: 'h-1',
        eventType: 'implemented',
        sourceType: 'commit',
        sourceId: 'deliver:p1',
        commitSha: 'abc123',
      },
      now,
    )
    expect(r.ok).toBe(true)
  })

  it('quarantines missing hypothesisId / invalid eventType / invalid sourceType', () => {
    expect(normalizeFeedbackEvent({ eventType: 'validated', sourceType: 'experiment', sourceId: 'x' }, now)).toMatchObject({
      ok: false,
      reason: 'missing_hypothesis_id',
    })
    expect(
      normalizeFeedbackEvent({ hypothesisId: 'h', eventType: 'promoted', sourceType: 'experiment', sourceId: 'x' }, now),
    ).toMatchObject({ ok: false, reason: 'invalid_event_type' })
    expect(
      normalizeFeedbackEvent({ hypothesisId: 'h', eventType: 'validated', sourceType: 'trace', sourceId: 'x' }, now),
    ).toMatchObject({ ok: false, reason: 'invalid_source_type' })
    expect(normalizeFeedbackEvent({ hypothesisId: 'h', eventType: 'validated', sourceType: 'experiment', sourceId: '' }, now)).toMatchObject({
      ok: false,
      reason: 'missing_source_id',
    })
  })

  it('builds deterministic idempotency keys (replay-safe)', () => {
    const a = buildFeedbackIdempotencyKey({ hypothesisId: 'h', eventType: 'validated', sourceType: 'experiment', sourceId: 's1' })
    const b = buildFeedbackIdempotencyKey({ hypothesisId: 'h', eventType: 'validated', sourceType: 'experiment', sourceId: 's1' })
    const c = buildFeedbackIdempotencyKey({ hypothesisId: 'h', eventType: 'validated', sourceType: 'experiment', sourceId: 's2' })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('feedbackEvidenceDimension', () => {
  it('separates selection / quality / landing / negative (原则 1：成功不等于正确)', () => {
    expect(feedbackEvidenceDimension('adopted')).toBe('selection')
    expect(feedbackEvidenceDimension('validated')).toBe('quality')
    expect(feedbackEvidenceDimension('implemented')).toBe('landing')
    expect(feedbackEvidenceDimension('rejected')).toBe('negative')
    expect(feedbackEvidenceDimension('regression_failed')).toBe('negative')
  })
})

describe('JsonlFeedbackEventStore', () => {
  it('appends, dedups by idempotencyKey, and quarantines invalid input', () => {
    const dir = tmpDir('fbe-jsonl-')
    try {
      const store = new JsonlFeedbackEventStore(dir)
      const input = { hypothesisId: 'h-1', eventType: 'validated' as const, sourceType: 'experiment' as const, sourceId: 'ferment:h-1:1' }
      const first = store.append(input)
      expect(first.appended).toBe(true)
      expect(first.deduped).toBe(false)

      const second = store.append(input)
      expect(second.appended).toBe(false)
      expect(second.deduped).toBe(true)

      const bad = store.append({ hypothesisId: '', eventType: 'validated', sourceType: 'experiment', sourceId: 'x' } as any)
      expect(bad.appended).toBe(false)
      expect(bad.quarantine?.reason).toBe('missing_hypothesis_id')

      const rows = store.list()
      expect(rows).toHaveLength(1)
      expect(existsSync(store.eventsPath)).toBe(true)
      const rawLines = readFileSync(store.eventsPath, 'utf-8').trim().split('\n')
      expect(rawLines).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('survives corrupt trailing lines when listing', () => {
    const dir = tmpDir('fbe-jsonl-corrupt-')
    try {
      const store = new JsonlFeedbackEventStore(dir)
      store.append({ hypothesisId: 'h-1', eventType: 'rejected' as const, sourceType: 'experiment' as const, sourceId: 'ferment:h-1:2' })
      require('fs').appendFileSync(store.eventsPath, '{corrupt\n')
      store.invalidate()
      expect(store.list()).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('ingestFeedbackEvents (CLI JSONL → 权威侧单向导入)', () => {
  it('ingests new events, dedups repeats, quarantines unknown hypotheses and corrupt rows', () => {
    const dir = tmpDir('fbe-ingest-')
    try {
      const jsonl = new JsonlFeedbackEventStore(dir)
      jsonl.append({ hypothesisId: 'h-known', eventType: 'validated' as const, sourceType: 'experiment' as const, sourceId: 'ferment:h-known:1' })
      jsonl.append({ hypothesisId: 'h-ghost', eventType: 'validated' as const, sourceType: 'experiment' as const, sourceId: 'ferment:h-ghost:1' })
      jsonl.append({ hypothesisId: 'h-known', eventType: 'implemented' as const, sourceType: 'commit' as const, sourceId: 'deliver:p', commitSha: 'sha1' })
      // 手动塞一条损坏行
      require('fs').appendFileSync(jsonl.eventsPath, 'not-json\n')

      // 假权威侧（内存实现，不依赖 SQLite）
      const authoritative = new Map<string, any>()
      const target = {
        hasKey: (k: string) => authoritative.has(k),
        append: (e: any) => {
          if (authoritative.has(e.idempotencyKey)) return { appended: false, deduped: true }
          authoritative.set(e.idempotencyKey, e)
          return { appended: true, deduped: false }
        },
      }

      const result = ingestFeedbackEvents(jsonl, target, {
        hypothesisExists: (id) => id === 'h-known',
      })
      expect(result.ingested).toBe(2)
      expect(result.deduped).toBe(0)
      expect(result.quarantined).toHaveLength(1)
      expect(result.quarantined[0].reason).toBe('unknown_hypothesis')

      // 重放同一 JSONL → 全部 dedup，不增样本
      const replay = ingestFeedbackEvents(jsonl, target, { hypothesisExists: (id) => id === 'h-known' })
      expect(replay.ingested).toBe(0)
      expect(replay.deduped).toBe(2)
      expect(authoritative.size).toBe(2)

      // 三维度证据各自独立累计（不合并成"成功次数"）
      const events = [...authoritative.values()]
      expect(events.map((e) => e.eventType).sort()).toEqual(['implemented', 'validated'])
      expect(events.every((e) => e.schemaVersion === FEEDBACK_EVENT_SCHEMA_VERSION)).toBe(true)

      // 评审 a4：隔离可观测——调用方拿到的摘要必须显式包含 quarantined 与原因
      const summary = formatIngestSummary(result)
      expect(summary).toContain('quarantined=1')
      expect(summary).toContain('unknown_hypothesis:1')
      expect(summary).toContain('ingested=2')
      expect(summary).toContain('deduped=0')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
