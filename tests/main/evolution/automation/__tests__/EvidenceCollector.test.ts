/**
 * EvidenceCollector Contract Tests — Phase 1
 *
 * 验证 EvidenceCollector 作为纯转换层的正确性：
 *   RegressionReport → Problem[]
 *
 * 不验证：
 *   - EventBridge 接线
 *   - SelfEvolutionService 触发
 *   - ProblemQueue 集成
 *
 * 覆盖场景：
 *   | 场景                                     | 期望                    |
 *   | ---------------------------------------- | ----------------------- |
 *   | 无 regression                            | 空 Problem[]            |
 *   | passRate < 0.5                           | error Problem           |
 *   | passRate 0.5~0.8                         | warning Problem         |
 *   | 单 capability regression                 | 一个 Problem            |
 *   | 多 capability regression                 | 多 Problem              |
 *   | 混合：低 passRate + 能力退化             | 两者共存                |
 *   | duplicate report                         | 去重返回空              |
 *   | 置信度不足（太少样本）                   | 跳过                    |
 *   | evidenceRef 格式                         | report_{executedAt}_{sha} |
 *   | confidence 映射                          | 按失败率计算，上限 0.95 |
 */
import { describe, it, expect } from 'vitest'
import { EvidenceCollector } from '@akemi-mio/evolution/automation/EvidenceCollector'
import type { RegressionReport } from '@akemi-mio/reasoning/golden/types'

// =============================================================================
// 每个测试使用独立的 collector 实例 +  唯一的 metadata，
// 避免跨测试去重干扰。
// =============================================================================

/** 计时器生成唯一的 executedAt，确保跨测试唯一 */
let counter = 0
function nextSec(): string {
  counter++
  const h = String(19 + Math.floor(counter / 60)).padStart(2, '0')
  const m = String(counter % 60).padStart(2, '0')
  return `2026-07-21T${h}:${m}:00.000Z`
}

function mockReport(overrides?: Partial<RegressionReport> & { _unique?: string }): RegressionReport {
  const u = overrides?._unique || 'a06e7ff'
  return {
    reportSchemaVersion: '0.1',
    summary: { total: 44, passed: 44, failed: 0, skipped: 0, durationMs: 1500, passRate: 1.0, status: 'pass' },
    capability: { regressed: [], intact: ['cause_effect', 'hypothesis_verification'] },
    regression: { count: 0, entries: [] },
    evidence: { entries: [] },
    trend: null,
    metadata: {
      runnerVersion: '0.1',
      reportSchemaVersion: '0.1',
      goldenVersion: '0.1',
      goldenSchemaVersion: '0.1',
      datasetInfo: { totalCases: 44, categories: { analysis: 44, decision: 0, planning: 0, creation: 0 } },
      commit: { sha: u, branch: 'feat/evaluation-bridge', dirty: false },
      executedAt: nextSec(),
    },
    ...overrides,
  }
}

// =============================================================================
// 1. 边界条件
// =============================================================================
describe('EvidenceCollector — 边界条件', () => {
  it('无 regression 时返回空数组', () => {
    const c = new EvidenceCollector()
    expect(c.convert(mockReport())).toEqual([])
  })

  it('collect() 无 report 时返回空数组', async () => {
    const c = new EvidenceCollector()
    expect(await c.collect()).toEqual([])
  })

  it('shouldRun() 返回 false', () => {
    expect(new EvidenceCollector().shouldRun()).toBe(false)
  })

  it('name 和 source 正确', () => {
    const c = new EvidenceCollector()
    expect(c.name).toBe('evidence-collector')
    expect(c.source).toBe('evidence')
  })
})

// =============================================================================
// 2. passRate → severity 映射
// =============================================================================
describe('EvidenceCollector — severity 映射', () => {
  it('passRate = 1.0 不产生 Problem', () => {
    const c = new EvidenceCollector()
    expect(
      c.convert(mockReport({ summary: { total: 44, passed: 44, failed: 0, skipped: 0, durationMs: 1500, passRate: 1.0, status: 'pass' } })),
    ).toHaveLength(0)
  })

  it('passRate = 0.9（>= 0.8）不产生 Problem', () => {
    const c = new EvidenceCollector()
    expect(
      c.convert(mockReport({ summary: { total: 44, passed: 40, failed: 4, skipped: 0, durationMs: 1500, passRate: 0.9, status: 'pass' } })),
    ).toHaveLength(0)
  })

  it('passRate = 0.68（< 0.8）产生 warning Problem', () => {
    const c = new EvidenceCollector()
    const problems = c.convert(
      mockReport({ summary: { total: 44, passed: 30, failed: 14, skipped: 0, durationMs: 1500, passRate: 0.68, status: 'fail' } }),
    )
    expect(problems.length).toBeGreaterThanOrEqual(1)
    expect(problems.some((p) => p.severity === 'warning')).toBe(true)
  })

  it('passRate = 0.45（< 0.5）产生 error Problem', () => {
    const c = new EvidenceCollector()
    const problems = c.convert(
      mockReport({ summary: { total: 44, passed: 20, failed: 24, skipped: 0, durationMs: 1500, passRate: 0.45, status: 'fail' } }),
    )
    expect(problems.length).toBeGreaterThanOrEqual(1)
    expect(problems.some((p) => p.severity === 'error')).toBe(true)
  })
})

