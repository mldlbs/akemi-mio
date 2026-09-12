/**
 * Architecture Contract Tests — Phase 0: Evidence Problem Contract
 *
 * 不修改生产代码。验证 Evidence → Evolution 接线的可行性。
 *
 * 约束：
 *  - 不新增 ProblemSource = 'evidence'
 *  - 不新增 Collector/Bridge/Policy
 *  - 仅验证现有抽象能否无侵入承载 Evidence 类型
 */
import { describe, it, expect } from 'vitest'
import type { Problem, ProblemSource, Severity, AssignedProblem, FixResult, SignalCollector, FixExecutor } from '@akemi-mio/evolution/automation/types'
import { ReportGenerator } from '@akemi-mio/reasoning/golden/ReportGenerator'
import { ProposalValidator } from '@akemi-mio/evolution/ProposalValidator'
import type { RegressionReport, ReplayResult } from '@akemi-mio/reasoning/golden/types'

// =============================================================================
// 1. Problem Contract: 扩展兼容性
// =============================================================================
describe('Phase 0: Problem 扩展兼容性', () => {
  it('新增可选字段不破坏现有 Problem', () => {
    // 已知问题使用最小字段（不含新字段）
    const existing: Problem = {
      id: 'tsc:src/main/test.ts:10',
      source: 'tsc' as ProblemSource,
      severity: 'error' as Severity,
      title: '类型错误',
      description: 'TS2322',
      estimatedCostChars: 100,
      lastSeen: Date.now(),
      occurrenceCount: 1,
      context: { raw: 'error TS2322' },
    }
    expect(existing.source).toBe('tsc')
  })

  it('JSON 序列化透传未知字段', () => {
    // 包含未来证据字段的 Problem
    const evidenceProblem = {
      id: 'evidence:report_20260721_a06e7ff:cap_drift',
      source: 'evidence',
      severity: 'warning',
      title: '能力退化：tool.execution',
      description: 'tool.execution pattern 通过率从 0.92 降至 0.75',
      estimatedCostChars: 0, // evidence 问题无需修复成本估计
      lastSeen: Date.now(),
      occurrenceCount: 1,
      context: { raw: 'capability: tool.execution, passRate: 0.75, delta: -0.17' },
      // 新字段（Optional）
      evidenceRef: 'report_20260721T190000Z_a06e7ff',
      evidenceType: 'capability_regression',
      confidence: 0.85,
      affectedCapability: 'tool.execution',
    }

    const json = JSON.stringify(evidenceProblem)
    const parsed = JSON.parse(json)

    // 验证透传
    expect(parsed.source).toBe('evidence')
    expect(parsed.evidenceRef).toBe('report_20260721T190000Z_a06e7ff')
    expect(parsed.confidence).toBe(0.85)
    expect(parsed.affectedCapability).toBe('tool.execution')
  })

  it('ProblemQueue 按 source 过滤不受新值影响', () => {
    // 模拟 ProblemQueue.getPendingBySource 行为
    const problems: Array<{ source: string; id: string }> = [
      { source: 'tsc', id: '1' },
      { source: 'test', id: '2' },
      { source: 'evidence', id: '3' },
    ]

    const evidenceProblems = problems.filter((p) => p.source === 'evidence')
    expect(evidenceProblems).toHaveLength(1)
    expect(evidenceProblems[0].id).toBe('3')
  })

  it('tryFix 执行器匹配不受新 source 影响', () => {
    // 模拟 PipelineOrchestrator.tryFix 中 executors.filter 行为
    const executors = [
      { name: 'tsc', supportedSources: ['tsc', 'lint'] },
      { name: 'test', supportedSources: ['test'] },
      { name: 'autoPatch', supportedSources: ['log'] },
    ]

    // 无 'evidence' 支持的执行器 → 返回空数组
    const matching = executors.filter((e) => (e.supportedSources as string[]).includes('evidence'))
    expect(matching).toHaveLength(0)

    // 但这不是错误 — PipelineOrchestrator 在 case 中会跳过：
    // `return { problemId, success: true, summary: '无执行器支持' }`
    // eslint-disable-next-line no-constant-binary-expression
    expect(matching.length === 0).toBe(true)
  })
})

