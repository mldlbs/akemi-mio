import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EvolutionReviewer } from '../pipeline/EvolutionReviewer'
import { eventBus } from '../../core/EventBus'

vi.mock('../../logger/Logger', () => ({ log: vi.fn() }))

function resetEvents() {
  eventBus.removeAll()
}

describe('EvolutionReviewer', () => {
  let reviewer: EvolutionReviewer
  let responseValidator: any

  beforeEach(() => {
    resetEvents()
    responseValidator = {
      startListening: vi.fn(),
      stopAndValidate: vi
        .fn()
        .mockReturnValue({
          passed: true,
          violations: [],
          warnings: [],
          stats: { total: 0, readOnly: 0, write: 0, errors: 0 },
          validationSummary: '',
        }),
      reset: vi.fn(),
      getSnapshot: vi.fn().mockReturnValue([]),
      cleanup: vi.fn(),
    }
    reviewer = new EvolutionReviewer(responseValidator)
  })

  afterEach(async () => {
    await reviewer.destroy().catch(() => {})
  })

  it('init 状态转换', async () => {
    expect((reviewer as any).state).toBe('created')
    await reviewer.init()
    expect((reviewer as any).state).toBe('ready')
  })

  it('startListen 调用 validator', () => {
    reviewer.startListen()
    expect(responseValidator.startListening).toHaveBeenCalled()
  })

  it('stopAndValidate 返回结果', () => {
    reviewer.startListen()
    const result = reviewer.stopAndValidate('analyze')
    expect(result.passed).toBe(true)
  })

  it('stopAndValidate 失败设置 summary', () => {
    responseValidator.stopAndValidate = vi
      .fn()
      .mockReturnValue({
        passed: false,
        violations: [{ type: 'forbidden_tool', severity: 'error', message: '违规' }],
        warnings: [],
        stats: { total: 1, readOnly: 0, write: 1, errors: 0 },
        validationSummary: '违规',
      })
    reviewer.startListen()
    expect(reviewer.stopAndValidate('analyze').passed).toBe(false)
  })

  it('verify 返回 { passed }', async () => {
    const r = await reviewer.verify({ newFiles: [], modifiedFiles: [] })
    expect(typeof r.passed).toBe('boolean')
  })

  it('detectRegression 返回 { hasRegression }', async () => {
    const r = await reviewer.detectRegression({ newFiles: [], modifiedFiles: [] })
    expect(typeof r.hasRegression).toBe('boolean')
  })

  it('review 整合验证+回归', async () => {
    reviewer.startListen()
    const r = await reviewer.review({ changedFiles: { newFiles: [], modifiedFiles: [] }, mode: 'analyze' })
    expect('passed' in r).toBe(true)
  })

  it('getLastValidationSummary 空', () => {
    expect(reviewer.getLastValidationSummary()).toBe('')
  })

  it('setVerificationRunner 不抛出', () => {
    reviewer.setVerificationRunner(null)
    expect(true).toBe(true)
  })
})