// =============================================================================
// 3. 能力退化映射
// =============================================================================
describe('EvidenceCollector — 能力退化映射', () => {
  it('单 capability regression 产生一个 Problem', () => {
    const c = new EvidenceCollector()
    const problems = c.convert(
      mockReport({
        summary: { total: 44, passed: 40, failed: 4, skipped: 0, durationMs: 1500, passRate: 0.9, status: 'pass' },
        capability: {
          regressed: [{ capability: 'tool.execution', failedCount: 3, totalCount: 10, affectedCaseIds: ['T01', 'T02', 'T03'] }],
          intact: ['cause_effect'],
        },
      }),
    )
    expect(problems).toHaveLength(1)
    expect(problems[0].affectedCapability).toBe('tool.execution')
    expect(problems[0].evidenceType).toBe('capability_regression')
    expect(problems[0].severity).toBe('warning')
  })

  it('多 regression 产生多个 Problem', () => {
    const c = new EvidenceCollector()
    const problems = c.convert(
      mockReport({
        summary: { total: 44, passed: 38, failed: 6, skipped: 0, durationMs: 1500, passRate: 0.86, status: 'pass' },
        capability: {
          regressed: [
            { capability: 'tool.execution', failedCount: 7, totalCount: 10, affectedCaseIds: ['T01', 'T02'] },
            { capability: 'cause_effect', failedCount: 5, totalCount: 8, affectedCaseIds: ['Q01'] },
            { capability: 'planning.decomposition', failedCount: 3, totalCount: 5, affectedCaseIds: ['P01'] },
          ],
          intact: [],
        },
      }),
    )
    expect(problems).toHaveLength(3)
    expect(problems.map((p) => p.affectedCapability)).toEqual(
      expect.arrayContaining(['tool.execution', 'cause_effect', 'planning.decomposition']),
    )
  })

  it('混合：低 passRate + 能力退化 = 两者共存', () => {
    const c = new EvidenceCollector()
    const problems = c.convert(
      mockReport({
        summary: { total: 44, passed: 30, failed: 14, skipped: 0, durationMs: 1500, passRate: 0.68, status: 'fail' },
        capability: {
          regressed: [{ capability: 'tool.execution', failedCount: 5, totalCount: 10, affectedCaseIds: ['T01'] }],
          intact: ['cause_effect'],
        },
      }),
    )
    expect(problems.length).toBeGreaterThanOrEqual(2)
    expect(problems.some((p) => p.severity === 'warning' && !p.affectedCapability)).toBe(true)
    expect(problems.some((p) => p.affectedCapability === 'tool.execution')).toBe(true)
  })
})

// =============================================================================
// 4. 去重和置信度
// =============================================================================
describe('EvidenceCollector — 去重 & 置信度', () => {
  it('相同 report 连续调用返回空（跨 tick 去重）', () => {
    const c = new EvidenceCollector()
    const r = mockReport({ summary: { total: 44, passed: 20, failed: 24, skipped: 0, durationMs: 1500, passRate: 0.45, status: 'fail' } })
    expect(c.convert(r).length).toBeGreaterThan(0)
    expect(c.convert(r)).toHaveLength(0)
  })

  it('不同 report（不同 sha）不触发去重', () => {
    const c = new EvidenceCollector()
    const r1 = mockReport({
      _unique: 'abc123',
      summary: { total: 44, passed: 20, failed: 24, skipped: 0, durationMs: 1500, passRate: 0.45, status: 'fail' },
    })
    const r2 = mockReport({
      _unique: 'def456',
      summary: { total: 44, passed: 20, failed: 24, skipped: 0, durationMs: 1500, passRate: 0.45, status: 'fail' },
    })
    expect(c.convert(r1).length).toBeGreaterThan(0)
    expect(c.convert(r2).length).toBeGreaterThan(0)
  })

  it('置信度不足时跳过（太少样本）', () => {
    const c = new EvidenceCollector()
    const problems = c.convert(
      mockReport({
        capability: { regressed: [{ capability: 'rare.pattern', failedCount: 1, totalCount: 1, affectedCaseIds: ['R01'] }], intact: [] },
      }),
    )
    expect(problems).toHaveLength(0)
  })

  it('适量样本产生合理置信度', () => {
    const c = new EvidenceCollector()
    const problems = c.convert(
      mockReport({
        capability: {
          regressed: [{ capability: 'tool.execution', failedCount: 5, totalCount: 10, affectedCaseIds: ['T01', 'T02'] }],
          intact: [],
        },
      }),
    )
    expect(problems).toHaveLength(1)
    expect(problems[0].confidence).toBe(0.5)
  })

  it('confidence 上限 0.95', () => {
    const c = new EvidenceCollector()
    const problems = c.convert(
      mockReport({
        capability: {
          regressed: [
            {
              capability: 'tool.execution',
              failedCount: 20,
              totalCount: 20,
              affectedCaseIds: Array.from({ length: 20 }, (_, i) => `T${i}`),
            },
          ],
          intact: [],
        },
      }),
    )
    expect(problems).toHaveLength(1)
    expect(problems[0].confidence).toBe(0.95)
  })
})