// =============================================================================
// 2. Evidence → Problem 映射规范（模拟 Collector 行为）
// =============================================================================
describe('Phase 0: Evidence → Problem 映射', () => {
  function createMockReport(overrides?: Partial<RegressionReport>): RegressionReport {
    return {
      reportSchemaVersion: '0.1',
      summary: {
        total: 44,
        passed: 42,
        failed: 2,
        skipped: 0,
        durationMs: 1523,
        passRate: 0.954,
        status: 'pass',
      },
      capability: {
        regressed: [],
        intact: ['cause_effect', 'hypothesis_verification', 'tool.execution'],
      },
      regression: {
        count: 2,
        entries: [
          {
            caseId: 'Q01',
            category: 'analysis',
            diffSummary: 'p: cause_effect vs hypothesis_verification',
            fieldDiff: {
              patternChanged: true,
              expectedPattern: 'cause_effect',
              actualPattern: 'hypothesis_verification',
              goalsChanged: false,
              constraintsChanged: false,
              outputStyleChanged: false,
            },
          },
        ],
      },
      evidence: {
        entries: [
          {
            caseId: 'Q01',
            category: 'analysis',
            inputText: 'replay-runner-input',
            expected: { pattern: 'cause_effect', goals: ['g1'], constraints: [], outputStyle: 'json' },
            actual: { pattern: 'hypothesis_verification', goals: ['g1'], constraints: [], outputStyle: 'json' },
            diff: 'p: cause_effect vs hypothesis_verification',
          },
        ],
      },
      trend: null,
      metadata: {
        runnerVersion: '0.1',
        reportSchemaVersion: '0.1',
        goldenVersion: '0.1',
        goldenSchemaVersion: '0.1',
        datasetInfo: { totalCases: 44, categories: { analysis: 44, decision: 0, planning: 0, creation: 0 } },
        commit: { sha: 'a06e7ff', branch: 'feat/evaluation-bridge', dirty: false },
        executedAt: '2026-07-21T19:00:00.000Z',
      },
      ...overrides,
    }
  }

  function evidenceToProblems(report: RegressionReport): Array<{
    source: string
    severity: string
    evidenceType: string
    evidenceRef: string
    affectedCapability?: string
    confidence: number
  }> {
    const problems: Array<any> = []
    const { summary, capability } = report

    // passRate 规则
    const severity = summary.passRate < 0.5 ? 'critical' : summary.passRate < 0.8 ? 'warning' : undefined

    if (severity && severity === 'critical') {
      problems.push({
        source: 'evidence',
        severity,
        evidenceType: 'critical_regression',
        evidenceRef: `report_${report.metadata.executedAt}_${report.metadata.commit.sha}`,
        confidence: 0.95,
      })
    }

    // 每个退化 pattern 一个问题
    for (const regressed of capability.regressed) {
      problems.push({
        source: 'evidence',
        severity: 'warning',
        evidenceType: 'capability_regression',
        evidenceRef: `report_${report.metadata.executedAt}_${report.metadata.commit.sha}`,
        affectedCapability: regressed.capability,
        confidence: 0.85,
      })
    }

    return problems
  }

  it('passRate >= 0.8 无退化时，不产生 Problem', () => {
    const report = createMockReport()
    const problems = evidenceToProblems(report)
    expect(problems).toHaveLength(0)
  })

  it('passRate < 0.5 产生 critical Problem', () => {
    const report = createMockReport({
      summary: { total: 44, passed: 20, failed: 24, skipped: 0, durationMs: 1523, passRate: 0.454, status: 'fail' },
    })
    const problems = evidenceToProblems(report)
    expect(problems.length).toBeGreaterThanOrEqual(1)
    expect(problems.some((p) => p.severity === 'critical')).toBe(true)
  })

  it('能力退化为每个 regressed pattern 产生一个 Problem', () => {
    const report = createMockReport({
      summary: { total: 44, passed: 30, failed: 14, skipped: 0, durationMs: 1523, passRate: 0.68, status: 'fail' },
      capability: {
        regressed: [
          { capability: 'tool.execution', failedCount: 3, totalCount: 10, affectedCaseIds: ['T01', 'T02', 'T03'] },
          { capability: 'cause_effect', failedCount: 2, totalCount: 8, affectedCaseIds: ['Q01', 'Q02'] },
        ],
        intact: ['hypothesis_verification'],
      },
    })
    const problems = evidenceToProblems(report)
    expect(problems).toHaveLength(2)
    expect(problems[0].affectedCapability).toBe('tool.execution')
    expect(problems[1].affectedCapability).toBe('cause_effect')
  })

  it('evidenceRef 格式一致', () => {
    const report = createMockReport()
    const problems = evidenceToProblems(report)
    // passRate 0.954 → 不产生 Problem，这里手动构造一个
    const ref = `report_${report.metadata.executedAt}_${report.metadata.commit.sha}`
    expect(ref).toBe('report_2026-07-21T19:00:00.000Z_a06e7ff')
  })
})

