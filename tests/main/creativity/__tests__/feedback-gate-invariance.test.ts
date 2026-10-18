import { describe, expect, it } from 'vitest'
import { checkPromotionGate, type ExperimentRun, type StoppingRuleConfig } from '@akemi-mio/creativity/ExperimentRunStore'
import { checkSubmitGate } from '@akemi-mio/creativity/MechanismRegistry'

// spec 十.5 门控不变性：反馈只影响生成，永不进 checkPromotionGate/checkSubmitGate。
// 同一批 runs，带/不带 feedbackSnapshotVersion 的门控结果必须逐字段一致——
// 哪怕 version 与任何快照都不匹配，晋级/提交门也不得因此改变判决。

function makeRun(overrides: Partial<ExperimentRun> = {}): ExperimentRun {
  return {
    id: `run-${Math.random().toString(36).slice(2)}`,
    mechanismId: 'mech-1',
    baseSnapshotId: 'snap_a',
    mode: 'baseline',
    sampleCount: 10,
    createdAt: Date.now(),
    ...overrides,
  }
}

const config: StoppingRuleConfig = { minSamples: 5 }

describe('Feedback loop gate invariance (spec 十.5)', () => {
  const scenarios: Array<{ name: string; runs: () => ExperimentRun[]; currentSnapshotId?: string }> = [
    { name: 'n < minSamples → deny', runs: () => [makeRun(), makeRun()] },
    { name: 'stale run → deny', runs: () => Array.from({ length: 5 }, () => makeRun({ stale: true })) },
    {
      name: 'snapshot mismatch → deny',
      runs: () => Array.from({ length: 5 }, () => makeRun({ baseSnapshotId: 'snap_old' })),
      currentSnapshotId: 'snap_current',
    },
    { name: 'all match + n >= minSamples → allow', runs: () => Array.from({ length: 5 }, () => makeRun({ baseSnapshotId: 'snap_a' })), currentSnapshotId: 'snap_a' },
  ]

  for (const scenario of scenarios) {
    it(`promotion gate: ${scenario.name} — feedbackSnapshotVersion never changes the verdict`, () => {
      const plain = checkPromotionGate(config, scenario.runs(), scenario.currentSnapshotId)
      const withFeedback = checkPromotionGate(
        config,
        scenario.runs().map((r) => ({ ...r, feedbackSnapshotVersion: 'fb-poisoned-version' })),
        scenario.currentSnapshotId,
      )
      expect(withFeedback).toEqual(plain)
    })

    it(`submit gate: ${scenario.name} — feedbackSnapshotVersion never changes the verdict`, () => {
      const plain = checkSubmitGate(config, scenario.runs(), scenario.currentSnapshotId)
      const withFeedback = checkSubmitGate(
        config,
        scenario.runs().map((r) => ({ ...r, feedbackSnapshotVersion: 'fb-poisoned-version' })),
        scenario.currentSnapshotId,
      )
      expect(withFeedback).toEqual(plain)
    })
  }

  it('a batch whose only difference is feedbackSnapshotVersion still passes both gates identically', () => {
    const runs = Array.from({ length: 6 }, () => makeRun({ baseSnapshotId: 'snap_a' }))
    const variants = [
      runs,
      runs.map((r) => ({ ...r, feedbackSnapshotVersion: 'fb-v1' })),
      runs.map((r) => ({ ...r, feedbackSnapshotVersion: 'fb-v2-mismatched' })),
    ]
    const promotion = variants.map((v) => checkPromotionGate(config, v, 'snap_a'))
    const submit = variants.map((v) => checkSubmitGate(config, v, 'snap_a'))
    for (const gate of promotion) expect(gate).toEqual(promotion[0])
    for (const gate of submit) expect(gate).toEqual(submit[0])
    expect(promotion[0]).toEqual({ allowed: true, reason: 'ok' })
    expect(submit[0]).toEqual({ allowed: true, reason: 'ok' })
  })
})