// =============================================================================
// 5. 字段格式验证
// =============================================================================
describe('EvidenceCollector — 字段格式', () => {
  it('source 为 evidence', () => {
    const c = new EvidenceCollector()
    const problems = c.convert(
      mockReport({ summary: { total: 44, passed: 20, failed: 24, skipped: 0, durationMs: 1500, passRate: 0.45, status: 'fail' } }),
    )
    expect(problems[0].source).toBe('evidence')
  })

  it('evidenceRef 格式为 report_{executedAt}_{sha}', () => {
    const c = new EvidenceCollector()
    const problems = c.convert(
      mockReport({ summary: { total: 44, passed: 20, failed: 24, skipped: 0, durationMs: 1500, passRate: 0.45, status: 'fail' } }),
    )
    expect(problems[0].evidenceRef).toMatch(/^report_\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z_[a-f0-9]+$/)
  })

  it('estimatedCostChars 为 0', () => {
    const c = new EvidenceCollector()
    const problems = c.convert(
      mockReport({ summary: { total: 44, passed: 20, failed: 24, skipped: 0, durationMs: 1500, passRate: 0.45, status: 'fail' } }),
    )
    expect(problems[0].estimatedCostChars).toBe(0)
  })

  it('affectedCapability 出现在 capability regression 中', () => {
    const c = new EvidenceCollector()
    const problems = c.convert(
      mockReport({
        capability: { regressed: [{ capability: 'cause_effect', failedCount: 5, totalCount: 10, affectedCaseIds: ['Q01'] }], intact: [] },
      }),
    )
    expect(problems[0].affectedCapability).toBe('cause_effect')
  })

  it('passRate 下降 Problem 不设 affectedCapability', () => {
    const c = new EvidenceCollector()
    const problems = c.convert(
      mockReport({ summary: { total: 44, passed: 20, failed: 24, skipped: 0, durationMs: 1500, passRate: 0.45, status: 'fail' } }),
    )
    const passRateProblems = problems.filter((p) => p.evidenceType === 'critical_regression')
    expect(passRateProblems.length).toBeGreaterThanOrEqual(1)
    for (const p of passRateProblems) {
      expect(p.affectedCapability).toBeUndefined()
    }
  })

  it('Problem.id 包含 capability 名称', () => {
    const c = new EvidenceCollector()
    const problems = c.convert(
      mockReport({
        capability: { regressed: [{ capability: 'tool.execution', failedCount: 5, totalCount: 10, affectedCaseIds: ['T01'] }], intact: [] },
      }),
    )
    expect(problems[0].id).toContain('tool.execution')
  })
})

// =============================================================================
// 6. 幂等性：相同输入产生相同输出
// =============================================================================
describe('EvidenceCollector — 幂等性', () => {
  it('不同实例对相同 report 产生相同内容', () => {
    const cA = new EvidenceCollector()
    const cB = new EvidenceCollector()
    const report = mockReport({
      summary: { total: 44, passed: 30, failed: 14, skipped: 0, durationMs: 1500, passRate: 0.68, status: 'fail' },
      capability: { regressed: [{ capability: 'cause_effect', failedCount: 5, totalCount: 10, affectedCaseIds: ['Q01'] }], intact: [] },
    })
    const a = cA.convert(report)
    const b = cB.convert(report)
    expect(a.length).toBeGreaterThan(0)
    expect(a.length).toBe(b.length)
    for (let i = 0; i < a.length; i++) {
      expect(a[i].source).toBe(b[i].source)
      expect(a[i].severity).toBe(b[i].severity)
      expect(a[i].title).toBe(b[i].title)
      expect(a[i].confidence).toBe(b[i].confidence)
    }
  })
})