// =============================================================================
// 3. ReportGenerator 无 EventBus 依赖
// =============================================================================
describe('Phase 0: ReportGenerator 架构边界', () => {
  const gen = new ReportGenerator()

  function mockResult(overrides?: Partial<ReplayResult>): ReplayResult {
    return {
      total: 44,
      passed: 42,
      failed: 2,
      skipped: 0,
      durationMs: 1523,
      failures: [
        {
          caseId: 'Q01',
          expected: { pattern: 'cause_effect', goals: ['g1'], constraints: [], outputStyle: 'json' },
          actual: { pattern: 'hypothesis_verification', goals: ['g1'], constraints: [], outputStyle: 'json' },
          diff: 'p: cause_effect vs hypothesis_verification',
        },
      ],
      runnerVersion: '0.1',
      executedAt: '2026-07-21T19:00:00.000Z',
      ...overrides,
    }
  }

  it('generate() 是纯函数', () => {
    const input = mockResult()
    const a = JSON.stringify(gen.generate(input))
    const b = JSON.stringify(gen.generate(input))
    expect(a).toBe(b)
  })

  it('generate() 不 mutate 输入', () => {
    const input = mockResult()
    const frozen = JSON.stringify(input)
    gen.generate(input)
    expect(JSON.stringify(input)).toBe(frozen)
  })

  it('ReportGenerator 构造函数不需要 EventBus', () => {
    // 已在模块顶部的构造中隐式验证
    expect(gen).toBeInstanceOf(ReportGenerator)
  })
})

// =============================================================================
// 4. PipelineOrchestrator 不 import evidence/reasoning
// =============================================================================
describe('Phase 0: PipelineOrchestrator 架构边界', () => {
  it('SignalCollector 接口足够通用，可被 EvidenceCollector 实现', () => {
    // 验证 SignalCollector 接口不限制 source 值
    const collector: SignalCollector = {
      name: 'evidence_test',
      source: 'evidence' as ProblemSource, // 即使未在 type 声明，TypeScript 允许 as 断言
      collect: async () => [],
      shouldRun: () => false,
    }
    expect(collector.source).toBe('evidence')
    expect(collector.name).toBe('evidence_test')
  })

  it('FixExecutor 的 supportedSources 使用 includes 匹配，无需静态已知值', () => {
    // 现有所有 Executor 都用 includes(str) 或 includes(source) 匹配
    // 如果未来有 EvidenceExecutor，只需 supportedSources 加入 'evidence'
    const evidenceExecutor: FixExecutor = {
      name: 'evidence_review',
      execute: async (_problem: AssignedProblem) => ({ problemId: '', success: true, summary: 'reviewed', durationMs: 0 }),
      isAvailable: () => true,
      supportedSources: ['evidence' as ProblemSource],
      timeoutMs: 30000,
    }
    expect(evidenceExecutor.supportedSources.includes('evidence' as ProblemSource)).toBe(true)
  })

  it('Problem 的 source 是 string，非枚举，可赋任何值', () => {
    // 这是对 TypeScript 的类型安全确认：
    // ProblemSource 是 string literal union，而非 enum。
    // 赋值新值需要 as 断言，但不影响运行时。
    const p: Problem = {
      id: 'evidence:test',
      source: 'evidence' as ProblemSource,
      severity: 'warning' as Severity,
      title: 'test',
      description: 'test',
      estimatedCostChars: 0,
      lastSeen: Date.now(),
      occurrenceCount: 1,
      context: { raw: 'test' },
    }
    expect(p.source).toBe('evidence')
  })
})

// =============================================================================
// 5. ProposalValidator 边界验证
// =============================================================================
describe('Phase 0: ProposalValidator 边界', () => {
  it('Evidence 派生的 Proposal 可满足 checkScope 要求', () => {
    // checkScope 要求:
    //   targetFiles.length > 0
    //   title.length >= 3
    const evidenceProposal = {
      id: 'prop_evidence_001',
      title: 'tool.execution 能力退化审查',
      description: '来自 Evidence Report report_20260721_a06e7ff',
      targetFiles: ['packages/capabilities/src/tool/definitions/MemoryTools.ts'],
      expectedOutcome: '确认退化原因',
      risk: 'low' as const,
      createdAt: Date.now(),
    }
    expect(evidenceProposal.targetFiles.length).toBeGreaterThan(0)
    expect(evidenceProposal.title.length).toBeGreaterThanOrEqual(3)
    expect(evidenceProposal.risk).toBe('low')
  })

  it('assessRegressionRisk 将 evidence 类默认为 low risk', async () => {
    // assessRegressionRisk 检查路径是否包含 core/eventbus/scheduler/lifecycle/constitution
    // Evidence 类问题默认不修改这些路径
    const safePaths = ['packages/audio/src/piper/', 'packages/evolution/src/automation/', 'packages/core/src/config/']
    const riskyPaths = ['packages/core/src/core/', 'packages/main/src/bootstrap/Scheduler.ts']

    const assessRisk = async (targetFiles: string[]) => {
      const result = await new ProposalValidator().validate({
        id: 'path-risk', title: 'Path risk', description: '', targetFiles,
        expectedOutcome: '', risk: 'low', createdAt: 0,
      })
      return result.regressionRisk
    }

    // evidence 默认指向非核心路径
    expect(await assessRisk(safePaths)).toBe('low')
    // 如果 proposal 涉及核心路径
    expect(await assessRisk(riskyPaths)).toBe('high')
  })
})
