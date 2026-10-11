import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { IdeaStore } from '@akemi-mio/creativity/IdeaStore'
import type { Hypothesis } from '@akemi-mio/creativity/types'

/**
 * P1 迁移钉（照抄 2261a5f4 钉法）：
 * - 旧记录（status=experimenting、无 proposedRelations 等新字段）反序列化不炸；
 *   status 归一为 testing；新字段缺省不出现（旧形状字节语义保持）。
 * - idea.generate 产生的普通 Hypothesis（不带 proposedRelations）路径形状不变。
 */

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

describe('P1 Hypothesis migration pin (experimenting→testing + optional mechanism fields)', () => {
  it('deserializes a legacy experimenting record without crashing and normalizes status to testing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'idea-store-p1-'))
    try {
      const filePath = join(dir, 'creativity.json')
      const legacy = {
        version: 2,
        combos: [],
        hypotheses: [
          {
            id: 'legacy-1',
            title: '旧实验',
            idea: '旧内容',
            expectedBenefit: 'b',
            risk: 'r',
            sourceLabels: ['t'],
            novelty: 60,
            feasibility: 60,
            impact: 60,
            status: 'experimenting',
            createdAt: 1,
          },
        ],
        experiments: [],
        dreamCycles: [],
        exploredPairs: [],
      }
      writeFileSync(filePath, JSON.stringify(legacy), 'utf-8')
      const store = new IdeaStore(filePath)
      const hs = store.getHypotheses()
      expect(hs).toHaveLength(1)
      expect(hs[0].status).toBe('testing')
      expect(hs[0].proposedRelations).toBeUndefined()
      expect(hs[0].falsificationConditions).toBeUndefined()
      expect(hs[0].sourceObservationIds).toBeUndefined()
      // 旧字段键序与内容语义未被新增字段污染
      expect(Object.keys(hs[0])).toEqual(
        expect.arrayContaining([
          'id',
          'title',
          'idea',
          'expectedBenefit',
          'risk',
          'sourceLabels',
          'novelty',
          'feasibility',
          'impact',
          'status',
          'createdAt',
        ]),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ordinary hypothesis (no proposedRelations) keeps legacy shape after save/reload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'idea-store-p1-shape-'))
    try {
      const filePath = join(dir, 'creativity.json')
      const store = new IdeaStore(filePath)
      store.addHypothesis(makeHyp({ id: 'plain', status: 'draft' }))
      const reloaded = new IdeaStore(filePath).getHypotheses()[0]
      expect(reloaded.proposedRelations).toBeUndefined()
      expect(reloaded.falsificationConditions).toBeUndefined()
      expect(reloaded.sourceObservationIds).toBeUndefined()
      expect(reloaded.status).toBe('draft')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('mechanism hypothesis keeps proposedRelations through save/reload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'idea-store-p1-mech-'))
    try {
      const filePath = join(dir, 'creativity.json')
      const store = new IdeaStore(filePath)
      store.addHypothesis(
        makeHyp({
          id: 'mech-1',
          status: 'active',
          proposedRelations: [{ from: 'reading', to: 'summary.quality', effect: 'improves', inference: 'identity' }],
          falsificationConditions: ['summary ROUGE 不升反降'],
          sourceObservationIds: ['obs_1', 'obs_2'],
        }),
      )
      const reloaded = new IdeaStore(filePath).getHypotheses()[0]
      expect(reloaded.proposedRelations).toEqual([{ from: 'reading', to: 'summary.quality', effect: 'improves', inference: 'identity' }])
      expect(reloaded.falsificationConditions).toEqual(['summary ROUGE 不升反降'])
      expect(reloaded.sourceObservationIds).toEqual(['obs_1', 'obs_2'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
