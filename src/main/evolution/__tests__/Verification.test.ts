import { describe, it, expect, vi, beforeEach } from 'vitest'
import { VerificationRunner } from '../VerificationRunner'
import { ProposalValidator } from '../ProposalValidator'
import { RegressionDetector } from '../RegressionDetector'

describe('VerificationRunner', () => {
  it('should create with default config', () => {
    const runner = new VerificationRunner()
    expect(runner).toBeDefined()
  })

  it('should create with custom config', () => {
    const runner = new VerificationRunner({ compileCheck: false, testRun: false, lintCheck: false, timeout: 5000 })
    expect(runner).toBeDefined()
  })

  it('should handle empty file list gracefully', async () => {
    const runner = new VerificationRunner({ compileCheck: false, testRun: false, lintCheck: false, timeout: 5000 })
    const result = await runner.verify([])
    expect(result.passed).toBe(true)
    expect(result.affectedFiles).toEqual([])
  })
})

describe('ProposalValidator', () => {
  const validProposal = {
    id: 'prop_test_1',
    title: '优化 Recall 策略',
    description: '提高记忆召回准确率',
    targetFiles: ['src/main/memory/RecallStrategy.ts'],
    expectedOutcome: 'Recall 准确率提升 10%',
    risk: 'low' as const,
    createdAt: Date.now(),
  }

  it('should accept valid proposal', async () => {
    const validator = new ProposalValidator()
    const result = await validator.validate(validProposal)
    expect(result.passed).toBe(true)
  })

  it('should reject proposal with empty target files', async () => {
    const validator = new ProposalValidator()
    const result = await validator.validate({ ...validProposal, targetFiles: [] })
    expect(result.passed).toBe(false)
    expect(result.scopeCheck.message).toContain('未指定目标文件')
  })

  it('should reject proposal with short title', async () => {
    const validator = new ProposalValidator()
    const result = await validator.validate({ ...validProposal, title: 'ab' })
    expect(result.passed).toBe(false)
    expect(result.scopeCheck.message).toContain('标题过短')
  })

  it('should detect high regression risk for core files', async () => {
    const validator = new ProposalValidator()
    const result = await validator.validate({
      ...validProposal,
      targetFiles: ['src/main/core/EventBus.ts', 'src/main/core/Scheduler.ts'],
    })
    expect(result.regressionRisk).toBe('high')
  })

  it('should detect medium regression risk for single core file', async () => {
    const validator = new ProposalValidator()
    const result = await validator.validate({
      ...validProposal,
      targetFiles: ['src/main/core/EventBus.ts'],
    })
    expect(result.regressionRisk).toBe('medium')
  })
})

describe('RegressionDetector', () => {
  let detector: RegressionDetector

  beforeEach(() => {
    detector = new RegressionDetector()
  })

  it('should detect no regression when metrics are identical', async () => {
    const before = { testPassRate: 1, compileErrors: 0, timestamp: Date.now() }
    const after = { testPassRate: 1, compileErrors: 0, timestamp: Date.now() }
    const report = await detector.detectRegression(before, after, { newFiles: [], modifiedFiles: [] })
    expect(report.hasRegression).toBe(false)
  })

  it('should detect regression when compile errors increase', async () => {
    const before = { testPassRate: 1, compileErrors: 0, timestamp: Date.now() }
    const after = { testPassRate: 1, compileErrors: 5, timestamp: Date.now() }
    const report = await detector.detectRegression(before, after, { newFiles: [], modifiedFiles: ['src/main/core/test.ts'] })
    expect(report.hasRegression).toBe(true)
    expect(report.changes.compileErrors.delta).toBe(5)
  })

  it('should handle empty changed files', async () => {
    const before = { testPassRate: 1, compileErrors: 0, timestamp: Date.now() }
    const after = { testPassRate: 0.5, compileErrors: 3, timestamp: Date.now() }
    const report = await detector.detectRegression(before, after, { newFiles: [], modifiedFiles: [] })
    expect(report.hasRegression).toBe(true)
    expect(report.newFiles).toEqual([])
  })
})
