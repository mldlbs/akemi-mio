import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EvolutionAnalyzer } from '../pipeline/EvolutionAnalyzer'
import { EvolutionStrategizer } from '../pipeline/EvolutionStrategizer'
import { EvolutionExecutor } from '../pipeline/EvolutionExecutor'
import { EvolutionReviewer } from '../pipeline/EvolutionReviewer'
import { ResponseValidator } from '../ResponseValidator'
import { eventBus } from '../../core/EventBus'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../logger/Logger', () => ({ log: vi.fn() }))

function resetEvents() {
  eventBus.removeAll()
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'evolution-pipeline-integration-'))
}

describe('Evolution Pipeline 集成测试', () => {
  let tempDir: string
  let agentService: any
  let planManager: any
  let verificationRunner: any
  let regressionDetector: any

  beforeEach(() => {
    resetEvents()
    tempDir = makeTempDir()
    agentService = { runSelfTask: vi.fn().mockResolvedValue({ success: true, summary: '分析完成' }), isBusy: vi.fn(() => false), abortSelfTask: vi.fn() }
    planManager = { getActivePlan: vi.fn().mockReturnValue(null), listPlans: vi.fn().mockReturnValue([]), getFormattedContext: vi.fn(() => ''), updateStep: vi.fn(), completePlan: vi.fn(), abandonPlan: vi.fn() }
    verificationRunner = { verify: vi.fn().mockResolvedValue({ passed: true }) }
    regressionDetector = { snapshot: vi.fn().mockResolvedValue({}), detectRegression: vi.fn().mockResolvedValue({ hasRegression: false }) }
  })

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true }) } catch { }
    resetEvents()
  })

  async function runPipeline() {
    const analyzer = new EvolutionAnalyzer(agentService, planManager, { historyPath: join(tempDir, 'history.json'), analysisTimeoutMs: 60000 })
    const strategizer = new EvolutionStrategizer()
    const executor = new EvolutionExecutor(agentService, planManager)
    const responseValidator = new ResponseValidator(eventBus)
    const reviewer = new EvolutionReviewer(responseValidator)
    reviewer.setVerificationRunner(verificationRunner)
    reviewer.setRegressionDetector(regressionDetector)

    await analyzer.init()
    const analysisResult = await analyzer.analyze({ mode: 'first_run', planContext: '', historySummary: '', safetyMode: 'auto', livingPlanCtx: '', cognitiveCtx: '', strategyCtx: '', promptMode: 'full' })
    const strategy = strategizer.select({ consecutiveFailures: 0, isFirstRun: true, isRecovering: false, hoursSinceLastRun: 0, isDegenerate: false })
    reviewer.startListen()
    const executionResult = await executor.executeNextStep({ planId: '', stepIndex: 0, stepDescription: '步骤', planCtx: '', cognitiveCtx: '' })
    const reviewResult = await reviewer.review({ changedFiles: { newFiles: [], modifiedFiles: [] }, mode: 'analyze' })

    return { analysisResult, strategyName: strategy.name, executionResult, reviewResult }
  }

  it('完整流水线 Analyzer→Strategizer→Executor→Reviewer', async () => {
    const r = await runPipeline()
    expect(r.analysisResult.success).toBe(true)
    expect(r.strategyName).toBeDefined()
    expect(r.executionResult).toBeDefined()
    expect(r.reviewResult).toBeDefined()
  })

  it('verify 失败 → review.passed=false', async () => {
    verificationRunner.verify = vi.fn().mockResolvedValue({ passed: false })
    const r = await runPipeline()
    expect(r.reviewResult.passed).toBe(false)
  })

  it('无计划时执行器跳过', async () => {
    planManager.getActivePlan = vi.fn().mockReturnValue(null)
    planManager.listPlans = vi.fn().mockReturnValue([])
    const r = await runPipeline()
    expect(r.executionResult.success).toBe(false)
  })
})
