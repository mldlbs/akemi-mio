import { describe, it, expect } from 'vitest'
import {
  buildFeedbackPromptBlock,
  buildMixerInputFromSnapshot,
  buildFeedbackSnapshot,
  DEFAULT_FEEDBACK_LEARNING_CONFIG,
  type FeedbackSnapshot,
  type HypothesisProvenanceLike,
} from '@akemi-mio/creativity/FeedbackLearning'
import { buildCreativityPrompt } from '@akemi-mio/creativity/CreativityPrompt'
import { HypothesisGenerator } from '@akemi-mio/creativity/HypothesisGenerator'
import type { HypothesisFeedbackEvent } from '@akemi-mio/creativity/FeedbackEvents'
import type { CreativitySource, ConceptCombo } from '@akemi-mio/creativity/types'

const NOW = 1_800_000_000_000

function event(over: Partial<HypothesisFeedbackEvent> & Pick<HypothesisFeedbackEvent, 'hypothesisId' | 'eventType'>): HypothesisFeedbackEvent {
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

function source(over: Partial<CreativitySource> & { name: string }): CreativitySource {
  return { content: 'c', type: 'knowledge', weight: 1, ...over }
}

describe('buildFeedbackPromptBlock (P2 structured snapshot block)', () => {
  const snapshot: FeedbackSnapshot = buildFeedbackSnapshot(
    [
      event({ hypothesisId: 'h1', eventType: 'validated', sourceId: 's1', occurredAt: NOW }),
      event({ hypothesisId: 'h1', eventType: 'adopted', sourceId: 's2', occurredAt: NOW }),
      event({ hypothesisId: 'h2', eventType: 'rejected', sourceId: 's3', occurredAt: NOW }),
    ],
    {
      h1: { sources: [{ name: 'A', origin: 'memory:a' }, { name: 'B', origin: 'memory:b' }] },
      h2: { sources: [{ name: 'C', origin: 'memory:c' }, { name: 'D', origin: 'memory:d' }] },
    },
    undefined,
    NOW,
  )

  it('stamps the snapshot version and separates verified/failures', () => {
    const block = buildFeedbackPromptBlock(snapshot)
    expect(block.version).toBe(snapshot.version)
    expect(block.verified.length).toBeGreaterThan(0)
    expect(block.failures.length).toBe(1)
    expect(block.failures[0].conceptA).toBe('memory:c')
  })

  it('carries only structured fields — no raw event text or free-form origin body', () => {
    const block = buildFeedbackPromptBlock(snapshot)
    for (const v of block.verified) {
      expect(v.conceptA).not.toContain(' ')
      expect(v.scope).toMatch(/批次|任务类别/)
      expect(v.limits).toContain('泛化')
      expect(v.evidenceCount).toBeGreaterThan(0)
    }
  })
})

describe('buildCreativityPrompt feedback injection', () => {
  const sources = [source({ name: 'A', origin: 'memory:a' }), source({ name: 'B', origin: 'memory:b' })]
  const combos: ConceptCombo[] = [{ id: 'combo_1', sources: ['A', 'B'], description: 'd', createdAt: NOW }]

  it('default (no feedback) is byte-identical to explicit undefined', () => {
    expect(buildCreativityPrompt(sources, combos, [])).toBe(buildCreativityPrompt(sources, combos, [], undefined))
  })

  it('injects a structured feedback section and never raw event text', () => {
    const snapshot = buildFeedbackSnapshot(
      [event({ hypothesisId: 'h1', eventType: 'validated', sourceId: 's1', occurredAt: NOW })],
      { h1: { sources: [{ name: 'A', origin: 'memory:a' }, { name: 'B', origin: 'memory:b' }] } },
      undefined,
      NOW,
    )
    const block = buildFeedbackPromptBlock(snapshot)
    const prompt = buildCreativityPrompt(sources, combos, [], block)
    expect(prompt).toContain('历史反馈')
    expect(prompt).toContain(`快照 v${snapshot.version}`)
    expect(prompt).toContain('已验证的来源')
    // raw 事件字段（sourceId/idempotencyKey）不得进 prompt
    expect(prompt).not.toContain('idempotencyKey')
    expect(prompt).not.toContain('s1')
  })
})

describe('buildMixerInputFromSnapshot', () => {
  it('produces λ-bounded adjustments keyed by snapshot pair key', () => {
    const snapshot = buildFeedbackSnapshot(
      [event({ hypothesisId: 'h1', eventType: 'validated', sourceId: 's1', occurredAt: NOW })],
      { h1: { sources: [{ name: 'A', origin: 'memory:a' }, { name: 'B', origin: 'memory:b' }] } },
      undefined,
      NOW,
    )
    const input = buildMixerInputFromSnapshot(snapshot)
    const key = 'memory:a|memory:b'
    expect(Object.keys(input.pairAdjustments)).toContain(key)
    expect(Math.abs(input.pairAdjustments[key])).toBeLessThanOrEqual(DEFAULT_FEEDBACK_LEARNING_CONFIG.lambdaClampPct + 1e-9)
    expect(input.maxAdjustment).toBe(DEFAULT_FEEDBACK_LEARNING_CONFIG.lambdaClampPct)
    expect(input.explorationBudget).toBe(DEFAULT_FEEDBACK_LEARNING_CONFIG.explorationBudget)
  })
})

describe('HypothesisGenerator feedback injection', () => {
  it('passes the structured snapshot block into the prompt', async () => {
    let captured = ''
    const chatJson = async (prompt: string) => {
      captured = prompt
      return {
        data: [
          {
            title: 't',
            idea: 'i'.repeat(40),
            expectedBenefit: 'b',
            risk: 'r',
            sourceLabels: ['A', 'B'],
            novelty: 70,
            feasibility: 70,
            impact: 70,
            relevance: 'r'.repeat(20),
          },
        ],
      }
    }
    const gen = new HypothesisGenerator(chatJson, 1)
    const combos: ConceptCombo[] = [{ id: 'combo_1', sources: ['A', 'B'], description: 'd', createdAt: NOW }]
    const snapshot = buildFeedbackSnapshot(
      [event({ hypothesisId: 'h1', eventType: 'validated', sourceId: 's1', occurredAt: NOW })],
      { h1: { sources: [{ name: 'A', origin: 'memory:a' }, { name: 'B', origin: 'memory:b' }] } },
      undefined,
      NOW,
    )
    const block = buildFeedbackPromptBlock(snapshot)
    await gen.generate(combos, [source({ name: 'A' }), source({ name: 'B' })], false, [], undefined, block)
    expect(captured).toContain('历史反馈')
    expect(captured).not.toContain('idempotencyKey')
  })

  it('omits the feedback section when no snapshot is provided', async () => {
    let captured = ''
    const chatJson = async (prompt: string) => {
      captured = prompt
      return {
        data: [
          {
            title: 't',
            idea: 'i'.repeat(40),
            expectedBenefit: 'b',
            risk: 'r',
            sourceLabels: ['A', 'B'],
            novelty: 70,
            feasibility: 70,
            impact: 70,
            relevance: 'r'.repeat(20),
          },
        ],
      }
    }
    const gen = new HypothesisGenerator(chatJson, 1)
    const combos: ConceptCombo[] = [{ id: 'combo_1', sources: ['A', 'B'], description: 'd', createdAt: NOW }]
    await gen.generate(combos, [source({ name: 'A' }), source({ name: 'B' })])
    expect(captured).not.toContain('历史反馈')
  })
})
